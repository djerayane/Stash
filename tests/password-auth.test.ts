import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";

import {
  PasswordAuthService,
  hashPassword,
  type AccountAuthenticationRecord,
  type PasswordAuthRepository,
  type SessionRecord,
} from "../src/password-auth.js";
import { startInstance, type DatabaseProbe, type RunningInstance } from "../src/instance.js";
import type { PasswordHashCodec } from "../src/password-hash.js";

class ProtocolCompatibleAuthDatabase implements DatabaseProbe, PasswordAuthRepository {
  account: AccountAuthenticationRecord | undefined;
  readonly sessions = new Map<string, SessionRecord>();
  failure: Error | undefined;
  sessionListCalls = 0;

  async verifyConnection(): Promise<void> {}
  async close(): Promise<void> {}
  async findAccountByEmail(email: string) {
    if (this.failure) throw this.failure;
    return this.account?.email === email ? { ...this.account } : undefined;
  }
  async findAccountById(id: string) {
    return this.account?.id === id ? { ...this.account } : undefined;
  }
  async createSession(session: SessionRecord) {
    if (this.failure) throw this.failure;
    this.sessions.set(session.id, { ...session });
  }
  async findSessionByTokenHash(tokenHash: string) {
    const session = [...this.sessions.values()].find((candidate) => candidate.tokenHash === tokenHash);
    return session ? { ...session } : undefined;
  }
  async listSessions(accountId: string) {
    this.sessionListCalls += 1;
    return [...this.sessions.values()].filter((session) => session.accountId === accountId);
  }
  async deleteSession(accountId: string, sessionId: string) {
    const session = this.sessions.get(sessionId);
    if (!session || session.accountId !== accountId) return false;
    return this.sessions.delete(sessionId);
  }
  async changePasswordAndDeleteOtherSessions(accountId: string, sessionId: string, passwordHash: string) {
    if (!this.account || this.account.id !== accountId) return;
    this.account.passwordHash = passwordHash;
    for (const session of this.sessions.values()) {
      if (session.accountId === accountId && session.id !== sessionId) this.sessions.delete(session.id);
    }
  }
}

