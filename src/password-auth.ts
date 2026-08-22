import { createHash } from "node:crypto";
import { issueSession, prepareSession, presentSession } from "./auth-session.js";
import { passwordHashCodec, type PasswordHashCodec } from "./password-hash.js";

export interface AccountAuthenticationRecord {
  id: string;
  name: string;
  email: string;
  passwordHash: string;
}

export interface SessionRecord {
  id: string;
  accountId: string;
  tokenHash: string;
  createdAt: string;
  lastSeenAt: string;
  userAgent?: string;
}

export interface PasswordAuthRepository {
  findAccountByEmail(email: string): Promise<AccountAuthenticationRecord | undefined>;
  findAccountById(id: string): Promise<AccountAuthenticationRecord | undefined>;
  createSession(session: SessionRecord): Promise<void>;
  findSessionByTokenHash(tokenHash: string): Promise<SessionRecord | undefined>;
  listSessions(accountId: string): Promise<SessionRecord[]>;
  deleteSession(accountId: string, sessionId: string): Promise<boolean>;
  changePasswordAndDeleteOtherSessions(accountId: string, currentSessionId: string, passwordHash: string): Promise<void>;
}

export interface AuthenticatedMember {
  accountId: string;
  sessionId: string;
}
export interface PreparedSession {
  record: SessionRecord;
  result: {
    token: string;
    member: { id: string; name: string; email: string };
    session: { id: string; createdAt: string; lastSeenAt: string; userAgent?: string; current: boolean };
  };
}

export class InvalidAuthenticationInput extends Error {}
export class InvalidCredentials extends Error {}

export const hashPassword = passwordHashCodec.hash;

// A valid fixed hash makes unknown-account sign-in perform the same password-verification work.
const missingAccountPasswordHash = "scrypt$AAAAAAAAAAAAAAAAAAAAAA==$yCvCoaHtjw7z6fOfWQ8q3OfYpwNSa4I0i5cQ0Pxy2K7jNUI0yTY0hFL7bqLq9qJ4PqVBv8jAXXb4hkOqjQvVTg==";

function tokenHash(token: string): string {
  return createHash("sha256").update(token).digest("base64");
}

function validCredentials(value: unknown): value is { email: string; password: string } {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const input = value as Record<string, unknown>;
  return typeof input.email === "string" && input.email.length <= 320
    && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(input.email)
    && typeof input.password === "string" && input.password.length >= 12 && input.password.length <= 1024;
}

export class PasswordAuthService {
  readonly #repository: PasswordAuthRepository;
  readonly #passwords: PasswordHashCodec;

  constructor(repository: PasswordAuthRepository, passwords: PasswordHashCodec = passwordHashCodec) {
    this.#repository = repository;
    this.#passwords = passwords;
  }

  async signIn(value: unknown, userAgent?: string) {
    if (!validCredentials(value)) throw new InvalidAuthenticationInput();
    const account = await this.#repository.findAccountByEmail(value.email.trim().toLowerCase());
    const matches = await this.#passwords.matches(value.password, account?.passwordHash ?? missingAccountPasswordHash);
    if (!account || !matches) {
      throw new InvalidCredentials();
    }
    return issueSession(this.#repository, { id: account.id, name: account.name, email: account.email }, userAgent);
  }

  async createSession(account: AccountAuthenticationRecord, userAgent?: string) {
    const prepared = this.prepareSession(account, userAgent);
    await this.#repository.createSession(prepared.record);
    return prepared.result;
  }

  prepareSession(account: AccountAuthenticationRecord, userAgent?: string): PreparedSession {
    return prepareSession({ id: account.id, name: account.name, email: account.email }, userAgent);
  }

  async authenticateBearer(authorization: string | undefined): Promise<AuthenticatedMember | undefined> {
    if (!authorization?.startsWith("Bearer ")) return undefined;
    const token = authorization.slice(7);
    if (!token) return undefined;
    const session = await this.#repository.findSessionByTokenHash(tokenHash(token));
    return session ? { accountId: session.accountId, sessionId: session.id } : undefined;
  }

  async sessions(member: AuthenticatedMember) {
    return (await this.#repository.listSessions(member.accountId))
      .map((session) => presentSession(session, member.sessionId));
  }

  revoke(member: AuthenticatedMember, sessionId: string) {
    return this.#repository.deleteSession(member.accountId, sessionId);
  }

  async changePassword(member: AuthenticatedMember, value: unknown): Promise<void> {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new InvalidAuthenticationInput();
    const input = value as Record<string, unknown>;
    if (typeof input.currentPassword !== "string" || typeof input.newPassword !== "string"
      || input.newPassword.length < 12 || input.newPassword.length > 1024) {
      throw new InvalidAuthenticationInput();
    }
    const sessions = await this.#repository.listSessions(member.accountId);
    const current = sessions.find(({ id }) => id === member.sessionId);
    if (!current) throw new InvalidCredentials();
    // The account lookup uses the identity attached to the authenticated session.
    const account = await this.#repository.findAccountById(member.accountId);
    if (!account || !(await this.#passwords.matches(input.currentPassword, account.passwordHash))) throw new InvalidCredentials();
    await this.#repository.changePasswordAndDeleteOtherSessions(
      member.accountId, member.sessionId, await this.#passwords.hash(input.newPassword),
    );
  }

}
