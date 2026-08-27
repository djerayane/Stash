import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { after, describe, it } from "node:test";
import { Pool } from "pg";

import { AccountRegistrationService } from "../src/account-registration.js";
import { createAuthenticationSecretCodec } from "../src/authentication-secrets.js";
import { startInstance, type RunningInstance } from "./support/start-test-instance.js";
import { PasswordAuthService } from "../src/password-auth.js";
import { PostgresDatabase } from "../src/postgres-database.js";

const databaseUrl = process.env.STASH_TEST_DATABASE_URL;

describe("PostgreSQL built-in account registration", { skip: !databaseUrl }, () => {
  let database: PostgresDatabase; let instance: RunningInstance; let admin: Pool; let schema: string;
  after(async () => { if (instance) await instance.close(); else await database?.close();
    if (admin) { await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`); await admin.end(); } });

  it("atomically persists encrypted account, Workspace, and session state and resolves it immediately", async () => {
    admin = new Pool({ connectionString: databaseUrl! }); schema = `account_registration_${randomUUID().replaceAll("-", "")}`;
    await admin.query(`CREATE SCHEMA ${schema}`); const scopedUrl = new URL(databaseUrl!); scopedUrl.searchParams.set("options", `-csearch_path=${schema}`);
    database = new PostgresDatabase(scopedUrl.toString(), createAuthenticationSecretCodec(randomBytes(32).toString("base64")));
    const repositories = database.identityAccessRepositories();
    const passwords = new PasswordAuthService(repositories); instance = await startInstance({ database, host: "127.0.0.1", port: 0,
      instanceAdminToken: "test-admin", passwordAuth: passwords, accountRegistration: new AccountRegistrationService(repositories) });
    const input = { name: "Postgres Member", email: `member-${randomUUID()}@stash.test`, password: "correct horse battery staple" };
    const response = await fetch(`${instance.url}/api/auth/registration`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(input) });
    assert.equal(response.status, 201); const body = await response.json() as { token: string; member: { id: string }; workspace: { id: string } };
    const clientSession = await fetch(`${instance.url}/api/client-session`, { headers: { authorization: `Bearer ${body.token}` } });
    assert.equal(clientSession.status, 200); assert.equal((await clientSession.json() as any).workspace.id, body.workspace.id);

    const inspection = new Pool({ connectionString: scopedUrl.toString() });
    const account = (await inspection.query("SELECT password_hash FROM stash_accounts WHERE id=$1", [body.member.id])).rows[0];
    const session = (await inspection.query("SELECT token_lookup,token_hash FROM stash_sessions WHERE account_id=$1", [body.member.id])).rows[0];
    assert.doesNotMatch(account.password_hash, /correct horse|scrypt\$/); assert.notEqual(session.token_hash, createHash("sha256").update(body.token).digest("base64"));
    assert.notEqual(session.token_lookup, body.token); const before = await inspection.query("SELECT (SELECT count(*) FROM stash_accounts) accounts,(SELECT count(*) FROM stash_workspaces) workspaces,(SELECT count(*) FROM stash_sessions) sessions");
    const duplicate = await fetch(`${instance.url}/api/auth/registration`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(input) });
    assert.equal(duplicate.status, 409); const afterDuplicate = await inspection.query("SELECT (SELECT count(*) FROM stash_accounts) accounts,(SELECT count(*) FROM stash_workspaces) workspaces,(SELECT count(*) FROM stash_sessions) sessions");
    assert.deepEqual(afterDuplicate.rows, before.rows);

    const failingEmail = `rollback-${randomUUID()}@stash.test`;
    await inspection.query(`CREATE FUNCTION fail_registration_session_insert() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'injected registration session failure'; END $$`);
    await inspection.query(`CREATE TRIGGER fail_registration_session_insert AFTER INSERT ON stash_sessions
      FOR EACH ROW EXECUTE FUNCTION fail_registration_session_insert()`);
    try {
      const failed = await fetch(`${instance.url}/api/auth/registration`, { method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "Rollback Member", email: failingEmail, password: "correct horse battery staple" }) });
      assert.equal(failed.status, 503);
      const rollback = await inspection.query(`SELECT
        (SELECT count(*) FROM stash_accounts WHERE email=$1) accounts,
        (SELECT count(*) FROM stash_workspaces WHERE name='Rollback Member''s Workspace') workspaces,
        (SELECT count(*) FROM stash_sessions session JOIN stash_accounts account ON account.id=session.account_id WHERE account.email=$1) sessions,
        (SELECT count(*) FROM stash_portable_projection_outbox WHERE payload->'owner'->'identity'->>'displayName'='Rollback Member') projections`, [failingEmail]);
      assert.deepEqual(rollback.rows[0], { accounts: "0", workspaces: "0", sessions: "0", projections: "0" });
    } finally {
      await inspection.query("DROP TRIGGER IF EXISTS fail_registration_session_insert ON stash_sessions");
      await inspection.query("DROP FUNCTION IF EXISTS fail_registration_session_insert()");
    }
    await inspection.end();
  });
});
