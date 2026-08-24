import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { chmod, cp, mkdir, mkdtemp, opendir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, test } from "node:test";
import { spawnSync } from "node:child_process";
import { Pool } from "pg";

import { AttachmentService, LocalAttachmentStorage } from "../src/attachments.js";
import { migrateEmbeddedInstance, readMigrationKeys } from "../src/embedded-instance-migration.js";
import { EmbeddedInstanceStore } from "../src/embedded-instance-store.js";
import { createAuthenticationSecretCodec } from "../src/authentication-secrets.js";
import { deriveEmailRecoveryLookup } from "../src/account-recovery.js";
import { InvitationService } from "../src/invitations.js";
import { PasswordAuthService, hashPassword } from "../src/password-auth.js";
import { paragraphDocument } from "../src/rich-text.js";
import { PortableWorkspaceExportService } from "../src/portable-workspace-export.js";
import { PortableWorkspaceImportService } from "../src/portable-workspace-import.js";
import { PostgresInstanceUpgradeTarget } from "../src/postgres-instance-upgrade.js";

const key = () => randomBytes(32).toString("base64");
const recoveryCodeLookup = (code: string) => createHash("sha256").update(`stash:recovery-code:v1\0${code}`).digest("base64");
const exists = (path: string) => stat(path).then(() => true).catch(() => false);
function canonicalMigrationValue(value: unknown): unknown {
  if (value instanceof Date) return value.toISOString();
  if (value instanceof Uint8Array) return { bytes: Buffer.from(value).toString("base64") };
  if (Array.isArray(value)) return value.map(canonicalMigrationValue);
  if (value !== null && typeof value === "object") return Object.fromEntries(Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right)).map(([name, nested]) => [name, canonicalMigrationValue(nested)]));
  if (typeof value === "bigint") return value.toString();
  return value;
}
function migrationDigest(rows: Array<Record<string, unknown>>, columns: Array<{ column_name: string; data_type: string }>): string {
  const normalized = rows.map((row) => Object.fromEntries(columns.map(({ column_name: name, data_type: type }) =>
    [name, type === "bigint" || type === "numeric" || type === "decimal" ? String(row[name]) : row[name]])));
  const canonical = normalized.map((row) => JSON.stringify(canonicalMigrationValue(row))).sort();
  return createHash("sha256").update(JSON.stringify(canonical)).digest("hex");
}
async function assertDirectoryExcludesSecrets(root: string, secrets: string[]): Promise<void> {
  const walk = async (directory: string): Promise<void> => {
    try {
      for await (const entry of await opendir(directory)) {
        const path = join(directory, entry.name); if (entry.isDirectory()) await walk(path);
        else if (entry.isFile()) { const bytes = await readFile(path); for (const secret of secrets) assert.equal(bytes.includes(Buffer.from(secret)), false, path); }
      }
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  };
  await walk(root);
}

describe("embedded-to-PostgreSQL migration key preflight", () => {
  test("reads preserve keys only from owner-private files", async () => {
    const root = await mkdtemp(join(tmpdir(), "stash-preserve-key-"));
    const source = join(root, "source.key"); await writeFile(source, `${key()}\n`, { mode: 0o600 });
    const keys = await readMigrationKeys({ mode: "preserve", sourceKeyFile: source });
    assert.equal(keys.source, keys.destination);
    await chmod(source, 0o644);
    await assert.rejects(() => readMigrationKeys({ mode: "preserve", sourceKeyFile: source }), /owner-only permissions/i);
  });

  test("rejects a destination key file in preserve mode instead of silently ignoring it", async () => {
    const root = await mkdtemp(join(tmpdir(), "stash-preserve-extra-key-")); const source = join(root, "source.key");
    const destination = join(root, "destination.key"); await writeFile(source, key(), { mode: 0o600 }); await writeFile(destination, key(), { mode: 0o600 });
    await assert.rejects(() => readMigrationKeys({ mode: "preserve", sourceKeyFile: source, destinationKeyFile: destination }), /preserve.*destination key/i);
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
  test("rejects an unconfigured destination instead of defining its master-key identity from migration input", async () => {
    const sourceKey = key(); const source = await EmbeddedInstanceStore.open(await mkdtemp(join(tmpdir(), "stash-migration-unconfigured-")), createAuthenticationSecretCodec(sourceKey));
    const admin = new Pool({ connectionString: postgresUrl! }); const schema = `embedded_unconfigured_${randomUUID().replaceAll("-", "")}`;
    try {
      await source.database.verifyConnection(); await source.database.prepareInstanceStore(); await admin.query(`CREATE SCHEMA ${schema}`);
      const separator = postgresUrl!.includes("?") ? "&" : "?"; const scoped = `${postgresUrl}${separator}options=-csearch_path%3D${schema}`;
      await assert.rejects(migrateEmbeddedInstance({ source, destinationDatabaseUrl: scoped,
        destinationAttachmentRoot: join(await mkdtemp(join(tmpdir(), "stash-unconfigured-attachments-")), "attachments"),
        destinationConfigurationRoot: join(await mkdtemp(join(tmpdir(), "stash-unconfigured-config-")), "config"),
        destinationDatabaseAvailableBytes: BigInt(Number.MAX_SAFE_INTEGER),
        keys: { source: sourceKey, destination: sourceKey, mode: "preserve" } }), /prepared with its configured master key/i);
    } finally { await source.close(); await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`).catch(() => undefined); await admin.end(); }
  });

  test("rejects a destination Instance configured with a different master key", async () => {
    const sourceKey = key(); const configuredDestinationKey = key(); const suppliedDestinationKey = key();
    const source = await EmbeddedInstanceStore.open(await mkdtemp(join(tmpdir(), "stash-migration-key-boundary-")), createAuthenticationSecretCodec(sourceKey));
    const admin = new Pool({ connectionString: postgresUrl! }); const schema = `embedded_key_boundary_${randomUUID().replaceAll("-", "")}`;
    const attachments = join(await mkdtemp(join(tmpdir(), "stash-key-boundary-attachments-")), "attachments");
    try {
      await source.database.verifyConnection(); await source.database.prepareInstanceStore(); await source.database.createFirstOrganizationOwner({ organizationId: randomUUID(), organizationName: "Source",
        ownerId: randomUUID(), ownerName: "Source Owner", ownerEmail: "source@example.test", passwordHash: "hash", role: "Owner" });
      await admin.query(`CREATE SCHEMA ${schema}`);
      const separator = postgresUrl!.includes("?") ? "&" : "?"; const scoped = `${postgresUrl}${separator}options=-csearch_path%3D${schema}`;
      const configured = new (await import("../src/postgres-database.js")).PostgresDatabase(scoped, createAuthenticationSecretCodec(configuredDestinationKey));
      await configured.verifyConnection(); await configured.prepareInstanceStore(); await configured.createFirstOrganizationOwner({ organizationId: randomUUID(), organizationName: "Destination",
        ownerId: randomUUID(), ownerName: "Destination Owner", ownerEmail: "destination@example.test", passwordHash: "hash", role: "Owner" }); await configured.close();
      await assert.rejects(migrateEmbeddedInstance({ source, destinationDatabaseUrl: scoped, destinationAttachmentRoot: attachments,
        destinationConfigurationRoot: join(dirname(attachments), "config"),
        destinationDatabaseAvailableBytes: BigInt(Number.MAX_SAFE_INTEGER),
        keys: { source: sourceKey, destination: suppliedDestinationKey, mode: "rotate" } }), /destination Instance master key/i);
    } finally { await source.close(); await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`).catch(() => undefined); await admin.end(); }
  });

  test("preserves a complete prepared store and rotates protected authentication state", async () => {
    const sourceRoot = await mkdtemp(join(tmpdir(), "stash-migration-source-")); const sourceKey = key(); const destinationKey = key();
    const source = await EmbeddedInstanceStore.open(sourceRoot, createAuthenticationSecretCodec(sourceKey));
    const admin = new Pool({ connectionString: postgresUrl! }); const schema = `embedded_migration_${randomUUID().replaceAll("-", "")}`;
    const attachmentRoot = await mkdtemp(join(tmpdir(), "stash-migration-attachments-parent-")); const destinationAttachments = join(attachmentRoot, "attachments");
    const destinationConfiguration = join(attachmentRoot, "config");
    try {
      await source.database.verifyConnection(); await source.database.prepareInstanceStore();
      const organizationId = randomUUID(); const ownerId = randomUUID(); const adminId = randomUUID(); const memberId = randomUUID();
      const password = "migration-password-long-enough"; const passwordHash = await hashPassword(password);
      await source.database.createFirstOrganizationOwner({ organizationId, organizationName: "Migrated", ownerId, ownerName: "Ada", ownerEmail: "ada@example.test", passwordHash, role: "Owner" });
      for (const [id, name, email] of [[adminId, "Admin", "admin@example.test"], [memberId, "Member", "member@example.test"]] as const) {
        await source.database.createAccountWithPersonalWorkspaceAndSession({ account: { id, name, email, passwordHash },
          workspace: { id: randomUUID(), name: `${name} Workspace` }, session: { id: randomUUID(), accountId: id,
            tokenHash: `${name}-migration-session`, createdAt: "2026-08-24T09:00:00.000Z", lastSeenAt: "2026-08-24T09:00:00.000Z" } });
      }
      const invitations = new InvitationService(source.database);
      for (const [id, role] of [[adminId, "Admin"], [memberId, "Member"]] as const) {
        const invitation = await invitations.create(organizationId, ownerId, { kind: "member", role }); assert.equal(invitation.status, "created");
        if (invitation.status === "created") assert.equal((await invitations.accept(id, { token: invitation.token }) as { status: string }).status, "accepted");
      }
      await source.database.saveOidcConfiguration({ organizationId, issuer: "https://identity.example.test", clientId: "stash-migration", clientSecret: "oidc-secret" });
      assert.equal(await source.database.linkOidcIdentity({ organizationId, issuer: "https://identity.example.test", subject: "ada-subject" }, ownerId), true);
      const importedWorkspaceId = randomUUID(); const importedNoteId = randomUUID(); const importedAccountId = randomUUID(); const importId = randomUUID();
      const importedActor = { localAccountId: importedAccountId, displayName: "Imported Author" };
      const portable = await new PortableWorkspaceExportService({ async readExportSnapshot() { return { status: "found" as const, snapshot: {
        workspace: { schema: "stash.workspace.v1" as const, id: importedWorkspaceId, name: "Imported Workspace",
          owner: { type: "personal" as const, identity: importedActor }, createdBy: importedActor },
        notes: [{ schema: "stash.note.v1" as const, id: importedNoteId, workspaceId: importedWorkspaceId, content: "Imported identity",
          tags: [], createdAt: "2026-08-24T09:20:00.000Z", createdBy: importedActor }], tasks: [], boards: [], attachments: [],
        noteLocations: [{ schema: "stash.note-location.v1" as const, noteId: importedNoteId, workspaceId: importedWorkspaceId,
          path: `notes/${importedNoteId}.md`, aliases: [], revision: 1 }], noteLinks: [], activities: [], noteHistory: [], durableObjects: [],
      } }; } }).export(ownerId, importedWorkspaceId);
      assert.equal(portable.status, "exported"); if (portable.status !== "exported") throw new Error("portable export failed");
      for (const secret of [sourceKey, destinationKey]) assert.equal(Buffer.from(portable.archive).includes(Buffer.from(secret)), false);
      assert.equal((await new PortableWorkspaceImportService(source.database, new LocalAttachmentStorage(source.paths.attachments))
        .import(importId, ownerId, portable.archive)).status, "imported");
      assert.equal((await source.database.listPendingImportedIdentities(ownerId))[0]?.sourceAccountId, importedAccountId);
      const workspaceId = randomUUID(); const noteId = randomUUID();
      await source.database.createWorkspace({ id: workspaceId, name: "Migrated Workspace", owner: { type: "organization", id: organizationId }, createdByMemberId: ownerId },
        { localAccountId: ownerId, displayName: "Ada" });
      const document = paragraphDocument("Migrated history", randomUUID());
      await source.database.createNote(ownerId, { id: noteId, workspaceId, content: "Migrated history", document, revision: 1,
        tags: ["migration"], createdByMemberId: ownerId, createdAt: "2026-08-24T09:30:00.000Z" }, { schema: "stash.note.v1", id: noteId,
        workspaceId, content: "Migrated history", tags: ["migration"], createdAt: "2026-08-24T09:30:00.000Z", createdBy: { localAccountId: ownerId, displayName: "Ada" } });
      const attachmentBytes = Buffer.from([0, 1, 2, 253, 254, 255]);
      const attachment = await new AttachmentService(source.database, new LocalAttachmentStorage(source.paths.attachments)).create(ownerId, workspaceId,
        { filename: "migration.bin", contentType: "application/octet-stream", source: "upload", content: attachmentBytes });
      assert.equal(attachment.status, "created");
      await writeFile(join(source.paths.configuration, "runtime.json"), `${JSON.stringify({ publicOrigin: "https://stash.example.test", registration: false })}\n`, { mode: 0o600 });
      const recoveryToken = "migration-recovery-token-with-enough-entropy"; const recoveryCode = "01234567-89abcdef"; const jobId = randomUUID(); const claimOwner = randomUUID();
      await source.database.replaceRecoveryCodes(ownerId, [{ accountId: ownerId, lookup: recoveryCodeLookup(recoveryCode),
        protectedSecret: createAuthenticationSecretCodec(sourceKey).encrypt(recoveryCode) }]);
      await source.database.enqueueEmailRecovery({ id: jobId, protectedDelivery: createAuthenticationSecretCodec(sourceKey).encrypt("delivery"), createdAt: "2026-08-24T10:00:00.000Z" });
      const claim = await source.database.claimEmailRecoveryDelivery(claimOwner, "2026-08-24T10:10:00.000Z");
      await source.database.completeEmailRecoveryDelivery(claim!.claim, { accountId: ownerId, tokenLookup: deriveEmailRecoveryLookup(recoveryToken),
        protectedSecret: createAuthenticationSecretCodec(sourceKey).encrypt(recoveryToken), expiresAt: "2030-08-24T10:00:00.000Z" });
      await mkdir(destinationAttachments, { recursive: true });
      await admin.query(`CREATE SCHEMA ${schema}`); const separator = postgresUrl!.includes("?") ? "&" : "?";
      const scoped = `${postgresUrl}${separator}options=-csearch_path%3D${schema}`;
      const configured = new (await import("../src/postgres-database.js")).PostgresDatabase(scoped, createAuthenticationSecretCodec(destinationKey));
      await configured.verifyConnection(); await configured.prepareInstanceStore(); await configured.close();
      const result = await migrateEmbeddedInstance({ source, destinationDatabaseUrl: scoped, destinationAttachmentRoot: destinationAttachments,
        destinationConfigurationRoot: destinationConfiguration,
        destinationDatabaseAvailableBytes: BigInt(Number.MAX_SAFE_INTEGER),
        keys: { source: sourceKey, destination: destinationKey, mode: "rotate" } });
      assert.ok(result.tables > 20); assert.ok(result.rows > 2);
      await assertDirectoryExcludesSecrets(attachmentRoot, [sourceKey, destinationKey]);
      for (const secret of [sourceKey, destinationKey]) assert.equal(JSON.stringify(result).includes(secret), false);
      const migrated = new (await import("../src/postgres-database.js")).PostgresDatabase(scoped, createAuthenticationSecretCodec(destinationKey));
      try { await migrated.verifyConnection();
        for (const [email, id, role] of [["ada@example.test", ownerId, "Owner"], ["admin@example.test", adminId, "Admin"], ["member@example.test", memberId, "Member"]] as const) {
          assert.equal((await new PasswordAuthService(migrated).signIn({ email, password })).member.id, id);
          assert.equal(await migrated.organizationRole(organizationId, id), role);
        }
        assert.deepEqual(await migrated.findOidcConfiguration(organizationId), { organizationId, issuer: "https://identity.example.test", clientId: "stash-migration", clientSecret: "oidc-secret" });
        assert.equal((await migrated.findOidcIdentity({ organizationId, issuer: "https://identity.example.test", subject: "ada-subject" }))?.accountId, ownerId);
        const pendingImported = await migrated.listPendingImportedIdentities(ownerId);
        assert.equal(pendingImported.some((identity) => identity.importId === importId && identity.sourceAccountId === importedAccountId), true);
        assert.equal((await migrated.listNoteHistory(ownerId, noteId)).status, "found"); assert.equal((await migrated.listWorkspaceActivity(ownerId, workspaceId)).status, "found");
        if (attachment.status === "created") assert.deepEqual((await new AttachmentService(migrated, new LocalAttachmentStorage(destinationAttachments))
          .get(ownerId, attachment.record.id))?.content, attachmentBytes);
        assert.deepEqual(JSON.parse(await readFile(join(destinationConfiguration, "runtime.json"), "utf8")), { publicOrigin: "https://stash.example.test", registration: false });
        assert.equal(await migrated.findEmailRecoveryAccount(deriveEmailRecoveryLookup(recoveryToken), "2026-08-24T10:00:00.000Z"), ownerId);
        const lookupRows = await admin.query(`SELECT code_lookup FROM ${schema}.stash_recovery_codes WHERE account_id=$1`, [ownerId]);
        assert.equal(lookupRows.rows[0]?.code_lookup, createAuthenticationSecretCodec(destinationKey).blindIndex(recoveryCodeLookup(recoveryCode))); }
      finally { await migrated.close(); }
    } finally { await source.close(); await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`).catch(() => undefined); await admin.end(); }
  });

  test("preserve mode keeps authentication usable with the source key", async () => {
    const sourceRoot = await mkdtemp(join(tmpdir(), "stash-migration-preserve-")); const sourceKey = key();
    const source = await EmbeddedInstanceStore.open(sourceRoot, createAuthenticationSecretCodec(sourceKey)); const admin = new Pool({ connectionString: postgresUrl! });
    const schema = `embedded_preserve_${randomUUID().replaceAll("-", "")}`; const destinationRoot = await mkdtemp(join(tmpdir(), "stash-preserve-attachments-"));
    const destinationAttachments = join(destinationRoot, "attachments"); const destinationConfiguration = join(destinationRoot, "config");
    try {
      await source.database.verifyConnection(); await source.database.prepareInstanceStore(); const organizationId = randomUUID(); const ownerId = randomUUID();
      await source.database.createFirstOrganizationOwner({ organizationId, organizationName: "Preserved", ownerId, ownerName: "Grace", ownerEmail: "grace@example.test", passwordHash: "preserved-hash", role: "Owner" });
      await mkdir(destinationAttachments, { recursive: true });
      await admin.query(`CREATE SCHEMA ${schema}`); const separator = postgresUrl!.includes("?") ? "&" : "?"; const scoped = `${postgresUrl}${separator}options=-csearch_path%3D${schema}`;
      const configured = new (await import("../src/postgres-database.js")).PostgresDatabase(scoped, createAuthenticationSecretCodec(sourceKey));
      await configured.verifyConnection(); await configured.prepareInstanceStore(); await configured.close();
      await assert.rejects(migrateEmbeddedInstance({ source, destinationDatabaseUrl: scoped, destinationAttachmentRoot: destinationAttachments,
        destinationConfigurationRoot: destinationConfiguration,
        destinationDatabaseAvailableBytes: 0n, keys: { source: sourceKey, destination: sourceKey, mode: "preserve" } }), /PostgreSQL capacity is insufficient/i);
      const result = await migrateEmbeddedInstance({ source, destinationDatabaseUrl: scoped, destinationAttachmentRoot: destinationAttachments,
        destinationConfigurationRoot: destinationConfiguration,
        destinationDatabaseAvailableBytes: BigInt(Number.MAX_SAFE_INTEGER),
        keys: { source: sourceKey, destination: sourceKey, mode: "preserve" } });
      await assertDirectoryExcludesSecrets(destinationRoot, [sourceKey]); assert.equal(JSON.stringify(result).includes(sourceKey), false);
      const migrated = new (await import("../src/postgres-database.js")).PostgresDatabase(scoped, createAuthenticationSecretCodec(sourceKey));
      try { await migrated.verifyConnection(); assert.equal((await migrated.findAccountByEmail("grace@example.test"))?.passwordHash, "preserved-hash"); }
      finally { await migrated.close(); }
    } finally { await source.close(); await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`).catch(() => undefined); await admin.end(); }
  });

  test("rolls back a deterministic pre-commit failure without mutating files and reruns safely", async () => {
    const sourceKey = key(); const source = await EmbeddedInstanceStore.open(await mkdtemp(join(tmpdir(), "stash-migration-rollback-source-")), createAuthenticationSecretCodec(sourceKey));
    const admin = new Pool({ connectionString: postgresUrl! }); const schema = `embedded_rollback_${randomUUID().replaceAll("-", "")}`;
    const destinationRoot = await mkdtemp(join(tmpdir(), "stash-migration-rollback-destination-"));
    const destinationAttachments = join(destinationRoot, "attachments"); const destinationConfiguration = join(destinationRoot, "configuration");
    try {
      await source.database.verifyConnection(); await source.database.prepareInstanceStore();
      await source.database.createFirstOrganizationOwner({ organizationId: randomUUID(), organizationName: "Rollback", ownerId: randomUUID(), ownerName: "Owner",
        ownerEmail: "rollback@example.test", passwordHash: "rollback-hash", role: "Owner" });
      await writeFile(join(source.paths.attachments, "kept.bin"), Buffer.from("kept Attachment"));
      await writeFile(join(source.paths.configuration, "runtime.json"), JSON.stringify({ locale: "en" }));
      await admin.query(`CREATE SCHEMA ${schema}`); const scoped = new URL(postgresUrl!); scoped.searchParams.set("options", `-csearch_path=${schema}`);
      const destination = new (await import("../src/postgres-database.js")).PostgresDatabase(scoped.toString(), createAuthenticationSecretCodec(sourceKey));
      await destination.verifyConnection(); await destination.prepareInstanceStore(); await destination.close();
      await admin.query(`CREATE FUNCTION ${schema}.fail_migration() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'injected migration failure'; END $$`);
      await admin.query(`CREATE TRIGGER fail_migration BEFORE INSERT ON ${schema}.stash_organizations FOR EACH ROW EXECUTE FUNCTION ${schema}.fail_migration()`);
      const migrate = () => migrateEmbeddedInstance({ source, destinationDatabaseUrl: scoped.toString(), destinationAttachmentRoot: destinationAttachments,
        destinationConfigurationRoot: destinationConfiguration, destinationDatabaseAvailableBytes: BigInt(Number.MAX_SAFE_INTEGER),
        keys: { source: sourceKey, destination: sourceKey, mode: "preserve" } });
      await assert.rejects(migrate(), /injected migration failure/);
      assert.equal(Number((await admin.query(`SELECT count(*) count FROM ${schema}.stash_organizations`)).rows[0].count), 0);
      assert.equal(await exists(destinationAttachments), false); assert.equal(await exists(destinationConfiguration), false);
      assert.equal(await readFile(join(source.paths.attachments, "kept.bin"), "utf8"), "kept Attachment");
      await admin.query(`DROP TRIGGER fail_migration ON ${schema}.stash_organizations`);
      await migrate();
      assert.equal(Number((await admin.query(`SELECT count(*) count FROM ${schema}.stash_organizations`)).rows[0].count), 1);
      assert.equal(await readFile(join(destinationAttachments, "kept.bin"), "utf8"), "kept Attachment");
    } finally { await source.close(); await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`).catch(() => undefined); await admin.end(); }
  });

  test("recovers an ambiguous COMMIT acknowledgement from its journal without deleting committed state", async () => {
    const sourceKey = key(); const source = await EmbeddedInstanceStore.open(await mkdtemp(join(tmpdir(), "stash-migration-ambiguous-source-")), createAuthenticationSecretCodec(sourceKey));
    const admin = new Pool({ connectionString: postgresUrl! }); const schema = `embedded_ambiguous_${randomUUID().replaceAll("-", "")}`;
    const destinationRoot = await mkdtemp(join(tmpdir(), "stash-migration-ambiguous-destination-"));
    const attachments = join(destinationRoot, "attachments"); const configuration = join(destinationRoot, "configuration");
    try {
      await source.database.verifyConnection(); await source.database.prepareInstanceStore();
      await source.database.createFirstOrganizationOwner({ organizationId: randomUUID(), organizationName: "Committed", ownerId: randomUUID(), ownerName: "Owner",
        ownerEmail: "committed@example.test", passwordHash: "committed-hash", role: "Owner" });
      await writeFile(join(source.paths.attachments, "committed.bin"), Buffer.from("committed Attachment")); await writeFile(join(source.paths.configuration, "runtime.json"), "{}");
      await admin.query(`CREATE SCHEMA ${schema}`); const scoped = new URL(postgresUrl!); scoped.searchParams.set("options", `-csearch_path=${schema}`);
      const destination = new (await import("../src/postgres-database.js")).PostgresDatabase(scoped.toString(), createAuthenticationSecretCodec(sourceKey));
      await destination.verifyConnection(); await destination.prepareInstanceStore(); await destination.close();
      const options = { source, destinationDatabaseUrl: scoped.toString(), destinationAttachmentRoot: attachments, destinationConfigurationRoot: configuration,
        destinationDatabaseAvailableBytes: BigInt(Number.MAX_SAFE_INTEGER), keys: { source: sourceKey, destination: sourceKey, mode: "preserve" as const } };
      const result = await migrateEmbeddedInstance(options); const staged = join(destinationRoot, "ambiguous-attachments"); const configurationStaged = join(destinationRoot, "ambiguous-configuration");
      await rename(attachments, staged); await rename(configuration, configurationStaged);
      const tableNames = (await admin.query<{ table_name: string }>(`SELECT table_name FROM information_schema.tables WHERE table_schema=$1 AND table_name LIKE 'stash_%' ORDER BY table_name`, [schema])).rows.map(({ table_name }) => table_name);
      const tableDigests: Record<string, string> = {};
      for (const table of tableNames) {
        const columns = (await admin.query<{ column_name: string; data_type: string }>(`SELECT column_name,data_type FROM information_schema.columns WHERE table_schema=$1 AND table_name=$2 AND is_generated='NEVER' ORDER BY ordinal_position`, [schema, table])).rows;
        tableDigests[table] = migrationDigest((await admin.query(`SELECT ${columns.map(({ column_name }) => `"${column_name}"`).join(",")} FROM ${schema}."${table}"`)).rows, columns);
      }
      await writeFile(`${attachments}.migration-journal.json`, JSON.stringify({ staged, configurationStaged, state: "committing", ...result,
        attachmentFiles: [{ relative: "committed.bin", digest: createHash("sha256").update("committed Attachment").digest("hex") }],
        configurationFiles: [{ relative: "runtime.json", digest: createHash("sha256").update("{}").digest("hex") }], tableDigests }), { mode: 0o600 });
      assert.deepEqual(await migrateEmbeddedInstance(options), result);
      assert.equal(await readFile(join(attachments, "committed.bin"), "utf8"), "committed Attachment");
      assert.equal(Number((await admin.query(`SELECT count(*) count FROM ${schema}.stash_organizations`)).rows[0].count), 1);
      assert.equal(await exists(`${attachments}.migration-journal.json`), false);
      await assert.rejects(migrateEmbeddedInstance(options), /Attachment storage must be empty/);
    } finally { await source.close(); await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`).catch(() => undefined); await admin.end(); }
  });

  test("converges a journaled COMMIT with a rolled-back database outcome and reruns safely", async () => {
    const sourceKey = key(); const source = await EmbeddedInstanceStore.open(await mkdtemp(join(tmpdir(), "stash-migration-unknown-rollback-source-")), createAuthenticationSecretCodec(sourceKey));
    const admin = new Pool({ connectionString: postgresUrl! }); const schema = `embedded_unknown_rollback_${randomUUID().replaceAll("-", "")}`;
    const root = await mkdtemp(join(tmpdir(), "stash-migration-unknown-rollback-destination-")); const attachments = join(root, "attachments"); const configuration = join(root, "configuration");
    try {
      await source.database.verifyConnection(); await source.database.prepareInstanceStore();
      await source.database.createFirstOrganizationOwner({ organizationId: randomUUID(), organizationName: "Rolled back", ownerId: randomUUID(), ownerName: "Owner",
        ownerEmail: "unknown-rollback@example.test", passwordHash: "rollback-hash", role: "Owner" });
      await writeFile(join(source.paths.attachments, "rollback.bin"), "rollback Attachment"); await writeFile(join(source.paths.configuration, "runtime.json"), "{}");
      await admin.query(`CREATE SCHEMA ${schema}`); const scoped = new URL(postgresUrl!); scoped.searchParams.set("options", `-csearch_path=${schema}`);
      const destination = new (await import("../src/postgres-database.js")).PostgresDatabase(scoped.toString(), createAuthenticationSecretCodec(sourceKey));
      await destination.verifyConnection(); await destination.prepareInstanceStore(); await destination.close();
      const staged = join(root, "unknown-attachments"); const configurationStaged = join(root, "unknown-configuration");
      await cp(source.paths.attachments, staged, { recursive: true }); await cp(source.paths.configuration, configurationStaged, { recursive: true });
      const attachmentDigest = createHash("sha256").update("rollback Attachment").digest("hex"); const configurationDigest = createHash("sha256").update("{}").digest("hex");
      await writeFile(`${attachments}.migration-journal.json`, JSON.stringify({ staged, configurationStaged, state: "committing", tables: 0, rows: 0, attachments: 1,
        attachmentFiles: [{ relative: "rollback.bin", digest: attachmentDigest }], configurationFiles: [{ relative: "runtime.json", digest: configurationDigest }], tableDigests: {} }), { mode: 0o600 });
      const result = await migrateEmbeddedInstance({ source, destinationDatabaseUrl: scoped.toString(), destinationAttachmentRoot: attachments,
        destinationConfigurationRoot: configuration, destinationDatabaseAvailableBytes: BigInt(Number.MAX_SAFE_INTEGER),
        keys: { source: sourceKey, destination: sourceKey, mode: "preserve" } });
      assert.ok(result.rows > 0); assert.equal(await readFile(join(attachments, "rollback.bin"), "utf8"), "rollback Attachment");
      assert.equal(Number((await admin.query(`SELECT count(*) count FROM ${schema}.stash_organizations`)).rows[0].count), 1);
      assert.equal(await exists(`${attachments}.migration-journal.json`), false);
    } finally { await source.close(); await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`).catch(() => undefined); await admin.end(); }
  });

  test("preserves a compatible upgraded Instance format boundary", async () => {
    const sourceKey = key(); const source = await EmbeddedInstanceStore.open(await mkdtemp(join(tmpdir(), "stash-migration-versioned-source-")), createAuthenticationSecretCodec(sourceKey));
    const admin = new Pool({ connectionString: postgresUrl! }); const schema = `embedded_versioned_${randomUUID().replaceAll("-", "")}`; const root = await mkdtemp(join(tmpdir(), "stash-migration-versioned-destination-"));
    try {
      await source.database.verifyConnection(); await source.database.prepareInstanceStore();
      const sourceUpgrade = new PostgresInstanceUpgradeTarget("embedded://local", async () => undefined, source.upgradeDatabase); await sourceUpgrade.apply("0.0.0", "0.1.0");
      await admin.query(`CREATE SCHEMA ${schema}`); const scoped = new URL(postgresUrl!); scoped.searchParams.set("options", `-csearch_path=${schema}`);
      const destination = new (await import("../src/postgres-database.js")).PostgresDatabase(scoped.toString(), createAuthenticationSecretCodec(sourceKey));
      await destination.verifyConnection(); await destination.prepareInstanceStore(); const destinationUpgrade = new PostgresInstanceUpgradeTarget(scoped.toString(), async () => undefined);
      await destinationUpgrade.apply("0.0.0", "0.1.0"); await destination.close(); await destinationUpgrade.close();
      await migrateEmbeddedInstance({ source, destinationDatabaseUrl: scoped.toString(), destinationAttachmentRoot: join(root, "attachments"),
        destinationConfigurationRoot: join(root, "configuration"), destinationDatabaseAvailableBytes: BigInt(Number.MAX_SAFE_INTEGER),
        keys: { source: sourceKey, destination: sourceKey, mode: "preserve" } });
      assert.equal((await admin.query(`SELECT version FROM ${schema}.stash_instance_format WHERE singleton=TRUE`)).rows[0]?.version, "0.1.0");
    } finally { await source.close(); await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`).catch(() => undefined); await admin.end(); }
  });

  test("rejects corrupt protected source state before cutover and leaves both Instances restartable", async () => {
    const sourceKey = key(); const sourceRoot = await mkdtemp(join(tmpdir(), "stash-migration-corrupt-source-"));
    let source = await EmbeddedInstanceStore.open(sourceRoot, createAuthenticationSecretCodec(sourceKey));
    const admin = new Pool({ connectionString: postgresUrl! }); const schema = `embedded_corrupt_${randomUUID().replaceAll("-", "")}`; const root = await mkdtemp(join(tmpdir(), "stash-migration-corrupt-destination-"));
    try {
      await source.database.verifyConnection(); await source.database.prepareInstanceStore(); await source.database.createFirstOrganizationOwner({ organizationId: randomUUID(), organizationName: "Corrupt",
        ownerId: randomUUID(), ownerName: "Owner", ownerEmail: "corrupt@example.test", passwordHash: "protected-password", role: "Owner" });
      await source.upgradeDatabase.query("UPDATE stash_accounts SET password_hash='corrupt-envelope'");
      await admin.query(`CREATE SCHEMA ${schema}`); const scoped = new URL(postgresUrl!); scoped.searchParams.set("options", `-csearch_path=${schema}`);
      const destination = new (await import("../src/postgres-database.js")).PostgresDatabase(scoped.toString(), createAuthenticationSecretCodec(sourceKey));
      await destination.verifyConnection(); await destination.prepareInstanceStore(); await destination.close();
      await assert.rejects(migrateEmbeddedInstance({ source, destinationDatabaseUrl: scoped.toString(), destinationAttachmentRoot: join(root, "attachments"),
        destinationConfigurationRoot: join(root, "configuration"), destinationDatabaseAvailableBytes: BigInt(Number.MAX_SAFE_INTEGER),
        keys: { source: sourceKey, destination: sourceKey, mode: "preserve" } }), /encrypted authentication material|authentication secret envelope|ciphertext/i);
      assert.equal(Number((await admin.query(`SELECT count(*) count FROM ${schema}.stash_accounts`)).rows[0].count), 0);
      await source.close(); source = await EmbeddedInstanceStore.open(sourceRoot, createAuthenticationSecretCodec(sourceKey)); await source.database.verifyConnection();
    } finally { await source.close(); await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`).catch(() => undefined); await admin.end(); }
  });

  test("successful preserve and rotate CLI migrations keep keys out of process output, logs, diagnostics, and artifacts", async () => {
    const admin = new Pool({ connectionString: postgresUrl! });
    try {
      for (const mode of ["preserve", "rotate"] as const) {
        const sourceKey = key(); const destinationKey = mode === "preserve" ? sourceKey : key();
        const root = await mkdtemp(join(tmpdir(), `stash-migration-cli-${mode}-`)); const sourceRoot = join(root, "source");
        const source = await EmbeddedInstanceStore.open(sourceRoot, createAuthenticationSecretCodec(sourceKey));
        const organizationId = randomUUID(); const ownerId = randomUUID(); const workspaceId = randomUUID();
        await source.database.verifyConnection(); await source.database.prepareInstanceStore(); await source.database.createFirstOrganizationOwner({ organizationId,
          organizationName: "CLI", ownerId, ownerName: "CLI Owner", ownerEmail: `${mode}@example.test`, passwordHash: "cli-password", role: "Owner" });
        await source.database.createWorkspace({ id: workspaceId, name: "CLI Workspace", owner: { type: "organization", id: organizationId }, createdByMemberId: ownerId },
          { localAccountId: ownerId, displayName: "CLI Owner" });
        const portable = await new PortableWorkspaceExportService(source.database, new LocalAttachmentStorage(source.paths.attachments)).export(ownerId, workspaceId);
        assert.equal(portable.status, "exported"); if (portable.status === "exported") for (const secret of [sourceKey, destinationKey])
          assert.equal(Buffer.from(portable.archive).includes(Buffer.from(secret)), false);
        await writeFile(join(source.paths.attachments, "audit.txt"), "migration audit Attachment");
        await writeFile(join(source.paths.configuration, "runtime.json"), JSON.stringify({ diagnostics: "local" }));
        await source.close();
        const keyRoot = await mkdtemp(join(tmpdir(), "stash-migration-cli-keys-")); const sourceKeyFile = join(keyRoot, "source.key"); const destinationKeyFile = join(keyRoot, "destination.key");
        await writeFile(sourceKeyFile, sourceKey, { mode: 0o600 }); if (mode === "rotate") await writeFile(destinationKeyFile, destinationKey, { mode: 0o600 });
        const schema = `embedded_cli_${mode}_${randomUUID().replaceAll("-", "")}`; await admin.query(`CREATE SCHEMA ${schema}`);
        const scoped = new URL(postgresUrl!); scoped.searchParams.set("options", `-csearch_path=${schema}`);
        const destination = new (await import("../src/postgres-database.js")).PostgresDatabase(scoped.toString(), createAuthenticationSecretCodec(destinationKey));
        await destination.verifyConnection(); await destination.prepareInstanceStore(); await destination.close();
        const arguments_ = ["--import", "tsx", "src/migrate-embedded-command.ts", "--data-dir", sourceRoot, "--attachment-root", join(root, "destination-attachments"),
          "--configuration-root", join(root, "destination-configuration"), "--mode", mode, "--source-key-file", sourceKeyFile,
          ...(mode === "rotate" ? ["--destination-key-file", destinationKeyFile] : [])];
        const processResult = spawnSync(process.execPath, arguments_, { cwd: process.cwd(), encoding: "utf8", env: { ...process.env,
          DESTINATION_DATABASE_URL: scoped.toString(), DESTINATION_DATABASE_AVAILABLE_BYTES: String(Number.MAX_SAFE_INTEGER) } });
        assert.equal(processResult.status, 0, processResult.stderr); assert.match(processResult.stdout, /"status":"migrated"/);
        for (const surface of ["process_arguments", "diagnostics", "transient_staging", "transient_journal", "result", "operator_log"])
          assert.match(processResult.stdout, new RegExp(surface));
        for (const secret of [sourceKey, destinationKey]) { assert.equal(processResult.stdout.includes(secret), false); assert.equal(processResult.stderr.includes(secret), false); }
        await assertDirectoryExcludesSecrets(sourceRoot, [sourceKey, destinationKey]); await assertDirectoryExcludesSecrets(root, [sourceKey, destinationKey]);
        await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
      }
    } finally { await admin.end(); }
  });
});
