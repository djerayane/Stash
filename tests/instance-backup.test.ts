import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";

import { InstanceBackupService, type InstanceBackupRestoreTarget, type InstanceBackupSource } from "../src/instance-backup.js";
import { startInstance, type DatabaseProbe, type RunningInstance } from "../src/instance.js";

const masterKey = Buffer.alloc(32, 7).toString("base64");

class FakeSource implements InstanceBackupSource {
  fail: Error | undefined;
  readonly calls: string[] = [];
  async captureDatabase(destination: string) {
    this.calls.push("database");
    if (this.fail) throw this.fail;
    await writeFile(destination, "database-with-identities-audit-and-encrypted-secrets");
  }
  async captureAttachments(destination: string) {
    this.calls.push("attachments");
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
  readonly calls: string[] = [];
  async validateConfiguration(configuration: Record<string, unknown>) { assert.equal(configuration.attachmentStorage, "local"); this.calls.push("configuration"); }
  async restoreDatabase(path: string) { assert.match(path, /database\.dump$/); this.calls.push("database"); }
  async restoreAttachments(path: string) { assert.match(path, /attachments$/); this.calls.push("attachments"); }
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
    assert.deepEqual(target.calls, ["configuration", "configuration", "database", "attachments"]);
  });

  it("publishes visible backup health only to the Instance Administrator", async () => {
    const root = await mkdtemp(join(tmpdir(), "stash-backup-health-"));
    const service = new InstanceBackupService(new FakeSource(), { masterKey, now: () => new Date("2026-08-23T10:00:00.000Z") });
    await service.create(join(root, "backup"));
    const instance = await startInstance({ database: new Probe(), host: "127.0.0.1", port: 0,
      instanceAdminToken: "admin", instanceBackups: service, instanceBackupRoot: join(root, "scheduled") });
    instances.push(instance);

    assert.equal((await fetch(`${instance.url}/api/instance/backups/health`)).status, 401);
    const response = await fetch(`${instance.url}/api/instance/backups/health`, { headers: { authorization: "Bearer admin" } });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { status: "verified", createdAt: "2026-08-23T10:00:00.000Z",
      verifiedAt: "2026-08-23T10:00:00.000Z", schema: "stash.instance-backup.v1" });

    const created = await fetch(`${instance.url}/api/instance/backups`, { method: "POST", headers: { authorization: "Bearer admin" } });
    assert.equal(created.status, 201);
    assert.equal((await created.json() as { status: string }).status, "created");
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