describe("built-in password authentication on a running Stash Instance", () => {
  let instance: RunningInstance | undefined;

  afterEach(async () => {
    await instance?.close();
    instance = undefined;
  });

  async function run() {
    const database = new ProtocolCompatibleAuthDatabase();
    const reportedFailures: Array<{ operation: string; cause: unknown }> = [];
    database.account = {
      id: "account-1",
      name: "Ada Lovelace",
      email: "ada@example.com",
      passwordHash: await hashPassword("correct horse battery staple"),
    };
    instance = await startInstance({
      database,
      host: "127.0.0.1",
      port: 0,
      instanceAdminToken: "test-instance-admin-token",
      passwordAuth: new PasswordAuthService(database),
      reportAuthenticationFailure: (event) => reportedFailures.push(event),
    });
    return { database, baseUrl: instance.url, reportedFailures };
  }

  async function signIn(baseUrl: string, password = "correct horse battery staple") {
    return fetch(`${baseUrl}/api/auth/sessions`, {
      method: "POST",
      headers: { "content-type": "application/json", "user-agent": "Stash acceptance test" },
      body: JSON.stringify({ email: "ada@example.com", password }),
    });
  }

  it("signs a Member in and exposes only their own manageable session", async () => {
    const { baseUrl } = await run();
    const response = await signIn(baseUrl);
    assert.equal(response.status, 201);
    const signedIn = await response.json() as { token: string; member: { email: string }; session: { id: string } };
    assert.equal(signedIn.member.email, "ada@example.com");
    assert.ok(signedIn.token.length >= 32);

    const sessions = await fetch(`${baseUrl}/api/auth/sessions`, {
      headers: { authorization: `Bearer ${signedIn.token}` },
    });
    assert.equal(sessions.status, 200);
    const body = await sessions.json() as { sessions: Array<{ id: string; current: boolean; tokenHash?: string }> };
    assert.deepEqual(body.sessions.map(({ id, current }) => ({ id, current })), [
      { id: signedIn.session.id, current: true },
    ]);
    assert.equal("tokenHash" in body.sessions[0]!, false);
  });

  it("rejects invalid credentials without revealing whether an account exists", async () => {
    const { baseUrl } = await run();
    const wrongPassword = await signIn(baseUrl, "wrong password value");
    const missingAccount = await fetch(`${baseUrl}/api/auth/sessions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "missing@example.com", password: "wrong password value" }),
    });
    assert.equal(wrongPassword.status, 401);
    assert.equal(missingAccount.status, 401);
    assert.deepEqual(await wrongPassword.json(), await missingAccount.json());
  });

  it("does not treat integration personal tokens as Member sessions", async () => {
    const database = new ProtocolCompatibleAuthDatabase() as ProtocolCompatibleAuthDatabase & {
      findPersonalAccessTokenByTokenHash(): Promise<{ id: string; accountId: string }>;
    };
    database.findPersonalAccessTokenByTokenHash = async () => ({ id: "integration-token", accountId: "account-1" });
    const service = new PasswordAuthService(database);

    assert.equal(await service.authenticateBearer("Bearer github-personal-token"), undefined);
  });

  it("performs password-verification work even when the email is unknown", async () => {
    const database = new ProtocolCompatibleAuthDatabase();
    const checkedHashes: string[] = [];
    const passwords: PasswordHashCodec = {
      async hash() { return "unused"; },
      async matches(_password, encoded) { checkedHashes.push(encoded); return false; },
    };
    const service = new PasswordAuthService(database, passwords);

    await assert.rejects(
      service.signIn({ email: "missing@example.com", password: "long enough password" }),
      { name: "Error" },
    );
    assert.equal(checkedHashes.length, 1);
    assert.match(checkedHashes[0]!, /^scrypt\$/);
  });

  it("signs out and lets a Member revoke another session", async () => {
    const { baseUrl } = await run();
    const first = await (await signIn(baseUrl)).json() as { token: string; session: { id: string } };
    const second = await (await signIn(baseUrl)).json() as { token: string; session: { id: string } };

    const revoke = await fetch(`${baseUrl}/api/auth/sessions/${first.session.id}`, {
      method: "DELETE",
      headers: { authorization: `Bearer ${second.token}` },
    });
    assert.equal(revoke.status, 204);
    assert.equal((await fetch(`${baseUrl}/api/auth/sessions`, { headers: { authorization: `Bearer ${first.token}` } })).status, 401);

    const signOut = await fetch(`${baseUrl}/api/auth/session`, {
      method: "DELETE",
      headers: { authorization: `Bearer ${second.token}` },
    });
    assert.equal(signOut.status, 204);
    assert.equal((await fetch(`${baseUrl}/api/auth/sessions`, { headers: { authorization: `Bearer ${second.token}` } })).status, 401);
  });

  it("changes the password, keeps the current session, and revokes other sessions", async () => {
    const { baseUrl, database } = await run();
    const other = await (await signIn(baseUrl)).json() as { token: string };
    const current = await (await signIn(baseUrl)).json() as { token: string };
    const changed = await fetch(`${baseUrl}/api/auth/password`, {
      method: "PUT",
      headers: { authorization: `Bearer ${current.token}`, "content-type": "application/json" },
      body: JSON.stringify({ currentPassword: "correct horse battery staple", newPassword: "a newer correct horse battery staple" }),
    });
    assert.equal(changed.status, 204);
    assert.equal(database.sessionListCalls, 1);
    assert.equal((await fetch(`${baseUrl}/api/auth/sessions`, { headers: { authorization: `Bearer ${other.token}` } })).status, 401);
    assert.equal((await signIn(baseUrl)).status, 401);
    assert.equal((await signIn(baseUrl, "a newer correct horse battery staple")).status, 201);
  });

  it("makes invalid input and recoverable persistence failures visible without leaking secrets", async () => {
    const { baseUrl, database, reportedFailures } = await run();
    const invalid = await fetch(`${baseUrl}/api/auth/sessions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "not-email", password: "short" }),
    });
    assert.equal(invalid.status, 422);

    database.failure = new Error("postgres://stash:secret@database/stash");
    const failed = await signIn(baseUrl);
    assert.equal(failed.status, 503);
    const text = await failed.text();
    assert.doesNotMatch(text, /postgres|secret|correct horse/i);
    assert.deepEqual(reportedFailures.map(({ operation }) => operation), ["password_sign_in"]);
  });
});
