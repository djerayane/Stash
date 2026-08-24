import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { spawnSync } from "node:child_process";

import { InstanceBackupService, type InstanceBackupRestoreTarget, type InstanceBackupSource } from "../src/instance-backup.js";
import { startInstance, type DatabaseProbe, type RunningInstance } from "../src/instance.js";

const masterKey = Buffer.alloc(32, 7).toString("base64");

class FakeSource implements InstanceBackupSource {
  fail: Error | undefined;
  emptyAttachments = false;
  readonly calls: string[] = [];
  async captureDatabase(destination: string) {
    this.calls.push("database");
    if (this.fail) throw this.fail;
    await writeFile(destination, "database-with-identities-audit-and-encrypted-secrets");
  }
  async captureAttachments(destination: string) {
    this.calls.push("attachments");
    if (this.emptyAttachments) return [];
    await mkdir(join(destination, "workspace"), { recursive: true });
    await writeFile(join(destination, "workspace", "attachment"), Buffer.from([0, 1, 2, 255]));
    return ["workspace/attachment"];
  }
  async captureConfiguration() {
    this.calls.push("configuration");
    return { publicOrigin: "https://stash.example", attachmentStorage: "local" };
  }
}

class Probe implements DatabaseProbe { async verifyConnection() {} async close() {} }
class FakeRestoreTarget implements InstanceBackupRestoreTarget {
  readonly databaseFormat = "postgresql-custom" as const;
  readonly calls: string[] = [];
  commitFailure: Error | undefined;
  rollbackFailure: Error | undefined;
  async validateConfiguration(configuration: Record<string, unknown>) { assert.equal(configuration.attachmentStorage, "local"); this.calls.push("configuration"); }
  async prepareAttachments(path: string, paths: ReadonlyArray<string>) { assert.match(path, /attachments$/); assert.deepEqual(paths, ["workspace/attachment"]); this.calls.push("prepare"); return "prepared"; }
  async snapshotDatabase(path: string) { await writeFile(path, "rollback"); this.calls.push("snapshot"); }
  async restoreDatabase(path: string) { const rollback = !path.endsWith("database.dump"); this.calls.push(rollback ? "rollback" : "database"); if (rollback && this.rollbackFailure) throw this.rollbackFailure; }
  async commitAttachments() { this.calls.push("commit"); if (this.commitFailure) throw this.commitFailure; }
  async discardPreparedAttachments() { this.calls.push("discard"); }
}

