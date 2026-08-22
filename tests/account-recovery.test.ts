import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";

import { AccountRecoveryService, type AccountRecoveryRepository, type RecoveryCodeRecord, type PasskeyRecord, type EmailRecoveryRecord, type EmailRecoveryDeliveryJob } from "../src/account-recovery.js";
import { PasswordAuthService, hashPassword, type AccountAuthenticationRecord, type PasswordAuthRepository, type SessionRecord } from "../src/password-auth.js";
import { startInstance, type DatabaseProbe, type RunningInstance } from "../src/instance.js";
import { createAuthenticationSecretCodec } from "../src/authentication-secrets.js";
import { EmailRecoveryWorker } from "../src/email-recovery-worker.js";

class AuthDatabase implements DatabaseProbe, PasswordAuthRepository, AccountRecoveryRepository {
  account: AccountAuthenticationRecord | undefined;
  sessions = new Map<string, SessionRecord>();
  passkeys = new Map<string, PasskeyRecord>();
  codes: RecoveryCodeRecord[] = [];
  emailRecoveries = new Map<string, EmailRecoveryRecord>();
  emailJobs = new Map<string, EmailRecoveryDeliveryJob>();
  deliveryFailures = new Map<string, string>();
  recoveryRequestWork = 0;
  recoverySignInWork = 0;
  sessionFailures = 0;
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
  async updatePasskeyCounterAndCreateSession(id: string, previous: number, next: number, session: SessionRecord) { const passkey = this.passkeys.get(id); if (!passkey || passkey.counter !== previous) return false; return this.commitSession(session, () => { passkey.counter = next; }); }
  async replaceRecoveryCodes(accountId: string, records: RecoveryCodeRecord[]) { this.codes = records.filter((r) => r.accountId === accountId); }
  async consumeRecoveryCodeAndCreateSession(accountId: string, lookup: string, session?: SessionRecord) { this.recoverySignInWork += 1; const index = this.codes.findIndex((r) => r.accountId === accountId && r.lookup === lookup); if (index < 0 || !session) return false; return this.commitSession(session, () => { this.codes.splice(index, 1); }); }
  async enqueueEmailRecovery(job: EmailRecoveryDeliveryJob) { this.recoveryRequestWork += 1; this.emailJobs.set(job.id, job); }
  async claimEmailRecoveryDelivery(owner: string, _leaseUntil: string) { const job = [...this.emailJobs.values()].find((candidate) => !candidate.claimOwner); if (!job) return undefined; job.claimOwner = owner; job.claimVersion = (job.claimVersion ?? 0) + 1; return { ...job }; }
  async renewEmailRecoveryDelivery(id: string, owner: string, version: number, _leaseUntil: string) { const job = this.emailJobs.get(id); return job?.claimOwner === owner && job.claimVersion === version; }
  async completeEmailRecoveryDelivery(id: string, owner: string, version: number, activation?: EmailRecoveryRecord) { const job = this.emailJobs.get(id); if (job?.claimOwner !== owner || job.claimVersion !== version) return false; this.emailJobs.delete(id); this.deliveryFailures.delete(id); if (activation) this.emailRecoveries.set(activation.tokenLookup, activation); return true; }
  async retryEmailRecoveryDelivery(id: string, owner: string, version: number, reason: string) { const job = this.emailJobs.get(id); if (job?.claimOwner !== owner || job.claimVersion !== version) return false; delete job.claimOwner; this.deliveryFailures.set(id, reason); return true; }
  async findEmailRecoveryAccount(lookup: string, now: string) { const record = this.emailRecoveries.get(lookup); return record && record.expiresAt > now ? record.accountId : undefined; }
  async consumeEmailRecoveryAndCreateSession(lookup: string, now: string, session: SessionRecord) { const record = this.emailRecoveries.get(lookup); if (!record || record.accountId !== session.accountId || record.expiresAt <= now) return false; return this.commitSession(session, () => { this.emailRecoveries.delete(lookup); }); }
  private async commitSession(session: SessionRecord, mutation: () => void) { if (this.sessionFailures > 0) { this.sessionFailures -= 1; throw new Error("session write failed"); } mutation(); this.sessions.set(session.id, session); return true; }
}

