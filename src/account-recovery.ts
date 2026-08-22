import { createHash, randomBytes } from "node:crypto";
import type { AuthenticationSecretCodec } from "./authentication-secrets.js";
import type { AccountAuthenticationRecord, AuthenticatedMember, PasswordAuthService } from "./password-auth.js";

export interface PasskeyRecord { credentialId: string; accountId: string; publicKey: string; counter: number; transports?: string[]; createdAt: string }
export interface RecoveryCodeRecord { accountId: string; lookup: string; protectedSecret: string }
export interface EmailRecoveryRecord { accountId: string; tokenLookup: string; protectedSecret: string; expiresAt: string }
export interface AccountRecoveryRepository {
  findAccountByEmail(email: string): Promise<AccountAuthenticationRecord | undefined>;
  findAccountById(id: string): Promise<AccountAuthenticationRecord | undefined>;
  savePasskey(record: PasskeyRecord): Promise<void>;
  findPasskey(credentialId: string): Promise<PasskeyRecord | undefined>;
  updatePasskeyCounter(credentialId: string, previousCounter: number, newCounter: number): Promise<boolean>;
  replaceRecoveryCodes(accountId: string, records: RecoveryCodeRecord[]): Promise<void>;
  consumeRecoveryCode(accountId: string, lookup: string): Promise<boolean>;
  saveEmailRecovery(record: EmailRecoveryRecord): Promise<void>;
  consumeEmailRecovery(lookup: string, now: string): Promise<string | undefined>;
}
export interface PasskeyVerifier {
  registrationOptions(challenge: string, account: AccountAuthenticationRecord): object;
  authenticationOptions(challenge: string): object;
  register(challenge: string, input: Record<string, unknown>): Promise<Omit<PasskeyRecord, "accountId" | "createdAt">>;
  authenticate(challenge: string, input: Record<string, unknown>, passkey: PasskeyRecord): Promise<{ newCounter: number }>;
}
export interface RecoveryEmailSender { sendRecovery(address: string, token: string): Promise<void> }
export class InvalidRecoveryInput extends Error {}
export class RecoveryCredentialsRejected extends Error {}
export class EmailRecoveryUnavailable extends Error {}

