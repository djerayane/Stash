import { createHash, randomBytes, randomUUID, scrypt as nodeScrypt, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";

const scrypt = promisify(nodeScrypt);

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

export class InvalidAuthenticationInput extends Error {}
export class InvalidCredentials extends Error {}

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const derivedKey = (await scrypt(password, salt, 64)) as Buffer;
  return `scrypt$${salt.toString("base64")}$${derivedKey.toString("base64")}`;
}

async function passwordMatches(password: string, encoded: string): Promise<boolean> {
  const [algorithm, saltValue, keyValue] = encoded.split("$");
  if (algorithm !== "scrypt" || !saltValue || !keyValue) return false;
  try {
    const expected = Buffer.from(keyValue, "base64");
    const actual = (await scrypt(password, Buffer.from(saltValue, "base64"), expected.length)) as Buffer;
    return actual.length === expected.length && timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}

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

  constructor(repository: PasswordAuthRepository) {
    this.#repository = repository;
  }

  async signIn(value: unknown, userAgent?: string) {
    if (!validCredentials(value)) throw new InvalidAuthenticationInput();
    const account = await this.#repository.findAccountByEmail(value.email.trim().toLowerCase());
    if (!account || !(await passwordMatches(value.password, account.passwordHash))) {
      throw new InvalidCredentials();
    }
    const token = randomBytes(32).toString("base64url");
    const now = new Date().toISOString();
    const session: SessionRecord = {
      id: randomUUID(), accountId: account.id, tokenHash: tokenHash(token), createdAt: now, lastSeenAt: now,
      ...(userAgent ? { userAgent: userAgent.slice(0, 500) } : {}),
    };
    await this.#repository.createSession(session);
    return {
      token,
      member: { id: account.id, name: account.name, email: account.email },
      session: this.presentSession(session, session.id),
    };
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
      .map((session) => this.presentSession(session, member.sessionId));
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
    const account = await this.#accountForSession(member.accountId);
    if (!account || !(await passwordMatches(input.currentPassword, account.passwordHash))) throw new InvalidCredentials();
    await this.#repository.changePasswordAndDeleteOtherSessions(
      member.accountId, member.sessionId, await hashPassword(input.newPassword),
    );
  }

  async #accountForSession(accountId: string) {
    const sessions = await this.#repository.listSessions(accountId);
    if (!sessions.length) return undefined;
    return this.#repository.findAccountById(accountId);
  }

  private presentSession(session: SessionRecord, currentSessionId: string) {
    return {
      id: session.id, createdAt: session.createdAt, lastSeenAt: session.lastSeenAt,
      ...(session.userAgent ? { userAgent: session.userAgent } : {}), current: session.id === currentSessionId,
    };
  }
}
