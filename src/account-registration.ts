import { randomUUID } from "node:crypto";

import { prepareSession } from "./auth-session.js";
import { passwordHashCodec, type PasswordHashCodec } from "./password-hash.js";
import type { SessionRecord } from "./password-auth.js";

export interface RegistrationRecord {
  account: { id: string; name: string; email: string; passwordHash: string };
  workspace: { id: string; name: string };
  session: SessionRecord;
}

export interface AccountRegistrationRepository {
  createAccountWithPersonalWorkspaceAndSession(record: RegistrationRecord): Promise<boolean>;
}

export class InvalidRegistrationInput extends Error {}
export class RegistrationConflict extends Error {}
export class RegistrationThrottled extends Error {
  constructor(readonly retryAfterSeconds: number) { super("registration_throttled"); }
}

export interface RegistrationAdmissionOptions {
  maximumConcurrent?: number;
  maximumAttempts?: number;
  windowMs?: number;
  maximumTrackedKeys?: number;
  now?: () => number;
}

export class RegistrationAdmissionController {
  readonly #maximumConcurrent: number;
  readonly #maximumAttempts: number;
  readonly #windowMs: number;
  readonly #maximumTrackedKeys: number;
  readonly #now: () => number;
  readonly #attempts = new Map<string, number[]>();
  #active = 0;

  constructor(options: RegistrationAdmissionOptions = {}) {
    this.#maximumConcurrent = options.maximumConcurrent ?? 2;
    this.#maximumAttempts = options.maximumAttempts ?? 5;
    this.#windowMs = options.windowMs ?? 60_000;
    this.#maximumTrackedKeys = options.maximumTrackedKeys ?? 1_024;
    this.#now = options.now ?? Date.now;
  }

  enter(key: string): () => void {
    const now = this.#now();
    for (const [candidate, attempts] of this.#attempts) {
      const current = attempts.filter((timestamp) => now - timestamp < this.#windowMs);
      if (current.length) this.#attempts.set(candidate, current); else this.#attempts.delete(candidate);
    }
    const attempts = this.#attempts.get(key) ?? [];
    if (attempts.length >= this.#maximumAttempts || (!this.#attempts.has(key) && this.#attempts.size >= this.#maximumTrackedKeys)) {
      const oldest = attempts[0] ?? now;
      throw new RegistrationThrottled(Math.max(1, Math.ceil((this.#windowMs - (now - oldest)) / 1_000)));
    }
    this.#attempts.set(key, [...attempts, now]);
    if (this.#active >= this.#maximumConcurrent) throw new RegistrationThrottled(1);
    this.#active += 1; let released = false;
    return () => { if (!released) { released = true; this.#active -= 1; } };
  }
}

function validRegistration(value: unknown): value is { name: string; email: string; password: string } {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const input = value as Record<string, unknown>;
  return typeof input.name === "string" && input.name.trim().length > 0 && input.name.trim().length <= 200
    && typeof input.email === "string" && input.email.length <= 320 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(input.email)
    && typeof input.password === "string" && input.password.length >= 12 && input.password.length <= 1024;
}

export class AccountRegistrationService {
  readonly #repository: AccountRegistrationRepository;
  readonly #passwords: PasswordHashCodec;
  readonly #admission: RegistrationAdmissionController;

  constructor(repository: AccountRegistrationRepository, passwords: PasswordHashCodec = passwordHashCodec,
    admission: RegistrationAdmissionController = new RegistrationAdmissionController()) {
    this.#repository = repository;
    this.#passwords = passwords;
    this.#admission = admission;
  }

  async register(value: unknown, userAgent?: string, admissionKey = "unknown") {
    if (!validRegistration(value)) throw new InvalidRegistrationInput();
    const release = this.#admission.enter(admissionKey);
    try {
      const account = {
        id: randomUUID(),
        name: value.name.trim(),
        email: value.email.trim().toLowerCase(),
        passwordHash: await this.#passwords.hash(value.password),
      };
      const workspace = { id: randomUUID(), name: `${account.name}'s Workspace` };
      const prepared = prepareSession(account, userAgent);
      if (!await this.#repository.createAccountWithPersonalWorkspaceAndSession({ account, workspace, session: prepared.record })) {
        throw new RegistrationConflict();
      }
      return { ...prepared.result, workspace: { id: workspace.id, name: workspace.name } };
    } finally {
      release();
    }
  }
}