function derivePurposeSeparatedLookup(purpose: "webauthn-challenge" | "recovery-code" | "email-recovery", value: string) {
  return createHash("sha256").update(`stash:${purpose}:v1\0${value}`).digest("base64");
}
const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export class AccountRecoveryService {
  readonly #challenges = new Map<string, { purpose: "register" | "authenticate"; accountId?: string; expires: number }>();
  constructor(readonly repository: AccountRecoveryRepository, readonly passwords: PasswordAuthService, readonly adapters: { passkeys: PasskeyVerifier; secrets: AuthenticationSecretCodec; email?: RecoveryEmailSender }) {}
  authenticateMember(authorization: string | undefined) { return this.passwords.authenticateBearer(authorization); }

  async registrationOptions(member: AuthenticatedMember) {
    const account = await this.repository.findAccountById(member.accountId);
    if (!account) throw new RecoveryCredentialsRejected();
    const challenge = this.#challenge("register", member.accountId);
    return this.adapters.passkeys.registrationOptions(challenge, account);
  }
  async registerPasskey(member: AuthenticatedMember, value: unknown) {
    const input = this.#object(value);
    const challenge = this.#takeChallenge(this.#clientChallenge(input), "register", member.accountId);
    let verified: Omit<PasskeyRecord, "accountId" | "createdAt">;
    try { verified = await this.adapters.passkeys.register(challenge, input); } catch { throw new InvalidRecoveryInput(); }
    if (!verified.credentialId || !verified.publicKey || !Number.isSafeInteger(verified.counter)) throw new InvalidRecoveryInput();
    await this.repository.savePasskey({ ...verified, accountId: member.accountId, createdAt: new Date().toISOString() });
    return { credentialId: verified.credentialId };
  }
  async authenticationOptions(value: unknown) {
    const input = this.#object(value);
    if (typeof input.email !== "string" || !emailPattern.test(input.email)) throw new InvalidRecoveryInput();
    const account = await this.repository.findAccountByEmail(input.email.trim().toLowerCase());
    const challenge = this.#challenge("authenticate", account?.id);
    return this.adapters.passkeys.authenticationOptions(challenge);
  }
  async signInWithPasskey(value: unknown, userAgent?: string) {
    const input = this.#object(value);
    if (typeof input.id !== "string") throw new InvalidRecoveryInput();
    const passkey = await this.repository.findPasskey(input.id);
    const challenge = this.#takeChallenge(this.#clientChallenge(input), "authenticate", passkey?.accountId);
    if (!passkey) throw new RecoveryCredentialsRejected();
    let verification: { newCounter: number };
    try { verification = await this.adapters.passkeys.authenticate(challenge, input, passkey); } catch { throw new RecoveryCredentialsRejected(); }
    if (!(await this.repository.updatePasskeyCounter(passkey.credentialId, passkey.counter, verification.newCounter))) throw new RecoveryCredentialsRejected();
    return this.#session(passkey.accountId, userAgent);
  }
  async generateRecoveryCodes(member: AuthenticatedMember) {
    const codes = Array.from({ length: 10 }, () => `${randomBytes(4).toString("hex")}-${randomBytes(4).toString("hex")}`);
    await this.repository.replaceRecoveryCodes(member.accountId, codes.map((code) => ({ accountId: member.accountId, lookup: derivePurposeSeparatedLookup("recovery-code", code), protectedSecret: this.adapters.secrets.encrypt(code) })));
    return codes;
  }
  async signInWithRecoveryCode(value: unknown, userAgent?: string) {
    const input = this.#object(value);
    if (typeof input.email !== "string" || !emailPattern.test(input.email) || typeof input.code !== "string") throw new InvalidRecoveryInput();
    const account = await this.repository.findAccountByEmail(input.email.trim().toLowerCase());
    if (!account || !(await this.repository.consumeRecoveryCode(account.id, derivePurposeSeparatedLookup("recovery-code", input.code)))) throw new RecoveryCredentialsRejected();
    return this.passwords.createSession(account, userAgent);
  }
  async requestEmailRecovery(value: unknown) {
    if (!this.adapters.email) throw new EmailRecoveryUnavailable();
    const input = this.#object(value);
    if (typeof input.email !== "string" || !emailPattern.test(input.email)) throw new InvalidRecoveryInput();
    const account = await this.repository.findAccountByEmail(input.email.trim().toLowerCase());
    if (account) {
      const token = randomBytes(32).toString("base64url");
      await this.repository.saveEmailRecovery({ accountId: account.id, tokenLookup: derivePurposeSeparatedLookup("email-recovery", token), protectedSecret: this.adapters.secrets.encrypt(token), expiresAt: new Date(Date.now() + 15 * 60_000).toISOString() });
      await this.adapters.email.sendRecovery(account.email, token);
    }
  }
  async signInWithEmailRecovery(value: unknown, userAgent?: string) {
    const input = this.#object(value);
    if (typeof input.token !== "string" || input.token.length < 32) throw new InvalidRecoveryInput();
    const accountId = await this.repository.consumeEmailRecovery(derivePurposeSeparatedLookup("email-recovery", input.token), new Date().toISOString());
    if (!accountId) throw new RecoveryCredentialsRejected();
    return this.#session(accountId, userAgent);
  }
  async #session(accountId: string, userAgent?: string) { const account = await this.repository.findAccountById(accountId); if (!account) throw new RecoveryCredentialsRejected(); return this.passwords.createSession(account, userAgent); }
  #challenge(purpose: "register" | "authenticate", accountId?: string) { const challenge = randomBytes(32).toString("base64url"); this.#challenges.set(derivePurposeSeparatedLookup("webauthn-challenge", challenge), { purpose, ...(accountId ? { accountId } : {}), expires: Date.now() + 5 * 60_000 }); return challenge; }
  #takeChallenge(value: string, purpose: "register" | "authenticate", accountId?: string) { const lookup = derivePurposeSeparatedLookup("webauthn-challenge", value); const stored = this.#challenges.get(lookup); this.#challenges.delete(lookup); if (!stored || stored.purpose !== purpose || stored.expires < Date.now() || stored.accountId !== accountId) throw new RecoveryCredentialsRejected(); return value; }
  #clientChallenge(input: Record<string, unknown>) { const response = input.response; if (!response || typeof response !== "object" || Array.isArray(response)) throw new InvalidRecoveryInput(); const encoded = (response as Record<string, unknown>).clientDataJSON; if (typeof encoded !== "string") throw new InvalidRecoveryInput(); try { const data = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")) as Record<string, unknown>; if (typeof data.challenge !== "string") throw new Error(); return data.challenge; } catch { throw new InvalidRecoveryInput(); } }
  #object(value: unknown): Record<string, unknown> { if (!value || typeof value !== "object" || Array.isArray(value)) throw new InvalidRecoveryInput(); return value as Record<string, unknown>; }
}