describe("coordinated Instance Backup", () => {
  const instances: RunningInstance[] = [];
  afterEach(async () => { await Promise.all(instances.splice(0).map((instance) => instance.close())); });

  it("creates a versioned, integrity-checked backup without embedding the master key", async () => {
    const root = await mkdtemp(join(tmpdir(), "stash-backup-test-"));
    const source = new FakeSource();
    const service = new InstanceBackupService(source, { masterKey, now: () => new Date("2026-08-23T10:00:00.000Z") });
    const result = await service.create(join(root, "backup"));

    assert.equal(result.status, "created");
    assert.deepEqual(source.calls, ["database", "attachments", "configuration"]);
    const manifestBytes = await readFile(join(root, "backup", "manifest.json"));
    const manifest = JSON.parse(manifestBytes.toString()) as any;
    assert.equal(manifest.schema, "stash.instance-backup.v1");
    assert.equal(manifest.consistency, "coordinated");
    assert.equal(manifest.masterKey.required, true);
    assert.doesNotMatch(manifestBytes.toString(), new RegExp(masterKey.replace(/[+/=]/g, "\\$&")));
    for (const file of manifest.files) {
      const bytes = await readFile(join(root, "backup", file.path));
      assert.equal(file.bytes, bytes.length);
      assert.equal(file.sha256, createHash("sha256").update(bytes).digest("hex"));
    }
  });

  it("closes the mutation boundary and drains in-flight work before capturing coordinated state", async () => {
    const root = await mkdtemp(join(tmpdir(), "stash-backup-drain-")); const source = new FakeSource();
    const service = new InstanceBackupService(source, { masterKey }); let releaseMutation!: () => void; let enteredBarrier!: () => void;
    const mutation = new Promise<void>((resolve) => { releaseMutation = () => { source.calls.push("mutation_committed"); resolve(); }; });
    const barrierEntered = new Promise<void>((resolve) => { enteredBarrier = resolve; });
    service.setBackupUnavailableBarrier(async () => { enteredBarrier(); await mutation; });
    const backup = service.create(join(root, "backup")); await barrierEntered;
    assert.equal(service.availability(), "backup_in_progress"); assert.deepEqual(source.calls, []);
    releaseMutation(); await backup;
    assert.deepEqual(source.calls, ["mutation_committed", "database", "attachments", "configuration"]);
  });

  it("wires the running Instance drain without making the backup request wait on itself", async () => {
    const root = await mkdtemp(join(tmpdir(), "stash-backup-instance-drain-")); const source = new FakeSource();
    const service = new InstanceBackupService(source, { masterKey }); let releaseRequest!: () => void; let enteredRequest!: () => void;
    const requestGate = new Promise<void>((resolve) => { releaseRequest = resolve; });
    const requestEntered = new Promise<void>((resolve) => { enteredRequest = resolve; });
    const database: DatabaseProbe = { async verifyConnection() {}, async close() {}, async resolveClientSessionPrincipal() {
      enteredRequest(); await requestGate; return { member: { id: "member", name: "Member", email: "member@stash.test" },
        workspace: { id: "workspace", name: "Workspace" }, capabilities: [] }; } };
    const instance = await startInstance({ database, host: "127.0.0.1", port: 0, instanceAdminToken: "admin",
      memberAccess: { async authenticateBearer() { return { accountId: "member", sessionId: "session" }; } },
      instanceBackups: service, instanceBackupRoot: join(root, "backups") }); instances.push(instance);
    const active = fetch(`${instance.url}/api/client-session`, { headers: { authorization: "Bearer member" } }); await requestEntered;
    const backup = fetch(`${instance.url}/api/instance/backups`, { method: "POST", headers: { authorization: "Bearer admin" } });
    while (service.availability() !== "backup_in_progress") await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(source.calls, []);
    assert.equal((await fetch(`${instance.url}/api/v1/workspaces`, { method: "POST", headers: { authorization: "Bearer member" }, body: "{}" })).status, 503);
    releaseRequest(); assert.equal((await active).status, 200); assert.equal((await backup).status, 201);
    assert.deepEqual(source.calls, ["database", "attachments", "configuration"]);
  });

  it("creates, verifies, and restores an Instance with no Attachments", async () => {
    const root = await mkdtemp(join(tmpdir(), "stash-backup-empty-"));
    const source = new FakeSource(); source.emptyAttachments = true;
    const path = join(root, "backup"); const service = new InstanceBackupService(source, { masterKey });
    await service.create(path);
    assert.deepEqual(await service.verify(path), { status: "verified", schema: "stash.instance-backup.v1", files: 2 });
    const target = new FakeRestoreTarget();
    target.prepareAttachments = async (sourcePath, paths) => { assert.match(sourcePath, /attachments$/); assert.deepEqual(paths, []); target.calls.push("prepare"); return "prepared"; };
    assert.deepEqual(await service.restore(path, target, { dryRun: false }), { status: "restored" });
    assert.deepEqual(target.calls, ["configuration", "prepare", "snapshot", "database", "commit", "discard"]);
  });

  it("rejects a database adapter mismatch during dry-run before restore preparation", async () => {
    const root = await mkdtemp(join(tmpdir(), "stash-backup-adapter-mismatch-"));
    const path = join(root, "backup"); const service = new InstanceBackupService(new FakeSource(), { masterKey });
    await service.create(path); const target = new FakeRestoreTarget();
    Object.defineProperty(target, "databaseFormat", { value: "pglite-data-directory-v1" });
    await assert.rejects(service.restore(path, target, { dryRun: true }), /database storage adapter/i);
    assert.deepEqual(target.calls, []);
  });

  it("rejects misspelled restore flags and surplus CLI arguments before reading configuration or restoring", () => {
    const command = (arguments_: string[]) => spawnSync(process.execPath, ["--import", "tsx", "src/backup-command.ts", ...arguments_], {
      cwd: process.cwd(), env: { PATH: process.env.PATH ?? "" }, encoding: "utf8",
    });
    for (const arguments_ of [
      ["restore", "/tmp/backup", "--dry-rnu"],
      ["restore", "/tmp/backup", "--dry-run", "extra"],
      ["verify", "/tmp/backup", "extra"],
    ]) {
      const result = command(arguments_);
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /usage: stash-backup/);
      assert.doesNotMatch(result.stderr, /DATABASE_URL|pg_restore/);
    }
  });

  it("dry-runs restore verification and rejects corruption, missing files, wrong keys, and versions", async () => {
    const root = await mkdtemp(join(tmpdir(), "stash-backup-verify-"));
    const path = join(root, "backup");
    const service = new InstanceBackupService(new FakeSource(), { masterKey });
    await service.create(path);
    assert.deepEqual(await service.verify(path), { status: "verified", schema: "stash.instance-backup.v1", files: 3 });

    const wrongKey = new InstanceBackupService(new FakeSource(), { masterKey: Buffer.alloc(32, 8).toString("base64") });
    await assert.rejects(wrongKey.verify(path), /master key does not match/i);
    await writeFile(join(path, "database.dump"), "corrupt");
    await assert.rejects(service.verify(path), /checksum mismatch/i);

    const manifestPath = join(path, "manifest.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    manifest.schema = "stash.instance-backup.v99";
    await writeFile(manifestPath, JSON.stringify(manifest));
    await assert.rejects(service.verify(path), /unsupported Instance Backup version/i);
  });

  it("verifies before restoration and makes dry-run non-mutating", async () => {
    const root = await mkdtemp(join(tmpdir(), "stash-backup-restore-"));
    const path = join(root, "backup");
    const service = new InstanceBackupService(new FakeSource(), { masterKey });
    await service.create(path);
    const target = new FakeRestoreTarget();
    assert.deepEqual(await service.restore(path, target, { dryRun: true }), { status: "verified" });
    assert.deepEqual(target.calls, ["configuration"]);
    assert.deepEqual(await service.restore(path, target, { dryRun: false }), { status: "restored" });
    assert.deepEqual(target.calls, ["configuration", "configuration", "prepare", "snapshot", "database", "commit", "discard"]);
  });

  it("stages Attachments before database mutation and rolls the database back if their atomic swap fails", async () => {
    const root = await mkdtemp(join(tmpdir(), "stash-backup-rollback-"));
    const path = join(root, "backup"); const service = new InstanceBackupService(new FakeSource(), { masterKey }); await service.create(path);
    const target = new FakeRestoreTarget(); target.commitFailure = new Error("attachment swap unavailable");
    await assert.rejects(service.restore(path, target, { dryRun: false }), /attachment swap unavailable/);
    assert.deepEqual(target.calls, ["configuration", "prepare", "snapshot", "database", "commit", "rollback", "discard"]);
    assert.equal(service.availability(), "available");
  });

  it("gates all application API traffic before the rollback snapshot and throughout a running restore", async () => {
    const root = await mkdtemp(join(tmpdir(), "stash-backup-concurrency-")); const backupRoot = join(root, "scheduled");
    const service = new InstanceBackupService(new FakeSource(), { masterKey }); await service.create(join(backupRoot, "release-ready"));
    const target = new FakeRestoreTarget(); let continueSnapshot!: () => void; let snapshotStarted!: () => void;
    const snapshotGate = new Promise<void>((resolve) => { continueSnapshot = resolve; });
    const enteredSnapshot = new Promise<void>((resolve) => { snapshotStarted = resolve; });
    target.snapshotDatabase = async (path) => { target.calls.push("snapshot"); snapshotStarted(); await snapshotGate; await writeFile(path, "rollback"); };
    let continueApplicationRead!: () => void; let applicationReadStarted!: () => void;
    const applicationReadGate = new Promise<void>((resolve) => { continueApplicationRead = resolve; });
    const enteredApplicationRead = new Promise<void>((resolve) => { applicationReadStarted = resolve; });
    const database: DatabaseProbe = { async verifyConnection() {}, async close() {}, async resolveClientSessionPrincipal() {
      applicationReadStarted(); await applicationReadGate; return { member: { id: "member", name: "Member", email: "member@stash.test" },
        workspace: { id: "workspace", name: "Workspace" }, capabilities: [] }; } };
    const instance = await startInstance({ database, host: "127.0.0.1", port: 0, instanceAdminToken: "admin",
      memberAccess: { async authenticateBearer(authorization) { return authorization === "Bearer member" ? { accountId: "member", sessionId: "session" } : undefined; } },
      instanceBackups: service, instanceBackupRoot: backupRoot, instanceBackupRestoreTarget: target }); instances.push(instance);
    const headers = { authorization: "Bearer admin", "content-type": "application/json" };
    const activeRead = fetch(`${instance.url}/api/client-session`, { headers: { authorization: "Bearer member" } }); await enteredApplicationRead;
    const restore = fetch(`${instance.url}/api/instance/backups/release-ready/restore`, { method: "POST", headers,
      body: JSON.stringify({ dryRun: false, confirmation: "release-ready" }) });
    while (service.availability() !== "restore_in_progress") await new Promise((resolve) => setImmediate(resolve));

    assert.equal(service.availability(), "restore_in_progress");
    assert.deepEqual(target.calls, ["configuration", "prepare"]);
    assert.equal((await fetch(`${instance.url}/api/client-session`, { headers })).status, 503);
    continueApplicationRead(); assert.equal((await activeRead).status, 200); await enteredSnapshot;
    assert.deepEqual(target.calls, ["configuration", "prepare", "snapshot"]);
    for (const request of [
      fetch(`${instance.url}/api/client-session`, { headers }),
      fetch(`${instance.url}/api/client-session`, { method: "HEAD", headers }),
      fetch(`${instance.url}/api/v1/workspaces`, { headers }),
      fetch(`${instance.url}/api/instance/backups/release-ready/restore`, { headers }),
      fetch(`${instance.url}/api/v1/workspaces`, { method: "POST", headers, body: "{}" }),
    ]) {
      const response = await request; assert.equal(response.status, 503); assert.equal(response.headers.get("cache-control"), "no-store");
    }
    const readiness = await fetch(`${instance.url}/health/ready`); assert.equal(readiness.status, 503);
    assert.equal((await readiness.json() as { error: string }).error, "restore_in_progress");
    assert.equal((await fetch(`${instance.url}/api/instance/backups/health`, { headers })).status, 200);
    const concurrent = await fetch(`${instance.url}/api/instance/backups/release-ready/restore`, { method: "POST", headers,
      body: JSON.stringify({ dryRun: true }) });
    assert.equal(concurrent.status, 409);

    continueSnapshot(); const restored = await restore; assert.equal(restored.status, 200);
    assert.equal(service.availability(), "restore_restart_required");
    assert.equal((await fetch(`${instance.url}/api/client-session`, { headers })).status, 503);
  });

  it("never resumes traffic when Attachment failure and database rollback both fail", async () => {
    const root = await mkdtemp(join(tmpdir(), "stash-backup-double-failure-")); const backupRoot = join(root, "scheduled");
    const service = new InstanceBackupService(new FakeSource(), { masterKey }); await service.create(join(backupRoot, "release-ready"));
    const target = new FakeRestoreTarget(); target.commitFailure = new Error("attachment swap unavailable"); target.rollbackFailure = new Error("database rollback unavailable");
    const instance = await startInstance({ database: new Probe(), host: "127.0.0.1", port: 0, instanceAdminToken: "admin",
      instanceBackups: service, instanceBackupRoot: backupRoot, instanceBackupRestoreTarget: target }); instances.push(instance);
    const headers = { authorization: "Bearer admin", "content-type": "application/json" };
    const response = await fetch(`${instance.url}/api/instance/backups/release-ready/restore`, { method: "POST", headers,
      body: JSON.stringify({ dryRun: false, confirmation: "release-ready" }) });
    assert.equal(response.status, 503); assert.equal((await response.json() as { error: string }).error, "restore_failed");
    assert.deepEqual(target.calls, ["configuration", "prepare", "snapshot", "database", "commit", "rollback", "discard"]);
    assert.equal(service.availability(), "restore_restart_required");
    for (const path of ["/api/client-session", "/api/v1/workspaces"]) assert.equal((await fetch(`${instance.url}${path}`, { headers })).status, 503);
    const readiness = await fetch(`${instance.url}/health/ready`); assert.equal(readiness.status, 503);
    assert.equal((await readiness.json() as { error: string }).error, "restore_restart_required");
  });

  it("rejects unlisted files, symbolic links, and unlisted directories before restore", async () => {
    const root = await mkdtemp(join(tmpdir(), "stash-backup-inventory-"));
    const service = new InstanceBackupService(new FakeSource(), { masterKey });
    for (const kind of ["file", "symlink", "directory"] as const) {
      const path = join(root, kind); await service.create(path);
      if (kind === "file") await writeFile(join(path, "unlisted"), "hidden");
      if (kind === "symlink") await symlink("database.dump", join(path, "alias"));
      if (kind === "directory") await mkdir(join(path, "empty"));
      await assert.rejects(service.verify(path), /inventory|symbolic link/i);
    }
  });

  it("publishes visible backup health only to the Instance Administrator", async () => {
    const root = await mkdtemp(join(tmpdir(), "stash-backup-health-"));
    const backupRoot = join(root, "scheduled");
    const service = new InstanceBackupService(new FakeSource(), { masterKey, now: () => new Date("2026-08-23T10:00:00.000Z") });
    const firstBackup = join(backupRoot, "first"); await service.create(firstBackup);
    // A separate CLI process can verify later; its signed timestamp remains observable after restart.
    const cliVerifier = new InstanceBackupService(new FakeSource(), { masterKey, now: () => new Date("2026-08-23T10:05:00.000Z") });
    await cliVerifier.verify(firstBackup);
    const instance = await startInstance({ database: new Probe(), host: "127.0.0.1", port: 0,
      instanceAdminToken: "admin", instanceBackups: service, instanceBackupRoot: backupRoot });
    instances.push(instance);

    assert.equal((await fetch(`${instance.url}/api/instance/backups/health`)).status, 401);
    const response = await fetch(`${instance.url}/api/instance/backups/health`, { headers: { authorization: "Bearer admin" } });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { status: "verified", createdAt: "2026-08-23T10:00:00.000Z",
      verifiedAt: "2026-08-23T10:05:00.000Z", schema: "stash.instance-backup.v1" });

    await instance.close(); instances.splice(instances.indexOf(instance), 1);
    const restartedService = new InstanceBackupService(new FakeSource(), { masterKey });
    const restarted = await startInstance({ database: new Probe(), host: "127.0.0.1", port: 0, instanceAdminToken: "admin",
      instanceBackups: restartedService, instanceBackupRoot: backupRoot }); instances.push(restarted);
    const persisted = await fetch(`${restarted.url}/api/instance/backups/health`, { headers: { authorization: "Bearer admin" } });
    assert.deepEqual(await persisted.json(), { status: "verified", createdAt: "2026-08-23T10:00:00.000Z",
      verifiedAt: "2026-08-23T10:05:00.000Z", schema: "stash.instance-backup.v1" });

    const created = await fetch(`${restarted.url}/api/instance/backups`, { method: "POST", headers: { authorization: "Bearer admin" } });
    assert.equal(created.status, 201); assert.equal((await created.json() as { status: string }).status, "created");
  });

  it("lets only an Instance Administrator list, dry-run, and explicitly confirm a restore", async () => {
    const root = await mkdtemp(join(tmpdir(), "stash-backup-administration-"));
    const backupRoot = join(root, "scheduled");
    const service = new InstanceBackupService(new FakeSource(), { masterKey, now: () => new Date("2026-08-23T10:00:00.000Z") });
    await service.create(join(backupRoot, "release-ready"));
    const target = new FakeRestoreTarget();
    const instance = await startInstance({ database: new Probe(), host: "127.0.0.1", port: 0,
      instanceAdminToken: "admin", instanceBackups: service, instanceBackupRoot: backupRoot, instanceBackupRestoreTarget: target });
    instances.push(instance);

    assert.equal((await fetch(`${instance.url}/api/instance/backups`)).status, 401);
    const headers = { authorization: "Bearer admin", "content-type": "application/json" };
    const listing = await fetch(`${instance.url}/api/instance/backups`, { headers });
    assert.equal(listing.status, 200);
    assert.deepEqual(await listing.json(), { backups: [{ name: "release-ready", createdAt: "2026-08-23T10:00:00.000Z",
      schema: "stash.instance-backup.v1", status: "readable", verifiedAt: "2026-08-23T10:00:00.000Z" }] });

    const dryRun = await fetch(`${instance.url}/api/instance/backups/release-ready/restore`, { method: "POST", headers,
      body: JSON.stringify({ dryRun: true }) });
    assert.equal(dryRun.status, 200); assert.deepEqual(await dryRun.json(), { status: "verified", backup: "release-ready" });
    assert.deepEqual(target.calls, ["configuration"]);

    const unconfirmed = await fetch(`${instance.url}/api/instance/backups/release-ready/restore`, { method: "POST", headers,
      body: JSON.stringify({ dryRun: false, confirmation: "wrong" }) });
    assert.equal(unconfirmed.status, 400); assert.deepEqual(target.calls, ["configuration"]);

    const restored = await fetch(`${instance.url}/api/instance/backups/release-ready/restore`, { method: "POST", headers,
      body: JSON.stringify({ dryRun: false, confirmation: "release-ready" }) });
    assert.equal(restored.status, 200); assert.deepEqual(await restored.json(), { status: "restored", backup: "release-ready" });
    assert.deepEqual(target.calls, ["configuration", "configuration", "prepare", "snapshot", "database", "commit", "discard"]);
    assert.equal((await fetch(`${instance.url}/api/instance/backups/health`, { headers })).status, 200);
    const restartGate = await fetch(`${instance.url}/api/client-session`, { headers });
    assert.equal(restartGate.status, 503); assert.equal((await restartGate.json() as { error: string }).error, "restore_restart_required");
  });

  it("returns actionable restore diagnostics without accepting path traversal", async () => {
    const root = await mkdtemp(join(tmpdir(), "stash-backup-diagnostics-")); const backupRoot = join(root, "scheduled");
    const service = new InstanceBackupService(new FakeSource(), { masterKey }); await service.create(join(backupRoot, "corrupt"));
    await mkdir(join(backupRoot, "missing-manifest"));
    await mkdir(join(backupRoot, "metadata-missing")); await writeFile(join(backupRoot, "metadata-missing", "manifest.json"), "{}");
    await writeFile(join(backupRoot, "corrupt", "database.dump"), "tampered");
    const instance = await startInstance({ database: new Probe(), host: "127.0.0.1", port: 0,
      instanceAdminToken: "admin", instanceBackups: service, instanceBackupRoot: backupRoot, instanceBackupRestoreTarget: new FakeRestoreTarget() });
    instances.push(instance); const headers = { authorization: "Bearer admin", "content-type": "application/json" };

    const listing = await fetch(`${instance.url}/api/instance/backups`, { headers });
    const candidates = (await listing.json() as { backups: Array<{ name: string; status: string }> }).backups;
    assert.equal(candidates.find(({ name }) => name === "missing-manifest")?.status, "invalid");
    assert.equal(candidates.find(({ name }) => name === "metadata-missing")?.status, "invalid");
    const malformed = await fetch(`${instance.url}/api/instance/backups/metadata-missing/restore`, { method: "POST", headers, body: JSON.stringify({ dryRun: true }) });
    assert.equal(malformed.status, 422); assert.deepEqual(await malformed.json(), { error: "invalid_manifest",
      message: "The backup manifest is missing or invalid. No Instance data was changed." });

    const corrupt = await fetch(`${instance.url}/api/instance/backups/corrupt/restore`, { method: "POST", headers, body: JSON.stringify({ dryRun: true }) });
    assert.equal(corrupt.status, 422); assert.deepEqual(await corrupt.json(), { error: "integrity_failed",
      message: "The backup payload does not match its signed manifest. No Instance data was changed." });
    const traversal = await fetch(`${instance.url}/api/instance/backups/%2e%2e/restore`, { method: "POST", headers, body: JSON.stringify({ dryRun: true }) });
    assert.equal(traversal.status, 404);
  });

  it("does not publish a partial backup when capture fails", async () => {
    const root = await mkdtemp(join(tmpdir(), "stash-backup-failure-"));
    const source = new FakeSource(); source.fail = new Error("database snapshot unavailable");
    const service = new InstanceBackupService(source, { masterKey });
    await assert.rejects(service.create(join(root, "backup")), /database snapshot unavailable/);
    assert.deepEqual(service.health(), { status: "failed", error: "backup_failed" });
    await assert.rejects(readFile(join(root, "backup", "manifest.json")));
  });
});
