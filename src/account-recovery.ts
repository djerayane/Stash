import { createHash, randomBytes } from "node:crypto";
import type { AccountAuthenticationRecord, AuthenticatedMember, PasswordAuthService } from "./password-auth.js";

export interface PasskeyRecord { credentialId: string; accountId: string; publicKey: string; createdAt: string }
export interface RecoveryCodeRecord { accountId: string; lookup: string }
export interface EmailRecoveryRecord { accountId: string; tokenLookup: string; expiresAt: string }

export interface AccountRecoveryRepository {
  findAccountByEmail(email: string): Promise<AccountAuthenticationRecord | undefined>;
  findAccountById(id: string): Promise<AccountAuthenticationRecord | undefined>;
  savePasskey(record: PasskeyRecord): Promise<void>;
  findPasskey(credentialId: string): Promise<PasskeyRecord | undefined>;
  replaceRecoveryCodes(accountId: string, records: RecoveryCodeRecord[]): Promise<void>;
  consumeRecoveryCode(accountId: string, lookup: string): Promise<boolean>;
  saveEmailRecovery(record: EmailRecoveryRecord): Promise<void>;
  consumeEmailRecovery(lookup: string, now: string): Promise<string | undefined>;
}

export interface PasskeyVerifier {
  register(challenge: string, input: Record<string, unknown>): Promise<{ credentialId: string; publicKey: string }>;
  authenticate(challenge: string, input: Record<string, unknown>, passkey: PasskeyRecord): Promise<boolean>;
}
export interface RecoveryEmailSender { sendRecovery(address: string, token: string): Promise<void> }
export class InvalidRecoveryInput extends Error {}
export class RecoveryCredentialsRejected extends Error {}
export class EmailRecoveryUnavailable extends Error {}

const digest = (value: string) => createHash("sha256").update(value).digest("base64");
const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export class AccountRecoveryService {
  readonly #challenges = new Map<string, { purpose: "register" | "authenticate"; accountId?: string; expires: number }>();
  constructor(
    readonly repository: AccountRecoveryRepository,
    readonly passwords: PasswordAuthService,
    readonly adapters: { passkeys: PasskeyVerifier; email?: RecoveryEmailSender },
  ) {}

  async registrationOptions(member: AuthenticatedMember) { return this.#challenge("register", member.accountId); }
  async registerPasskey(member: AuthenticatedMember, value: unknown) {
    const input = this.#object(value);
    const challenge = this.#takeChallenge(input.challenge, "register", member.accountId);
    const verified = await this.adapters.passkeys.register(challenge, input);
    if (!verified.credentialId || !verified.publicKey) throw new InvalidRecoveryInput();
    await this.repository.savePasskey({ ...verified, accountId: member.accountId, createdAt: new Date().toISOString() });
    return { credentialId: verified.credentialId };
  }

  async authenticationOptions(value: unknown) {
    const input = this.#object(value);
    if (typeof input.email !== "string" || !emailPattern.test(input.email)) throw new InvalidRecoveryInput();
    const account = await this.repository.findAccountByEmail(input.email.trim().toLowerCase());
    return this.#challenge("authenticate", account?.id);
  }

  async signInWithPasskey(value: unknown, userAgent?: string) {
    const input = this.#object(value);
    if (typeof input.credentialId !== "string") throw new InvalidRecoveryInput();
    const passkey = await this.repository.findPasskey(input.credentialId);
    const challenge = this.#takeChallenge(input.challenge, "authenticate", passkey?.accountId);
    if (!passkey || !(await this.adapters.passkeys.authenticate(challenge, input, passkey))) throw new RecoveryCredentialsRejected();
    return this.#session(passkey.accountId, userAgent);
  }

  async generateRecoveryCodes(member: AuthenticatedMember) {
    const codes = Array.from({ length: 10 }, () => `${randomBytes(4).toString("hex")}-${randomBytes(4).toString("hex")}`);
    await this.repository.replaceRecoveryCodes(member.accountId, codes.map((code) => ({ accountId: member.accountId, lookup: digest(code) })));
    return codes;
  }

  async signInWithRecoveryCode(value: unknown, userAgent?: string) {
    const input = this.#object(value);
    if (typeof input.email !== "string" || !emailPattern.test(input.email) || typeof input.code !== "string") throw new InvalidRecoveryInput();
    const account = await this.repository.findAccountByEmail(input.email.trim().toLowerCase());
    if (!account || !(await this.repository.consumeRecoveryCode(account.id, digest(input.code)))) throw new RecoveryCredentialsRejected();
    return this.passwords.createSession(account, userAgent);
  }

  async requestEmailRecovery(value: unknown) {
    if (!this.adapters.email) throw new EmailRecoveryUnavailable();
    const input = this.#object(value);
    if (typeof input.email !== "string" || !emailPattern.test(input.email)) throw new InvalidRecoveryInput();
    const account = await this.repository.findAccountByEmail(input.email.trim().toLowerCase());
    if (account) {
      const token = randomBytes(32).toString("base64url");
      await this.repository.saveEmailRecovery({ accountId: account.id, tokenLookup: digest(token), expiresAt: new Date(Date.now() + 15 * 60_000).toISOString() });
      await this.adapters.email.sendRecovery(account.email, token);
    }
  }

  async signInWithEmailRecovery(value: unknown, userAgent?: string) {
    const input = this.#object(value);
    if (typeof input.token !== "string" || input.token.length < 32) throw new InvalidRecoveryInput();
    const accountId = await this.repository.consumeEmailRecovery(digest(input.token), new Date().toISOString());
    if (!accountId) throw new RecoveryCredentialsRejected();
    return this.#session(accountId, userAgent);
  }

  async #session(accountId: string, userAgent?: string) {
    const account = await this.repository.findAccountById(accountId);
    if (!account) throw new RecoveryCredentialsRejected();
    return this.passwords.createSession(account, userAgent);
  }
  #challenge(purpose: "register" | "authenticate", accountId?: string) {
    const challenge = randomBytes(32).toString("base64url");
    this.#challenges.set(digest(challenge), { purpose, ...(accountId ? { accountId } : {}), expires: Date.now() + 5 * 60_000 });
    return { challenge };
  }
  #takeChallenge(value: unknown, purpose: "register" | "authenticate", accountId?: string) {
    if (typeof value !== "string") throw new InvalidRecoveryInput();
    const key = digest(value); const stored = this.#challenges.get(key); this.#challenges.delete(key);
    if (!stored || stored.purpose !== purpose || stored.expires < Date.now() || stored.accountId !== accountId) throw new RecoveryCredentialsRejected();
    return value;
  }
  #object(value: unknown): Record<string, unknown> {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new InvalidRecoveryInput();
    return value as Record<string, unknown>;
  }
}
