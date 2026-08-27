import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";

import { InstanceBackupService, type InstanceBackupSource } from "../src/instance-backup.js";
import { startInstance, type RunningInstance } from "./support/start-test-instance.js";
import { InstanceUpgradeService, type InstanceUpgradeTarget, type UpgradeCheck } from "../src/instance-upgrade.js";
import { PostgresInstanceUpgradeTarget } from "../src/postgres-instance-upgrade.js";
import { readStashReleaseVersion } from "../src/release-version.js";

const masterKey = Buffer.alloc(32, 9).toString("base64");
class Source implements InstanceBackupSource {
  captures = 0;
  async captureDatabase(path: string) { this.captures += 1; await import("node:fs/promises").then(({ writeFile }) => writeFile(path, "before-upgrade")); }
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

  it("claims the upgrade before asynchronous preflight so concurrent callers cannot both mutate", async () => {
    const root = await mkdtemp(join(tmpdir(), "stash-upgrade-concurrent-")); const target = new Target(); target.fail = false; const source = new Source();
    const upgrades = new InstanceUpgradeService({ target, backups: new InstanceBackupService(source, { masterKey }), backupRoot: root, targetVersion: "0.2.0" });
    const [first, second] = await Promise.allSettled([upgrades.upgrade(), upgrades.upgrade()]);
    assert.equal(first.status, "fulfilled"); assert.equal(second.status, "rejected");
    if (second.status === "rejected") assert.match(String(second.reason), /already running/);
    assert.equal(source.captures, 1); assert.equal(target.applied, 1);
  });

  it("uses the release package version and executes the production PostgreSQL migration registry", async () => {
    assert.equal(await readStashReleaseVersion(), "0.1.0");
    let table = false; let version: string | undefined; let ended = 0; const statements: string[] = [];
    const query = async (sql: string, values?: unknown[]) => { statements.push(sql);
      if (sql === "SHOW server_version_num") return { rows: [{ server_version_num: "150000" }] };
      if (sql.includes("to_regclass")) return { rows: [{ table_name: table ? "stash_instance_format" : null }] };
      if (sql.startsWith("SELECT version")) return { rows: version ? [{ version }] : [] };
      if (sql.startsWith("CREATE TABLE stash_instance_format")) table = true;
      if (sql.startsWith("INSERT INTO stash_instance_format")) version = String(values?.[0]);
      return { rows: [] };
    };
    const database = { query, async connect() { return { query, release() {} }; }, async end() { ended += 1; } };
    const target = new PostgresInstanceUpgradeTarget("postgres://unused", async () => undefined, database as any);
    const before = await target.inspect("0.1.0"); assert.equal(before.currentVersion, "0.0.0"); assert.ok(before.checks.every((check) => check.status === "pass"));
    await target.apply("0.0.0", "0.1.0"); assert.equal(version, "0.1.0");
    assert.ok(statements.some((sql) => sql.startsWith("CREATE TABLE stash_instance_format")));
    const current = await target.inspect("0.1.0"); assert.equal(current.currentVersion, "0.1.0");
    const unsupported = await target.inspect("0.2.0"); assert.equal(unsupported.checks.find((check) => check.id === "migration_path")?.status, "fail");
    await target.close(); assert.equal(ended, 1);
  });
});
