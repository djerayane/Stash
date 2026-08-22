import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";

import { AccountRecoveryService, type AccountRecoveryRepository, type RecoveryCodeRecord, type PasskeyRecord, type EmailRecoveryRecord } from "../src/account-recovery.js";
import { PasswordAuthService, hashPassword, type AccountAuthenticationRecord, type PasswordAuthRepository, type SessionRecord } from "../src/password-auth.js";
import { startInstance, type DatabaseProbe, type RunningInstance } from "../src/instance.js";
import { createAuthenticationSecretCodec } from "../src/authentication-secrets.js";

class AuthDatabase implements DatabaseProbe, PasswordAuthRepository, AccountRecoveryRepository {
  account: AccountAuthenticationRecord | undefined;
  sessions = new Map<string, SessionRecord>();
  passkeys = new Map<string, PasskeyRecord>();
  codes: RecoveryCodeRecord[] = [];
  emailRecoveries = new Map<string, EmailRecoveryRecord>();
  async verifyConnection() {}
  async close() {}
  async findAccountByEmail(email: string) { return this.account?.email === email ? { ...this.account } : undefined; }
  async findAccountById(id: string) { return this.account?.id === id ? { ...this.account } : undefined; }
  async createSession(session: SessionRecord) { this.sessions.set(session.id, session); }
  async findSessionByTokenHash(hash: string) { return [...this.sessions.values()].find((s) => s.tokenHash === hash); }
  async listSessions(accountId: string) { return [...this.sessions.values()].filter((s) => s.accountId === accountId); }
  async deleteSession(accountId: string, id: string) { return !!this.sessions.get(id)?.accountId && this.sessions.delete(id); }
  async changePasswordAndDeleteOtherSessions() {}
  async savePasskey(record: PasskeyRecord) { this.passkeys.set(record.credentialId, record); }
  async findPasskey(id: string) { return this.passkeys.get(id); }
  async updatePasskeyCounter(id: string, previous: number, next: number) { const passkey = this.passkeys.get(id); if (!passkey || passkey.counter !== previous) return false; passkey.counter = next; return true; }
  async replaceRecoveryCodes(accountId: string, records: RecoveryCodeRecord[]) { this.codes = records.filter((r) => r.accountId === accountId); }
  async consumeRecoveryCode(accountId: string, lookup: string) { const index = this.codes.findIndex((r) => r.accountId === accountId && r.lookup === lookup); if (index < 0) return false; this.codes.splice(index, 1); return true; }
  async saveEmailRecovery(record: EmailRecoveryRecord) { this.emailRecoveries.set(record.tokenLookup, record); }
  async consumeEmailRecovery(lookup: string, now: string) { const record = this.emailRecoveries.get(lookup); if (!record || record.expiresAt <= now) return undefined; this.emailRecoveries.delete(lookup); return record.accountId; }
}

