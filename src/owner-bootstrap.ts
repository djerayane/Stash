import { randomBytes, randomUUID, scrypt as nodeScrypt } from "node:crypto";
import { promisify } from "node:util";

const scrypt = promisify(nodeScrypt);

export interface BootstrapRecord {
  organizationId: string;
  organizationName: string;
  ownerId: string;
  ownerName: string;
  ownerEmail: string;
  passwordHash: string;
  role: "Owner";
}

export interface OwnerBootstrapRepository {
  createFirstOrganizationOwner(record: BootstrapRecord): Promise<boolean>;
}

export interface BootstrapInput {
  organizationName: string;
  ownerName: string;
  ownerEmail: string;
  password: string;
}

export type BootstrapResult = Omit<BootstrapRecord, "passwordHash">;

export class InvalidBootstrapInput extends Error {}

function validInput(value: unknown): value is BootstrapInput {
  if (!value || typeof value !== "object") return false;
  const input = value as Record<string, unknown>;
  return (
    typeof input.organizationName === "string" &&
    input.organizationName.trim().length > 0 &&
    input.organizationName.trim().length <= 200 &&
    typeof input.ownerName === "string" &&
    input.ownerName.trim().length > 0 &&
    input.ownerName.trim().length <= 200 &&
    typeof input.ownerEmail === "string" &&
    /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(input.ownerEmail) &&
    input.ownerEmail.length <= 320 &&
    typeof input.password === "string" &&
    input.password.length >= 12 &&
    input.password.length <= 1024
  );
}

async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const derivedKey = (await scrypt(password, salt, 64)) as Buffer;
  return `scrypt$${salt.toString("base64")}$${derivedKey.toString("base64")}`;
}

export class OwnerBootstrapService {
  readonly #repository: OwnerBootstrapRepository;

  constructor(repository: OwnerBootstrapRepository) {
    this.#repository = repository;
  }

  async bootstrap(value: unknown): Promise<BootstrapResult | undefined> {
    if (!validInput(value)) throw new InvalidBootstrapInput();

    const record: BootstrapRecord = {
      organizationId: randomUUID(),
      organizationName: value.organizationName.trim(),
      ownerId: randomUUID(),
      ownerName: value.ownerName.trim(),
      ownerEmail: value.ownerEmail.trim().toLowerCase(),
      passwordHash: await hashPassword(value.password),
      role: "Owner",
    };

    if (!(await this.#repository.createFirstOrganizationOwner(record))) return undefined;
    const { passwordHash: _, ...result } = record;
    return result;
  }
}
