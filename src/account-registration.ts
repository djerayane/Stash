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

  constructor(repository: AccountRegistrationRepository, passwords: PasswordHashCodec = passwordHashCodec) {
    this.#repository = repository;
    this.#passwords = passwords;
  }

  async register(value: unknown, userAgent?: string) {
    if (!validRegistration(value)) throw new InvalidRegistrationInput();
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
  }
}
