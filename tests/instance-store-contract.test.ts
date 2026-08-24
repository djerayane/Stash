import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";
import { Pool } from "pg";
import * as Y from "yjs";

import { createAuthenticationSecretCodec } from "../src/authentication-secrets.js";
import { EmbeddedInstanceStore } from "../src/embedded-instance-store.js";
import { NoteCollaborationService } from "../src/note-collaboration.js";
import { paragraphDocument } from "../src/rich-text.js";
import { InstanceBackupService } from "../src/instance-backup.js";
import { EmbeddedLocalInstanceBackupSource, EmbeddedLocalInstanceRestoreTarget, PostgresLocalInstanceBackupSource, PostgresLocalInstanceRestoreTarget } from "../src/instance-backup-system.js";
import { PortableWorkspaceExportService } from "../src/portable-workspace-export.js";
import { PostgresDatabase } from "../src/postgres-database.js";
import { PostgresInstanceUpgradeTarget } from "../src/postgres-instance-upgrade.js";

interface ContractHarness {
  database: PostgresDatabase;
  backup: InstanceBackupService;
  restoreTarget: EmbeddedLocalInstanceRestoreTarget | PostgresLocalInstanceRestoreTarget;
  upgrade: PostgresInstanceUpgradeTarget;
  backupRoot: string;
  close(): Promise<void>;
}

interface ContractAdapter {
  name: string;
  skip?: string | false;
  exclusions: readonly string[];
  open(): Promise<ContractHarness>;
}

const key = () => randomBytes(32).toString("base64");

function contract(adapter: ContractAdapter): void {
  describe(`${adapter.name} Instance-store behavioral contract`, { skip: adapter.skip || false }, () => {
    test("shares repository, membership authorization, collaboration, search, job, and portable-export behavior", async () => {
      const harness = await adapter.open();
      try {
        const database = harness.database;
        const organizationId = randomUUID(); const ownerId = randomUUID(); const outsiderId = randomUUID();
        const workspaceId = randomUUID(); const noteId = randomUUID(); const createdAt = "2026-08-24T10:00:00.000Z";
        await database.prepareInstanceStore();
        assert.equal(await database.createFirstOrganizationOwner({ organizationId, organizationName: "Parity", ownerId,
          ownerName: "Owner", ownerEmail: `${ownerId}@example.test`, passwordHash: "owner-hash", role: "Owner" }), true);
        assert.equal(await database.createAccountWithPersonalWorkspaceAndSession({
          account: { id: outsiderId, name: "Outsider", email: `${outsiderId}@example.test`, passwordHash: "outsider-hash" },
          workspace: { id: randomUUID(), name: "Outsider Workspace" },
          session: { id: randomUUID(), accountId: outsiderId, tokenHash: "token-hash", createdAt, lastSeenAt: createdAt },
        }), true);
        assert.equal((await database.createWorkspace({ id: workspaceId, name: "Shared", owner: { type: "organization", id: organizationId },
          createdByMemberId: ownerId }, { localAccountId: ownerId, displayName: "Owner" })).status, "created");
        const document = paragraphDocument("Parity note", randomUUID());
        const projection = { schema: "stash.note.v1" as const, id: noteId, workspaceId, content: "Parity note", tags: ["parity"],
          createdAt, createdBy: { localAccountId: ownerId, displayName: "Owner" } };
        assert.equal(await database.createNote(ownerId, { id: noteId, workspaceId, content: "Parity note", document, revision: 1,
          tags: ["parity"], createdByMemberId: ownerId, createdAt }, projection), "created");
        assert.equal(await database.createNote(outsiderId, { id: randomUUID(), workspaceId, content: "Denied", document, revision: 1,
          tags: [], createdByMemberId: outsiderId, createdAt }, { ...projection, id: randomUUID(), content: "Denied",
          createdBy: { localAccountId: outsiderId, displayName: "Outsider" } }), "workspace_forbidden");
        assert.equal((await database.listAccessibleWorkspaces(ownerId)).some((workspace: { id: string }) => workspace.id === workspaceId), true);
        assert.equal((await database.listAccessibleWorkspaces(outsiderId)).some((workspace: { id: string }) => workspace.id === workspaceId), false);
        assert.equal((await database.listNoteHistory(ownerId, noteId)).status, "found");
        assert.equal((await database.listWorkspaceActivity(ownerId, workspaceId)).status, "found");

        const collaboration = new NoteCollaborationService(database); const update = new Y.Doc(); update.getText("parity").insert(0, "shared");
        assert.equal((await collaboration.apply(ownerId, noteId, Y.encodeStateAsUpdate(update)))?.sequence, 1); update.destroy();
        assert.equal(await collaboration.load(outsiderId, noteId), undefined);
        const search = await database.searchWorkspace(ownerId, workspaceId, { q: "Parity" });
        assert.equal(search.status, "found"); if (search.status === "found") assert.equal(search.results.some((result: { id: string }) => result.id === noteId), true);
        assert.equal((await database.searchWorkspace(outsiderId, workspaceId, { q: "Parity" })).status, "forbidden");

        const jobId = randomUUID(); await database.enqueueEmailRecovery({ id: jobId, protectedDelivery: "protected", createdAt });
        const claimed = await database.claimEmailRecoveryDelivery(randomUUID(), "2026-08-24T10:10:00.000Z");
        assert.equal(claimed?.job.id, jobId); assert.equal(await database.completeEmailRecoveryDelivery(claimed!.claim), true);
        const exported = await new PortableWorkspaceExportService(database).export(ownerId, workspaceId);
        assert.equal(exported.status, "exported"); if (exported.status === "exported") assert.ok(exported.archive.byteLength > 0);
        assert.equal((await new PortableWorkspaceExportService(database).export(outsiderId, workspaceId)).status, "workspace_forbidden");
      } finally { await harness.close(); }
    });

    test("shares backup/restore and upgrade lifecycle behavior", async () => {
      const harness = await adapter.open();
      try {
        await harness.database.prepareInstanceStore();
        const backupPath = join(harness.backupRoot, "contract");
        await harness.backup.create(backupPath);
        assert.equal((await harness.backup.verify(backupPath)).status, "verified");
        assert.deepEqual(await harness.backup.restore(backupPath, harness.restoreTarget, { dryRun: true }), { status: "verified" });
        assert.deepEqual(await harness.backup.restore(backupPath, harness.restoreTarget, { dryRun: false }), { status: "restored" });
        const before = await harness.upgrade.inspect("0.1.0");
        assert.equal(before.currentVersion, "0.0.0"); assert.equal(before.checks.every(({ status }) => status === "pass"), true);
        await harness.upgrade.apply("0.0.0", "0.1.0");
        assert.equal((await harness.upgrade.inspect("0.1.0")).currentVersion, "0.1.0");
      } finally { await harness.close(); }
    });

    test("declares only lifecycle exclusions outside the shared behavioral surface", () => {
      assert.deepEqual(adapter.exclusions, adapter.name === "embedded PGlite"
        ? ["external PostgreSQL process administration", "pg_dump custom-format interoperability"]
        : ["single-process data-directory locking", "PGlite data-directory snapshots"]);
    });
  });
}