describe("Member account recovery on a running Stash Instance", () => {
  let instance: RunningInstance | undefined;
  afterEach(async () => { await instance?.close(); instance = undefined; });

  async function run(emailConfigured = true, deliver?: (address: string, token: string) => Promise<void>) {
    const database = new AuthDatabase();
    database.account = { id: "account-1", name: "Ada", email: "ada@example.com", passwordHash: await hashPassword("correct horse battery staple") };
    const delivered: string[] = [];
    const passwords = new PasswordAuthService(database);
    const secrets = createAuthenticationSecretCodec(Buffer.alloc(32, 9).toString("base64"));
    const email = emailConfigured ? { async deliver(address: string, token: string) { if (deliver) await deliver(address, token); else delivered.push(token); } } : undefined;
    const recovery = new AccountRecoveryService(database, passwords, {
      passkeys: {
        registrationOptions(challenge, account) { return { challenge, rp: { id: "stash.test", name: "Stash" }, user: { id: account.id, name: account.email } }; },
        authenticationOptions(challenge) { return { challenge, rpId: "stash.test", userVerification: "required" }; },
        async register(challenge, input) { const data = clientData(input); if (data.challenge !== challenge || data.origin !== "https://stash.test" || data.type !== "webauthn.create") throw new Error(); return { credentialId: String(input.id), publicKey: "verified-cose-key", counter: 0 }; },
        async authenticate(challenge, input, passkey) { const data = clientData(input); if (data.challenge !== challenge || data.origin !== "https://stash.test" || data.type !== "webauthn.get" || input.proof !== "valid" || passkey.publicKey !== "verified-cose-key") throw new Error(); return { newCounter: passkey.counter + 1 }; },
      },
      secrets,
      ...(email ? { email } : {}),
    });
    instance = await startInstance({ database, host: "127.0.0.1", port: 0, instanceAdminToken: "admin", passwordAuth: passwords, accountRecovery: recovery });
    const signedIn = await fetch(`${instance.url}/api/auth/sessions`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: "ada@example.com", password: "correct horse battery staple" }) });
    const session = await signedIn.json() as { token: string };
    return { database, delivered, baseUrl: instance.url, token: session.token, secrets, email, ...(email ? { worker: new EmailRecoveryWorker(database, secrets, email) } : {}) };
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

  it("keeps a passkey usable when atomic counter and session creation fails", async () => {
    const { baseUrl, token, database } = await run();
    const registrationOptions = await (await fetch(`${baseUrl}/api/auth/passkeys/options`, { method: "POST", headers: { authorization: `Bearer ${token}` } })).json() as { challenge: string };
    await fetch(`${baseUrl}/api/auth/passkeys`, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify(browserCredential("phone-key", registrationOptions.challenge, "webauthn.create")) });
    database.sessionFailures = 1;
    const authenticate = async () => {
      const options = await (await fetch(`${baseUrl}/api/auth/passkey-sessions/options`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: "ada@example.com" }) })).json() as { challenge: string };
      return fetch(`${baseUrl}/api/auth/passkey-sessions`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ...browserCredential("phone-key", options.challenge, "webauthn.get"), proof: "valid" }) });
    };
    assert.equal((await authenticate()).status, 503);
    assert.equal(database.passkeys.get("phone-key")?.counter, 0);
    assert.equal((await authenticate()).status, 201);
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

  it("keeps a recovery code usable when atomic session creation fails", async () => {
    const { baseUrl, token, database } = await run();
    const { codes } = await (await fetch(`${baseUrl}/api/auth/recovery-codes`, { method: "POST", headers: { authorization: `Bearer ${token}` } })).json() as { codes: string[] };
    database.sessionFailures = 1;
    const recover = () => fetch(`${baseUrl}/api/auth/recovery-code-sessions`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: "ada@example.com", code: codes[0] }) });
    assert.equal((await recover()).status, 503);
    assert.equal((await recover()).status, 201);
  });

  it("uses configured email recovery without revealing account existence", async () => {
    const { baseUrl, delivered, database, worker } = await run();
    for (const email of ["ada@example.com", "missing@example.com"]) {
      const response = await fetch(`${baseUrl}/api/auth/email-recovery`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email }) });
      assert.equal(response.status, 202);
    }
    assert.equal(delivered.length, 0);
    assert.equal(database.recoveryRequestWork, 2);
    assert.equal(await worker!.processNext(), "delivered");
    assert.equal(await worker!.processNext(), "dummy_completed");
    assert.equal(delivered.length, 1);
    assert.ok([...database.emailRecoveries.values()].every((record) => record.protectedSecret !== delivered[0] && !record.tokenLookup.includes(delivered[0]!)));
    const recovered = await fetch(`${baseUrl}/api/auth/email-recovery-sessions`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token: delivered[0] }) });
    assert.equal(recovered.status, 201);
  });

  it("keeps an email token usable when atomic session creation fails", async () => {
    const { baseUrl, delivered, database, worker } = await run();
    await fetch(`${baseUrl}/api/auth/email-recovery`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: "ada@example.com" }) });
    await worker!.processNext();
    database.sessionFailures = 1;
    const recover = () => fetch(`${baseUrl}/api/auth/email-recovery-sessions`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token: delivered[0] }) });
    assert.equal((await recover()).status, 503);
    assert.equal((await recover()).status, 201);
  });

  it("activates the recovery window when delayed delivery succeeds, not when requested", async () => {
    const requestedAt = Date.now();
    const deliveredAt = requestedAt + 20 * 60_000;
    const { baseUrl, database, secrets, email } = await run();
    await fetch(`${baseUrl}/api/auth/email-recovery`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: "ada@example.com" }) });
    assert.equal(database.emailRecoveries.size, 0);
    const delayedWorker = new EmailRecoveryWorker(database, secrets, email!, 30_000, () => deliveredAt);
    assert.equal(await delayedWorker.processNext(), "delivered");
    const recovery = [...database.emailRecoveries.values()][0]!;
    assert.equal(Date.parse(recovery.expiresAt), deliveredAt + 15 * 60_000);
    assert.ok(Date.parse(recovery.expiresAt) > requestedAt + 15 * 60_000);
  });

  it("returns after local email queueing without waiting for SMTP and leaves failures retryable", async () => {
    let releaseDelivery!: () => void;
    const blocked = new Promise<void>((resolve) => { releaseDelivery = resolve; });
    const { baseUrl, database, worker } = await run(true, async () => blocked);
    const response = await fetch(`${baseUrl}/api/auth/email-recovery`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: "ada@example.com" }) });
    assert.equal(response.status, 202);
    const processing = worker!.processNext();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(database.emailJobs.size, 1);
    releaseDelivery();
    assert.equal(await processing, "delivered");

    await instance?.close();
    instance = undefined;
    const failing = await run(true, async () => { throw new Error("smtp temporarily unavailable"); });
    await fetch(`${failing.baseUrl}/api/auth/email-recovery`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: "ada@example.com" }) });
    assert.equal(await failing.worker!.processNext(), "retry_scheduled");
    assert.equal(failing.database.emailJobs.size, 1);
    assert.match([...failing.database.deliveryFailures.values()][0] ?? "", /temporarily unavailable/);
  });

  it("allows only one worker to actively send a slow delivery", async () => {
    let activeSends = 0;
    let maximumActiveSends = 0;
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    const { baseUrl, database, secrets, email } = await run(true, async () => {
      activeSends += 1;
      maximumActiveSends = Math.max(maximumActiveSends, activeSends);
      await blocked;
      activeSends -= 1;
    });
    await fetch(`${baseUrl}/api/auth/email-recovery`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: "ada@example.com" }) });
    const first = new EmailRecoveryWorker(database, secrets, email!, 60).processNext();
    await new Promise((resolve) => setImmediate(resolve));
    const second = await new EmailRecoveryWorker(database, secrets, email!, 60).processNext();
    assert.equal(second, "idle");
    assert.equal(maximumActiveSends, 1);
    release();
    assert.equal(await first, "delivered");
    assert.equal(database.emailJobs.size, 0);
  });

  it("makes disabled email recovery and invalid recovery attempts visible", async () => {
    const { baseUrl } = await run(false);
    const unavailable = await fetch(`${baseUrl}/api/auth/email-recovery`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: "ada@example.com" }) });
    assert.equal(unavailable.status, 503);
    const invalid = await fetch(`${baseUrl}/api/auth/recovery-code-sessions`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: "ada@example.com", code: "invalid-code" }) });
    assert.equal(invalid.status, 401);
  });

  it("performs the same recovery-code repository work for known and unknown accounts", async () => {
    const { baseUrl, database } = await run();
    const attempt = (email: string) => fetch(`${baseUrl}/api/auth/recovery-code-sessions`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email, code: "invalid-recovery-code" }) });
    const known = await attempt("ada@example.com");
    const missing = await attempt("missing@example.com");
    assert.equal(known.status, 401);
    assert.deepEqual(await known.json(), await missing.json());
    assert.equal(database.recoverySignInWork, 2);
  });
});

function browserCredential(id: string, challenge: string, type: string, origin = "https://stash.test") {
  return { id, rawId: id, type: "public-key", response: { clientDataJSON: Buffer.from(JSON.stringify({ challenge, origin, type })).toString("base64url"), attestationObject: "fake", authenticatorData: "fake", signature: "fake" } };
}
function clientData(input: Record<string, unknown>) {
  const response = input.response as Record<string, unknown>;
  return JSON.parse(Buffer.from(String(response.clientDataJSON), "base64url").toString()) as { challenge: string; origin: string; type: string };
}
