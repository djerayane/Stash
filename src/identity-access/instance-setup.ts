import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { isIP } from "node:net";

import { prepareSession } from "../auth-session.js";
import { passwordHashCodec, type PasswordHashCodec } from "../password-hash.js";
import type { SessionRecord } from "../password-auth.js";

export interface StarterNoteSetup {
  id: string;
  title: string;
  content: string;
  parentId?: string;
}

export interface StarterTaskSetup {
  id: string;
  title: string;
}

/**
 * The narrow durable hand-off that lets the Collection/View Block capability replace the
 * tutorial contribution without making setup own those domain models.
 */
export interface StarterTutorialContribution {
  schema: "stash.starter-tutorial.v1";
  rootNoteId: string;
  collection: { id: string; ownerNoteId: string; name: string };
  taskView: {
    id: string;
    noteId: string;
    source: { kind: "tasks"; workspaceId: string };
    presentation: "list";
    taskIds: string[];
  };
}

export interface FirstPersonalInstanceSetup {
  account: { id: string; name: string; email: string; passwordHash: string };
  workspace: { id: string; name: string };
  session: SessionRecord;
  starter: {
    notes: StarterNoteSetup[];
    links: Array<{ id: string; sourceNoteId: string; targetNoteId: string; label: string }>;
    tasks: StarterTaskSetup[];
    contribution: StarterTutorialContribution;
  };
  createdAt: string;
}

export interface InstanceSetupRepository {
  setupComplete(): Promise<boolean>;
  createFirstPersonalInstance(setup: FirstPersonalInstanceSetup): Promise<boolean>;
}

export interface SetupConnection {
  localAddress?: string;
  remoteAddress?: string;
}

export type InstanceSetupState = "available-local" | "code-required" | "complete";

export class InvalidInstanceSetupInput extends Error {}
export class SetupCodeRequired extends Error {}
export class InvalidSetupCode extends Error {}
export class ExpiredSetupCode extends Error {}

interface InstanceSetupOptions {
  boundHost: string;
  output(message: string): void;
  now?: () => number;
  codeTtlMs?: number;
  code?: string;
}

interface SetupInput {
  setupCode?: string;
  name: string;
  email: string;
  password: string;
  workspaceName: string;
}

function normalizeAddress(address: string | undefined): string | undefined {
  if (!address) return undefined;
  const zone = address.indexOf("%");
  const withoutZone = zone === -1 ? address : address.slice(0, zone);
  return withoutZone.toLowerCase().replace(/^::ffff:/, "");
}

export function isLoopbackAddress(address: string | undefined): boolean {
  const normalized = normalizeAddress(address);
  if (!normalized) return false;
  if (normalized === "localhost" || normalized === "::1") return true;
  return isIP(normalized) === 4 && normalized.startsWith("127.");
}

function validInput(value: unknown): value is SetupInput {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const input = value as Record<string, unknown>;
  return typeof input.name === "string" && input.name.trim().length > 0 && input.name.trim().length <= 200
    && typeof input.email === "string" && input.email.length <= 320 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(input.email)
    && typeof input.password === "string" && input.password.length >= 12 && input.password.length <= 1024
    && typeof input.workspaceName === "string" && input.workspaceName.trim().length > 0 && input.workspaceName.trim().length <= 200
    && (input.setupCode === undefined || typeof input.setupCode === "string")
    && Object.keys(input).every((key) => ["setupCode", "name", "email", "password", "workspaceName"].includes(key));
}

function digest(value: string): Buffer {
  return createHash("sha256").update(value).digest();
}

function sameDigest(left: Buffer, right: Buffer): boolean {
  return left.byteLength === right.byteLength && timingSafeEqual(left, right);
}

export class InstanceSetupService {
  readonly #repository: InstanceSetupRepository;
  readonly #passwords: PasswordHashCodec;
  readonly #boundToLoopback: boolean;
  readonly #now: () => number;
  readonly #expiresAt: number;
  readonly #setupCodeHash?: Buffer;
  #consumed = false;
  #claimQueue: Promise<void> = Promise.resolve();

