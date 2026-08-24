import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, test } from "node:test";

import { createAuthenticationSecretCodec } from "../src/authentication-secrets.js";
import { EmbeddedInstanceStore, EmbeddedInstanceStoreLocked } from "../src/embedded-instance-store.js";
import { paragraphDocument } from "../src/rich-text.js";
import { InstanceBackupService } from "../src/instance-backup.js";
import { EmbeddedLocalInstanceBackupSource, EmbeddedLocalInstanceRestoreTarget } from "../src/instance-backup-system.js";
import type { WorkspaceSearchResult } from "../src/workspace-search.js";
import { PostgresInstanceUpgradeTarget } from "../src/postgres-instance-upgrade.js";

const stores: EmbeddedInstanceStore[] = [];
afterEach(async () => Promise.all(stores.splice(0).map((store) => store.close().catch(() => undefined))));

function masterKey(): string { return randomBytes(32).toString("base64"); }

describe("embedded Instance store", () => {
  test("uses the shared Instance upgrade contract without an external PostgreSQL process", async () => {
    const store = await EmbeddedInstanceStore.open(await mkdtemp(join(tmpdir(), "stash-embedded-upgrade-")), createAuthenticationSecretCodec(masterKey())); stores.push(store);
    const target = new PostgresInstanceUpgradeTarget("embedded://local", async () => undefined, store.upgradeDatabase);
    const before = await target.inspect("0.1.0"); assert.equal(before.currentVersion, "0.0.0"); assert.equal(before.checks.every(({ status }) => status === "pass"), true);
    await target.apply("0.0.0", "0.1.0"); assert.equal((await target.inspect("0.1.0")).currentVersion, "0.1.0");
    await target.close(); await store.close(); stores.splice(stores.indexOf(store), 1);
  });
  test("persists PostgreSQL state beneath the selected data directory across a clean restart", async () => {
    const root = await mkdtemp(join(tmpdir(), "stash-embedded-restart-"));
    const key = masterKey();
    const first = await EmbeddedInstanceStore.open(root, createAuthenticationSecretCodec(key)); stores.push(first);
    await first.database.verifyConnection();
    assert.equal(await first.database.createFirstOrganizationOwner({ organizationId: "00000000-0000-4000-8000-000000000001", organizationName: "Stash",
      ownerId: "00000000-0000-4000-8000-000000000002", ownerName: "Ada", ownerEmail: "ada@example.test", passwordHash: "hash", role: "Owner" }), true);
    await first.close(); stores.splice(stores.indexOf(first), 1);

    const second = await EmbeddedInstanceStore.open(root, createAuthenticationSecretCodec(key)); stores.push(second);
    assert.equal(await second.database.createFirstOrganizationOwner({ organizationId: "00000000-0000-4000-8000-000000000003", organizationName: "Other",
      ownerId: "00000000-0000-4000-8000-000000000004", ownerName: "Grace", ownerEmail: "grace@example.test", passwordHash: "hash", role: "Owner" }), false);
    assert.equal(second.paths.attachments, join(root, "attachments"));
    assert.equal(second.paths.backups, join(root, "backups"));
    assert.equal(second.paths.configuration, join(root, "config"));
  });

  test("refuses a second writer and does not expose lock takeover", async () => {
    const root = await mkdtemp(join(tmpdir(), "stash-embedded-lock-"));
    const first = await EmbeddedInstanceStore.open(root, createAuthenticationSecretCodec(masterKey())); stores.push(first);
    await assert.rejects(() => EmbeddedInstanceStore.open(root, createAuthenticationSecretCodec(masterKey())), EmbeddedInstanceStoreLocked);
    const lock = JSON.parse(await readFile(join(root, ".instance.lock"), "utf8")) as { pid: number; token?: string };
    assert.equal(lock.pid, process.pid);
    assert.equal("token" in lock, false);
  });

  test("reclaims a stale lock after an unclean shutdown", async () => {
    const root = await mkdtemp(join(tmpdir(), "stash-embedded-crash-"));
    await writeFile(join(root, ".instance.lock"), `${JSON.stringify({ pid: 2_147_483_647 })}\n`, { mode: 0o600 });
    const store = await EmbeddedInstanceStore.open(root, createAuthenticationSecretCodec(masterKey())); stores.push(store);
    await store.database.verifyConnection();
  });

  test("preserves repository, authorization, search, and durable-job semantics", async () => {
    const root = await mkdtemp(join(tmpdir(), "stash-embedded-contract-")); const key = masterKey();
    const store = await EmbeddedInstanceStore.open(root, createAuthenticationSecretCodec(key)); stores.push(store); const database = store.database;
    const organizationId = "10000000-0000-4000-8000-000000000001"; const ownerId = "10000000-0000-4000-8000-000000000002";
    const workspaceId = "10000000-0000-4000-8000-000000000003"; const noteId = "10000000-0000-4000-8000-000000000004";
    await database.verifyConnection(); await database.prepareInstanceStore();
    assert.equal(await database.createFirstOrganizationOwner({ organizationId, organizationName: "Stash", ownerId, ownerName: "Ada",
      ownerEmail: "ada@example.test", passwordHash: "password-hash", role: "Owner" }), true);
    assert.equal((await database.createWorkspace({ id: workspaceId, name: "Planning", owner: { type: "organization", id: organizationId },
      createdByMemberId: ownerId }, { localAccountId: ownerId, displayName: "Ada" })).status, "created");
    const document = paragraphDocument("Embedded release plan", "10000000-0000-4000-8000-000000000005");
    assert.equal(await database.createNote(ownerId, { id: noteId, workspaceId, content: "Embedded release plan", document, revision: 1,
      tags: ["release"], createdByMemberId: ownerId, createdAt: "2026-08-24T10:00:00.000Z" },
    { schema: "stash.note.v1", id: noteId, workspaceId, content: "Embedded release plan", tags: ["release"],
      createdAt: "2026-08-24T10:00:00.000Z", createdBy: { localAccountId: ownerId, displayName: "Ada" } }), "created");
    const search = await database.searchWorkspace(ownerId, workspaceId, { q: "release" });
    assert.equal(search.status, "found"); if (search.status === "found") assert.equal(search.results.some((result: WorkspaceSearchResult) => result.id === noteId), true);
    const jobId = "10000000-0000-4000-8000-000000000006"; await database.enqueueEmailRecovery({ id: jobId, protectedDelivery: "protected", createdAt: "2026-08-24T10:00:00.000Z" });
    const claimed = await database.claimEmailRecoveryDelivery("10000000-0000-4000-8000-000000000007", "2026-08-24T10:10:00.000Z");
    assert.equal(claimed?.job.id, jobId); assert.equal(await database.completeEmailRecoveryDelivery(claimed!.claim), true);
    const snapshot = await store.semanticSnapshot();
    assert.equal(snapshot.find((table) => table.name === "stash_notes")?.rows.length, 1);
    assert.equal(snapshot.find((table) => table.name === "stash_workspace_activity")?.rows.length, 1);
  });

  test("creates an integrity-checked adapter-native backup without the master key", async () => {
    const root = await mkdtemp(join(tmpdir(), "stash-embedded-backup-")); const key = masterKey();
    const store = await EmbeddedInstanceStore.open(root, createAuthenticationSecretCodec(key)); stores.push(store); await store.database.verifyConnection();
    const backup = join(store.paths.backups, "manual"); const service = new InstanceBackupService(
      new EmbeddedLocalInstanceBackupSource({ store, publicOrigin: "http://127.0.0.1:3000" }), { masterKey: key });
    await service.create(backup); assert.equal((await service.verify(backup)).status, "verified");
    const manifest = await readFile(join(backup, "manifest.json"), "utf8");
    assert.match(manifest, /pglite-data-directory-v1/); assert.doesNotMatch(manifest, new RegExp(key.replace(/[+/=]/g, "\\$&")));
  });

  test("restores an embedded backup and requires restart before the restored state is used", async () => {
    const root = await mkdtemp(join(tmpdir(), "stash-embedded-restore-")); const key = masterKey();
    const store = await EmbeddedInstanceStore.open(root, createAuthenticationSecretCodec(key)); stores.push(store); await store.database.verifyConnection();
    const backup = join(store.paths.backups, "restore-point"); const service = new InstanceBackupService(
      new EmbeddedLocalInstanceBackupSource({ store, publicOrigin: "http://127.0.0.1:3000" }), { masterKey: key });
    await service.create(backup);
    const target = new EmbeddedLocalInstanceRestoreTarget({ store, publicOrigin: "http://127.0.0.1:3000" });
    assert.deepEqual(await service.restore(backup, target, { dryRun: false }), { status: "restored" }); assert.equal(service.requiresRestart(), true);
    await store.database.verifyConnection();
    await store.close(); stores.splice(stores.indexOf(store), 1);
    const reopened = await EmbeddedInstanceStore.open(root, createAuthenticationSecretCodec(key)); stores.push(reopened); await reopened.database.verifyConnection();
  });
});
