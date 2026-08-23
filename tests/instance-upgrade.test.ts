import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";

import { InstanceBackupService, type InstanceBackupSource } from "../src/instance-backup.js";
import { startInstance, type RunningInstance } from "../src/instance.js";
import { InstanceUpgradeService, type InstanceUpgradeTarget, type UpgradeCheck } from "../src/instance-upgrade.js";

const masterKey = Buffer.alloc(32, 9).toString("base64");
class Source implements InstanceBackupSource {
  async captureDatabase(path: string) { await import("node:fs/promises").then(({ writeFile }) => writeFile(path, "before-upgrade")); }
  async captureAttachments() { return []; }
  async captureConfiguration() { return { publicOrigin: "https://stash.test", attachmentStorage: "local" }; }
}
class Target implements InstanceUpgradeTarget {
  current = "0.1.0"; applied = 0; rolledBack = 0; closed = 0; fail = true; checks: UpgradeCheck[] = [{ id: "database", status: "pass", message: "PostgreSQL is reachable." }];
  async inspect() { return { currentVersion: this.current, checks: this.checks }; }
  async apply() { this.applied += 1; if (this.fail) throw new Error("migration failed"); }
  async rollback() { this.rolledBack += 1; }
  async close() { this.closed += 1; }
}

describe("Instance upgrades", () => {
  const instances: RunningInstance[] = [];
  afterEach(async () => Promise.all(instances.splice(0).map((instance) => instance.close())));

  it("preflights and refuses mutation when a requirement is unmet", async () => {
    const root = await mkdtemp(join(tmpdir(), "stash-upgrade-blocked-")); const target = new Target();
    target.checks = [{ id: "disk", status: "fail", message: "Insufficient free space for a rollback-safe upgrade." }];
    const upgrades = new InstanceUpgradeService({ target, backups: new InstanceBackupService(new Source(), { masterKey }), backupRoot: root, targetVersion: "0.2.0" });
    const instance = await startInstance({ database: { async verifyConnection() {}, async close() {} }, host: "127.0.0.1", port: 0,
      instanceAdminToken: "admin", instanceUpgrades: upgrades }); instances.push(instance);
    const headers = { authorization: "Bearer admin", "content-type": "application/json" };
    assert.equal((await fetch(`${instance.url}/api/instance/upgrade`)).status, 401);
    const plan = await fetch(`${instance.url}/api/instance/upgrade`, { headers });
    assert.equal(plan.status, 200); assert.equal((await plan.json() as { status: string }).status, "blocked");
    const result = await fetch(`${instance.url}/api/instance/upgrade`, { method: "POST", headers, body: JSON.stringify({ confirmation: "0.2.0" }) });
    assert.equal(result.status, 409); assert.equal((await result.json() as { error: string }).error, "upgrade_preflight_failed");
    assert.equal(target.applied, 0);
  });

  it("creates a verified rollback point and restores it when migration fails", async () => {
    const root = await mkdtemp(join(tmpdir(), "stash-upgrade-rollback-")); const target = new Target();
    const upgrades = new InstanceUpgradeService({ target, backups: new InstanceBackupService(new Source(), { masterKey }), backupRoot: root, targetVersion: "0.2.0",
      now: () => new Date("2026-08-23T12:00:00.000Z") });
    const instance = await startInstance({ database: { async verifyConnection() {}, async close() {} }, host: "127.0.0.1", port: 0,
      instanceAdminToken: "admin", instanceUpgrades: upgrades }); instances.push(instance);
    const response = await fetch(`${instance.url}/api/instance/upgrade`, { method: "POST", headers: { authorization: "Bearer admin", "content-type": "application/json" },
      body: JSON.stringify({ confirmation: "0.2.0" }) });
    assert.equal(response.status, 503); assert.equal((await response.json() as { error: string }).error, "upgrade_failed_rolled_back");
    assert.equal(target.applied, 1); assert.equal(target.rolledBack, 1);
  });

  it("keeps readiness closed after a successful upgrade until restart", async () => {
    const root = await mkdtemp(join(tmpdir(), "stash-upgrade-success-")); const target = new Target(); target.fail = false;
    const upgrades = new InstanceUpgradeService({ target, backups: new InstanceBackupService(new Source(), { masterKey }), backupRoot: root, targetVersion: "0.2.0" });
    const instance = await startInstance({ database: { async verifyConnection() {}, async close() {} }, host: "127.0.0.1", port: 0,
      instanceAdminToken: "admin", instanceUpgrades: upgrades }); instances.push(instance);
    const response = await fetch(`${instance.url}/api/instance/upgrade`, { method: "POST", headers: { authorization: "Bearer admin", "content-type": "application/json" }, body: JSON.stringify({ confirmation: "0.2.0" }) });
    assert.equal(response.status, 200); assert.equal((await response.json() as { restartRequired: boolean }).restartRequired, true);
    const readiness = await fetch(`${instance.url}/health/ready`); assert.equal(readiness.status, 503);
    assert.equal((await readiness.json() as { error: string }).error, "upgrade_restart_required");
    assert.equal((await fetch(`${instance.url}/api/client-session`)).status, 503);
    await instance.close(); instances.splice(instances.indexOf(instance), 1); assert.equal(target.closed, 1);
  });
});