contract({ name: "embedded PGlite", exclusions: ["external PostgreSQL process administration", "pg_dump custom-format interoperability"],
  async open() {
    const root = await mkdtemp(join(tmpdir(), "stash-contract-embedded-")); const masterKey = key();
    const store = await EmbeddedInstanceStore.open(root, createAuthenticationSecretCodec(masterKey));
    return { database: store.database, backupRoot: store.paths.backups,
      backup: new InstanceBackupService(new EmbeddedLocalInstanceBackupSource({ store, publicOrigin: "http://127.0.0.1:3000" }), { masterKey }),
      restoreTarget: new EmbeddedLocalInstanceRestoreTarget({ store, publicOrigin: "http://127.0.0.1:3000" }),
      upgrade: new PostgresInstanceUpgradeTarget("embedded://local", async () => undefined, store.upgradeDatabase),
      async close() { await store.close(); await rm(root, { recursive: true, force: true }); } };
  } });

const postgresUrl = process.env.STASH_TEST_DATABASE_URL;
contract({ name: "external PostgreSQL", skip: postgresUrl ? false : "STASH_TEST_DATABASE_URL is not configured",
  exclusions: ["single-process data-directory locking", "PGlite data-directory snapshots"], async open() {
    const root = await mkdtemp(join(tmpdir(), "stash-contract-postgres-")); const schema = `contract_${randomUUID().replaceAll("-", "")}`;
    const administrator = new Pool({ connectionString: postgresUrl! }); await administrator.query(`CREATE SCHEMA ${schema}`);
    const scoped = new URL(postgresUrl!); scoped.searchParams.set("options", `-csearch_path=${schema}`); const databaseUrl = scoped.toString();
    const masterKey = key(); const database = new PostgresDatabase(databaseUrl, createAuthenticationSecretCodec(masterKey));
    const attachments = join(root, "attachments"); const backupRoot = join(root, "backups");
    return { database, backupRoot,
      backup: new InstanceBackupService(new PostgresLocalInstanceBackupSource({ databaseUrl, attachmentRoot: attachments, publicOrigin: "http://127.0.0.1:3000" }), { masterKey }),
      restoreTarget: new PostgresLocalInstanceRestoreTarget({ databaseUrl, attachmentRoot: attachments, publicOrigin: "http://127.0.0.1:3000" }),
      upgrade: new PostgresInstanceUpgradeTarget(databaseUrl, async () => undefined),
      async close() { await database.close(); await administrator.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`); await administrator.end(); await rm(root, { recursive: true, force: true }); } };
  } });
