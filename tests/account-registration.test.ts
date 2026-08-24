import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";

import { AccountRegistrationService, type RegistrationRecord } from "../src/account-registration.js";
import { startInstance, type RunningInstance } from "../src/instance.js";

class RegistrationRepository {
  readonly records: RegistrationRecord[] = [];
  failure?: Error;
  async createAccountWithPersonalWorkspaceAndSession(record: RegistrationRecord) {
    if (this.failure) throw this.failure;
    if (this.records.some(({ account }) => account.email === record.account.email)) return false;
    this.records.push(record); return true;
  }
}

describe("built-in account registration through a running Instance", () => {
  let instance: RunningInstance | undefined;
  afterEach(async () => { await instance?.close(); instance = undefined; });

  async function run(enabled = true, failures: Array<{ operation: string; cause: unknown }> = []) {
    const repository = new RegistrationRepository();
    instance = await startInstance({ database: { async verifyConnection() {}, async close() {} }, host: "127.0.0.1", port: 0,
      instanceAdminToken: "test-admin", ...(enabled ? { accountRegistration: new AccountRegistrationService(repository) } : {}),
      reportAuthenticationFailure: (event) => failures.push(event) });
    return { repository, baseUrl: instance.url };
  }

  const register = (baseUrl: string, email = "new@stash.test") => fetch(`${baseUrl}/api/auth/registration`, { method: "POST",
    headers: { "content-type": "application/json", "user-agent": "registration-test" },
    body: JSON.stringify({ name: "New Member", email, password: "correct horse battery staple" }) });

  it("advertises the configured state and atomically creates an account, personal Workspace, and session", async () => {
    const { repository, baseUrl } = await run();
    assert.deepEqual(await (await fetch(`${baseUrl}/api/auth/registration`)).json(), { enabled: true });
    const response = await register(baseUrl); assert.equal(response.status, 201);
    const body = await response.json() as { token: string; member: { email: string }; workspace: { id: string } };
    assert.ok(body.token.length >= 32); assert.equal(body.member.email, "new@stash.test"); assert.ok(body.workspace.id);
    assert.equal(repository.records.length, 1); assert.equal(repository.records[0]!.session.userAgent, "registration-test");
    assert.notEqual(repository.records[0]!.account.passwordHash, "correct horse battery staple");
  });

  it("keeps registration closed unless configured and rejects duplicates without replacing data", async () => {
    const closed = await run(false); assert.deepEqual(await (await fetch(`${closed.baseUrl}/api/auth/registration`)).json(), { enabled: false });
    assert.equal((await register(closed.baseUrl)).status, 403); await instance!.close(); instance = undefined;
    const open = await run(); assert.equal((await register(open.baseUrl)).status, 201); assert.equal((await register(open.baseUrl)).status, 409);
    assert.equal(open.repository.records.length, 1);
  });

  it("distinguishes invalid input from infrastructure failures and reports only operation context", async () => {
    const failures: Array<{ operation: string; cause: unknown }> = []; const { repository, baseUrl } = await run(true, failures);
    const invalid = await fetch(`${baseUrl}/api/auth/registration`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "", email: "bad", password: "short" }) });
    assert.equal(invalid.status, 422); assert.equal(failures.length, 0);
    repository.failure = new Error("postgres://member:secret@database/stash"); const unavailable = await register(baseUrl, "other@stash.test");
    assert.equal(unavailable.status, 503); assert.deepEqual(failures.map(({ operation }) => operation), ["registration"]);
    assert.doesNotMatch(await unavailable.text(), /postgres|secret|password/i);
  });
});
