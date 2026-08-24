import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { chmod, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";
import { spawnSync } from "node:child_process";
import { Pool } from "pg";

import { migrateEmbeddedInstance, readMigrationKeys } from "../src/embedded-instance-migration.js";
import { EmbeddedInstanceStore } from "../src/embedded-instance-store.js";
import { createAuthenticationSecretCodec } from "../src/authentication-secrets.js";

const key = () => randomBytes(32).toString("base64");

describe("embedded-to-PostgreSQL migration key preflight", () => {
  test("reads preserve keys only from owner-private files", async () => {
    const root = await mkdtemp(join(tmpdir(), "stash-preserve-key-"));
    const source = join(root, "source.key"); await writeFile(source, `${key()}\n`, { mode: 0o600 });
    const keys = await readMigrationKeys({ mode: "preserve", sourceKeyFile: source });
    assert.equal(keys.source, keys.destination);
    await chmod(source, 0o644);
    await assert.rejects(() => readMigrationKeys({ mode: "preserve", sourceKeyFile: source }), /owner-only permissions/i);
  });

  test("rotate requires distinct source and destination key files", async () => {
    const root = await mkdtemp(join(tmpdir(), "stash-rotate-key-"));
    const source = join(root, "source.key"); const destination = join(root, "destination.key"); const shared = key();
    await writeFile(source, shared, { mode: 0o600 }); await writeFile(destination, shared, { mode: 0o600 });
    await assert.rejects(() => readMigrationKeys({ mode: "rotate", sourceKeyFile: source }), /destination key file/i);
    await assert.rejects(() => readMigrationKeys({ mode: "rotate", sourceKeyFile: source, destinationKeyFile: destination }), /must be different/i);
    await writeFile(destination, key(), { mode: 0o600 });
    const keys = await readMigrationKeys({ mode: "rotate", sourceKeyFile: source, destinationKeyFile: destination });
    assert.notEqual(keys.source, keys.destination);
  });

  test("rejects secret-bearing command-line arguments without echoing them", () => {
    const secret = key(); const result = spawnSync(process.execPath, ["--import", "tsx", "src/migrate-embedded-command.ts", "--source-key", secret], { cwd: process.cwd(), encoding: "utf8" });
    assert.notEqual(result.status, 0); assert.match(result.stderr, /protected key files/i); assert.doesNotMatch(result.stderr, new RegExp(secret.replace(/[+/=]/g, "\\$&")));
  });
});

const postgresUrl = process.env.STASH_TEST_DATABASE_URL;
describe("embedded-to-external PostgreSQL migration", { skip: postgresUrl ? false : "STASH_TEST_DATABASE_URL is not configured" }, () => {
  test("preserves a complete prepared store and rotates protected authentication state", async () => {
    const sourceRoot = await mkdtemp(join(tmpdir(), "stash-migration-source-")); const sourceKey = key(); const destinationKey = key();
    const source = await EmbeddedInstanceStore.open(sourceRoot, createAuthenticationSecretCodec(sourceKey));
    const admin = new Pool({ connectionString: postgresUrl! }); const schema = `embedded_migration_${randomUUID().replaceAll("-", "")}`;
    const attachmentRoot = await mkdtemp(join(tmpdir(), "stash-migration-attachments-parent-")); const destinationAttachments = join(attachmentRoot, "attachments");
    try {
      await source.database.verifyConnection(); await source.database.prepareInstanceStore();
      const organizationId = randomUUID(); const ownerId = randomUUID();
      await source.database.createFirstOrganizationOwner({ organizationId, organizationName: "Migrated", ownerId, ownerName: "Ada", ownerEmail: "ada@example.test", passwordHash: "hash", role: "Owner" });
      const recoveryToken = "migration-recovery-token-with-enough-entropy"; const jobId = randomUUID(); const claimOwner = randomUUID();
      await source.database.enqueueEmailRecovery({ id: jobId, protectedDelivery: createAuthenticationSecretCodec(sourceKey).encrypt("delivery"), createdAt: "2026-08-24T10:00:00.000Z" });
      const claim = await source.database.claimEmailRecoveryDelivery(claimOwner, "2026-08-24T10:10:00.000Z");
      await source.database.completeEmailRecoveryDelivery(claim!.claim, { accountId: ownerId, tokenLookup: recoveryToken,
        protectedSecret: createAuthenticationSecretCodec(sourceKey).encrypt(recoveryToken), expiresAt: "2030-08-24T10:00:00.000Z" });
      await admin.query(`CREATE SCHEMA ${schema}`); const separator = postgresUrl!.includes("?") ? "&" : "?";
      const scoped = `${postgresUrl}${separator}options=-csearch_path%3D${schema}`;
      const result = await migrateEmbeddedInstance({ source, destinationDatabaseUrl: scoped, destinationAttachmentRoot: destinationAttachments,
        keys: { source: sourceKey, destination: destinationKey, mode: "rotate" } });
      assert.ok(result.tables > 20); assert.ok(result.rows > 2);
      const migrated = new (await import("../src/postgres-database.js")).PostgresDatabase(scoped, createAuthenticationSecretCodec(destinationKey));
      try { await migrated.verifyConnection(); assert.equal((await migrated.findAccountByEmail("ada@example.test"))?.passwordHash, "hash");
        assert.equal(await migrated.findEmailRecoveryAccount(recoveryToken, "2026-08-24T10:00:00.000Z"), ownerId); }
      finally { await migrated.close(); }
    } finally { await source.close(); await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`).catch(() => undefined); await admin.end(); }
  });

  test("preserve mode keeps authentication usable with the source key", async () => {
    const sourceRoot = await mkdtemp(join(tmpdir(), "stash-migration-preserve-")); const sourceKey = key();
    const source = await EmbeddedInstanceStore.open(sourceRoot, createAuthenticationSecretCodec(sourceKey)); const admin = new Pool({ connectionString: postgresUrl! });
    const schema = `embedded_preserve_${randomUUID().replaceAll("-", "")}`; const destinationAttachments = join(await mkdtemp(join(tmpdir(), "stash-preserve-attachments-")), "attachments");
    try {
      await source.database.verifyConnection(); await source.database.prepareInstanceStore(); const organizationId = randomUUID(); const ownerId = randomUUID();
      await source.database.createFirstOrganizationOwner({ organizationId, organizationName: "Preserved", ownerId, ownerName: "Grace", ownerEmail: "grace@example.test", passwordHash: "preserved-hash", role: "Owner" });
      await admin.query(`CREATE SCHEMA ${schema}`); const separator = postgresUrl!.includes("?") ? "&" : "?"; const scoped = `${postgresUrl}${separator}options=-csearch_path%3D${schema}`;
      await migrateEmbeddedInstance({ source, destinationDatabaseUrl: scoped, destinationAttachmentRoot: destinationAttachments,
        keys: { source: sourceKey, destination: sourceKey, mode: "preserve" } });
      const migrated = new (await import("../src/postgres-database.js")).PostgresDatabase(scoped, createAuthenticationSecretCodec(sourceKey));
      try { await migrated.verifyConnection(); assert.equal((await migrated.findAccountByEmail("grace@example.test"))?.passwordHash, "preserved-hash"); }
      finally { await migrated.close(); }
    } finally { await source.close(); await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`).catch(() => undefined); await admin.end(); }
  });
});