describe("Member account recovery on a running Stash Instance", () => {
  let instance: RunningInstance | undefined;
  afterEach(async () => { await instance?.close(); instance = undefined; });

  async function run(emailConfigured = true) {
    const database = new AuthDatabase();
    database.account = { id: "account-1", name: "Ada", email: "ada@example.com", passwordHash: await hashPassword("correct horse battery staple") };
    const delivered: string[] = [];
    const passwords = new PasswordAuthService(database);
    const secrets = createAuthenticationSecretCodec(Buffer.alloc(32, 9).toString("base64"));
    const recovery = new AccountRecoveryService(database, passwords, {
      passkeys: {
        registrationOptions(challenge, account) { return { challenge, rp: { id: "stash.test", name: "Stash" }, user: { id: account.id, name: account.email } }; },
        authenticationOptions(challenge) { return { challenge, rpId: "stash.test", userVerification: "required" }; },
        async register(challenge, input) { const data = clientData(input); if (data.challenge !== challenge || data.origin !== "https://stash.test" || data.type !== "webauthn.create") throw new Error(); return { credentialId: String(input.id), publicKey: "verified-cose-key", counter: 0 }; },
        async authenticate(challenge, input, passkey) { const data = clientData(input); if (data.challenge !== challenge || data.origin !== "https://stash.test" || data.type !== "webauthn.get" || input.proof !== "valid" || passkey.publicKey !== "verified-cose-key") throw new Error(); return { newCounter: passkey.counter + 1 }; },
      },
      secrets,
      ...(emailConfigured ? { email: { async sendRecovery(_address, token) { delivered.push(token); } } } : {}),
    });
    instance = await startInstance({ database, host: "127.0.0.1", port: 0, instanceAdminToken: "admin", passwordAuth: passwords, accountRecovery: recovery });
    const signedIn = await fetch(`${instance.url}/api/auth/sessions`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: "ada@example.com", password: "correct horse battery staple" }) });
    const session = await signedIn.json() as { token: string };
    return { database, delivered, baseUrl: instance.url, token: session.token };
  }

  it("registers a passkey and signs in after verifying its challenge", async () => {
    const { baseUrl, token } = await run();
    const options = await fetch(`${baseUrl}/api/auth/passkeys/options`, { method: "POST", headers: { authorization: `Bearer ${token}` } });
    const { challenge } = await options.json() as { challenge: string };
    const registration = browserCredential("phone-key", challenge, "webauthn.create");
    assert.equal((await fetch(`${baseUrl}/api/auth/passkeys`, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify(registration) })).status, 201);
    const signInOptions = await fetch(`${baseUrl}/api/auth/passkey-sessions/options`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: "ada@example.com" }) });
    const assertion = await signInOptions.json() as { challenge: string };
    const assertionBody = { ...browserCredential("phone-key", assertion.challenge, "webauthn.get"), proof: "valid" };
    const signedIn = await fetch(`${baseUrl}/api/auth/passkey-sessions`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(assertionBody) });
    assert.equal(signedIn.status, 201);
    assert.ok((await signedIn.json() as { token: string }).token);
    const replay = await fetch(`${baseUrl}/api/auth/passkey-sessions`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(assertionBody) });
    assert.equal(replay.status, 401);
  });

  it("rejects malformed and phishing-origin WebAuthn registrations without creating credentials", async () => {
    const { baseUrl, token, database } = await run();
    const options = await fetch(`${baseUrl}/api/auth/passkeys/options`, { method: "POST", headers: { authorization: `Bearer ${token}` } });
    const { challenge } = await options.json() as { challenge: string };
    const malformed = await fetch(`${baseUrl}/api/auth/passkeys`, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify({ id: "bad", response: { clientDataJSON: "not-json" } }) });
    assert.equal(malformed.status, 422);
    const fresh = await fetch(`${baseUrl}/api/auth/passkeys/options`, { method: "POST", headers: { authorization: `Bearer ${token}` } });
    const next = await fresh.json() as { challenge: string };
    const phishing = browserCredential("bad", next.challenge, "webauthn.create", "https://phishing.test");
    assert.equal((await fetch(`${baseUrl}/api/auth/passkeys`, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify(phishing) })).status, 422);
    assert.equal(database.passkeys.size, 0);
    void challenge;
  });

  it("issues recovery codes once, consumes one, and rejects reuse", async () => {
    const { baseUrl, token, database } = await run();
    const generated = await fetch(`${baseUrl}/api/auth/recovery-codes`, { method: "POST", headers: { authorization: `Bearer ${token}` } });
    const { codes } = await generated.json() as { codes: string[] };
    assert.equal(codes.length, 10);
    assert.ok(database.codes.every((record) => record.protectedSecret !== codes[0] && !record.lookup.includes(codes[0]!)));
    const recover = () => fetch(`${baseUrl}/api/auth/recovery-code-sessions`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: "ada@example.com", code: codes[0] }) });
    assert.equal((await recover()).status, 201);
    assert.equal((await recover()).status, 401);
  });

  it("uses configured email recovery without revealing account existence", async () => {
    const { baseUrl, delivered, database } = await run();
    for (const email of ["ada@example.com", "missing@example.com"]) {
      const response = await fetch(`${baseUrl}/api/auth/email-recovery`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email }) });
      assert.equal(response.status, 202);
    }
    assert.equal(delivered.length, 1);
    assert.ok([...database.emailRecoveries.values()].every((record) => record.protectedSecret !== delivered[0] && !record.tokenLookup.includes(delivered[0]!)));
    const recovered = await fetch(`${baseUrl}/api/auth/email-recovery-sessions`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token: delivered[0] }) });
    assert.equal(recovered.status, 201);
  });

  it("makes disabled email recovery and invalid recovery attempts visible", async () => {
    const { baseUrl } = await run(false);
    const unavailable = await fetch(`${baseUrl}/api/auth/email-recovery`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: "ada@example.com" }) });
    assert.equal(unavailable.status, 503);
    const invalid = await fetch(`${baseUrl}/api/auth/recovery-code-sessions`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: "ada@example.com", code: "invalid-code" }) });
    assert.equal(invalid.status, 401);
  });
});

function browserCredential(id: string, challenge: string, type: string, origin = "https://stash.test") {
  return { id, rawId: id, type: "public-key", response: { clientDataJSON: Buffer.from(JSON.stringify({ challenge, origin, type })).toString("base64url"), attestationObject: "fake", authenticatorData: "fake", signature: "fake" } };
}
function clientData(input: Record<string, unknown>) {
  const response = input.response as Record<string, unknown>;
  return JSON.parse(Buffer.from(String(response.clientDataJSON), "base64url").toString()) as { challenge: string; origin: string; type: string };
}
