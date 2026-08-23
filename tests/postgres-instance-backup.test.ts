import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { Client } from "pg";

import { InstanceBackupService } from "../src/instance-backup.js";
import { PostgresLocalInstanceBackupSource, PostgresLocalInstanceRestoreTarget } from "../src/instance-backup-system.js";

const configuredUrl = process.env.STASH_TEST_DATABASE_URL;

describe("PostgreSQL and filesystem Instance Backup disaster-recovery drill", { skip: !configuredUrl }, () => {
  const databaseName = `stash_backup_${randomUUID().replaceAll("-", "")}`;
  let databaseUrl = ""; let administratorUrl = ""; let root = "";

  before(async () => {
    const configured = new URL(configuredUrl!);
    const admin = new URL(configured); admin.pathname = "/postgres"; administratorUrl = admin.toString();
    const target = new URL(configured); target.pathname = `/${databaseName}`; databaseUrl = target.toString();
    const client = new Client({ connectionString: administratorUrl }); await client.connect();
    try { await client.query(`CREATE DATABASE ${databaseName}`); } finally { await client.end(); }
    root = await mkdtemp(join(tmpdir(), "stash-postgres-backup-"));
  });

  after(async () => {
    const client = new Client({ connectionString: administratorUrl }); await client.connect();
    try { await client.query(`DROP DATABASE IF EXISTS ${databaseName} WITH (FORCE)`); } finally { await client.end(); }
    await rm(root, { recursive: true, force: true });
  });

  it("restores accounts, identity links, Activity, encrypted integration state, and Attachment bytes exactly", async () => {
    const attachments = join(root, "attachments");
    const attachmentPath = join(attachments, "workspace", "attachment");
    await mkdir(join(attachments, "workspace"), { recursive: true });
    const originalAttachment = Buffer.from([0, 1, 2, 3, 254, 255]); await writeFile(attachmentPath, originalAttachment);
    const client = new Client({ connectionString: databaseUrl }); await client.connect();
    try {
      await client.query(`CREATE TABLE accounts (id text PRIMARY KEY, email text NOT NULL);
        CREATE TABLE identity_links (provider text NOT NULL, subject text NOT NULL, account_id text NOT NULL);
        CREATE TABLE activity (id text PRIMARY KEY, actor_id text NOT NULL, action text NOT NULL);
        CREATE TABLE repository_connections (id text PRIMARY KEY, encrypted_credential text NOT NULL)`);
      await client.query("INSERT INTO accounts VALUES ('account-1','ada@example.test'); INSERT INTO identity_links VALUES ('oidc','subject-1','account-1'); INSERT INTO activity VALUES ('activity-1','account-1','note_restored'); INSERT INTO repository_connections VALUES ('connection-1','v1.nonce.tag.ciphertext')");
    } finally { await client.end(); }

    const source = new PostgresLocalInstanceBackupSource({ databaseUrl, attachmentRoot: attachments, publicOrigin: "https://stash.example" });
    const service = new InstanceBackupService(source, { masterKey: Buffer.alloc(32, 9).toString("base64") });
    const backup = join(root, "backups", "drill"); await service.create(backup);

    const mutated = new Client({ connectionString: databaseUrl }); await mutated.connect();
    try { await mutated.query("DELETE FROM identity_links; DELETE FROM activity; UPDATE accounts SET email='wrong@example.test'; UPDATE repository_connections SET encrypted_credential='corrupt'"); }
    finally { await mutated.end(); }
    await writeFile(attachmentPath, "wrong");

    const target = new PostgresLocalInstanceRestoreTarget({ databaseUrl, attachmentRoot: attachments, publicOrigin: "https://stash.example" });
    assert.deepEqual(await service.restore(backup, target, { dryRun: true }), { status: "verified" });
    assert.deepEqual(await service.restore(backup, target, { dryRun: false }), { status: "restored" });

    const restored = new Client({ connectionString: databaseUrl }); await restored.connect();
    try {
      assert.deepEqual((await restored.query("SELECT * FROM accounts")).rows, [{ id: "account-1", email: "ada@example.test" }]);
      assert.deepEqual((await restored.query("SELECT * FROM identity_links")).rows, [{ provider: "oidc", subject: "subject-1", account_id: "account-1" }]);
      assert.deepEqual((await restored.query("SELECT * FROM activity")).rows, [{ id: "activity-1", actor_id: "account-1", action: "note_restored" }]);
      assert.deepEqual((await restored.query("SELECT * FROM repository_connections")).rows, [{ id: "connection-1", encrypted_credential: "v1.nonce.tag.ciphertext" }]);
    } finally { await restored.end(); }
    assert.deepEqual(await readFile(attachmentPath), originalAttachment);
  });
});