  constructor(repository: InstanceSetupRepository, options: InstanceSetupOptions, passwords: PasswordHashCodec = passwordHashCodec) {
    this.#repository = repository;
    this.#passwords = passwords;
    this.#boundToLoopback = isLoopbackAddress(options.boundHost);
    this.#now = options.now ?? Date.now;
    this.#expiresAt = this.#now() + (options.codeTtlMs ?? 10 * 60_000);
    if (!this.#boundToLoopback) {
      const code = options.code ?? randomBytes(6).toString("base64url").toUpperCase();
      this.#setupCodeHash = digest(code);
      options.output(`Stash first-run setup code: ${code} (expires in 10 minutes)`);
    }
  }

  #connectionIsTrusted(connection: SetupConnection): boolean {
    return this.#boundToLoopback
      && isLoopbackAddress(connection.localAddress)
      && isLoopbackAddress(connection.remoteAddress);
  }

  async state(connection: SetupConnection): Promise<InstanceSetupState> {
    if (await this.#repository.setupComplete()) return "complete";
    return this.#connectionIsTrusted(connection) ? "available-local" : "code-required";
  }

  async setup(value: unknown, connection: SetupConnection, userAgent?: string) {
    if (!validInput(value)) throw new InvalidInstanceSetupInput();
    const previous = this.#claimQueue;
    let release!: () => void;
    this.#claimQueue = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    try {
      if (await this.#repository.setupComplete()) return undefined;
      if (!this.#connectionIsTrusted(connection)) {
        if (!value.setupCode) throw new SetupCodeRequired();
        if (this.#consumed || !this.#setupCodeHash || !sameDigest(digest(value.setupCode.trim().toUpperCase()), this.#setupCodeHash)) {
          throw new InvalidSetupCode();
        }
        if (this.#now() >= this.#expiresAt) throw new ExpiredSetupCode();
      }
      const account = { id: randomUUID(), name: value.name.trim(), email: value.email.trim().toLowerCase(),
        passwordHash: await this.#passwords.hash(value.password) };
      const workspace = { id: randomUUID(), name: value.workspaceName.trim() };
      const preparedSession = prepareSession({ id: account.id, name: account.name, email: account.email }, userAgent);
      const rootNoteId = randomUUID();
      const organizeNoteId = randomUUID();
      const planNoteId = randomUUID();
      const tasks = [
        { id: randomUUID(), title: "Shape your first idea" },
        { id: randomUUID(), title: "Turn one Note into action" },
      ];
      const record: FirstPersonalInstanceSetup = {
        account,
        workspace,
        session: preparedSession.record,
        createdAt: new Date(this.#now()).toISOString(),
        starter: {
          notes: [
            { id: rootNoteId, title: "Start here", content: "This branch is yours to edit, move, or remove." },
            { id: organizeNoteId, parentId: rootNoteId, title: "Connect your thinking", content: "Link Notes when ideas belong together without moving them." },
            { id: planNoteId, parentId: rootNoteId, title: "Plan the next step", content: "Keep knowledge and action together with a Task view." },
          ],
          links: [{ id: randomUUID(), sourceNoteId: organizeNoteId, targetNoteId: planNoteId, label: "Continue planning" }],
          tasks,
          contribution: {
            schema: "stash.starter-tutorial.v1",
            rootNoteId,
            collection: { id: randomUUID(), ownerNoteId: organizeNoteId, name: "Ideas to explore" },
            taskView: { id: randomUUID(), noteId: planNoteId, source: { kind: "tasks", workspaceId: workspace.id },
              presentation: "list", taskIds: tasks.map(({ id }) => id) },
          },
        },
      };
      if (!(await this.#repository.createFirstPersonalInstance(record))) return undefined;
      this.#consumed = true;
      return { token: preparedSession.result.token, workspaceId: workspace.id, starterNoteId: rootNoteId };
    } finally {
      release();
    }
  }
}
