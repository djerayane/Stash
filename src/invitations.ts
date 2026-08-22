import { createHash, randomBytes, randomUUID } from "node:crypto";

import type { BuiltInOrganizationRole } from "./organization-roles.js";
import type { PortableIdentity } from "./workspaces-projects.js";

export type InvitationRecord = {
  id: string;
  organizationId: string;
  tokenHash: string;
  invitedByAccountId: string;
  expiresAt: string;
  acceptedAt?: string;
  acceptedByAccountId?: string;
} & (
  | { kind: "member"; role: BuiltInOrganizationRole }
  | { kind: "guest"; projectIds: string[] }
);

export interface ProjectAccessSummary {
  id: string;
  organizationId: string;
  name: string;
  key: string;
  createdBy: PortableIdentity;
}

export interface InvitationRepository {
  organizationRole(organizationId: string, accountId: string): Promise<BuiltInOrganizationRole | undefined>;
  createInvitation(record: InvitationRecord): Promise<"created" | "forbidden" | "project_forbidden">;
  acceptInvitation(tokenHash: string, accountId: string, acceptedAt: string): Promise<
    | { status: "accepted"; access: { kind: "member"; organizationId: string; role: BuiltInOrganizationRole } | { kind: "guest"; organizationId: string; projectIds: string[] } }
    | "invalid_invitation"
  >;
  readProject(accountId: string, projectId: string): Promise<ProjectAccessSummary | undefined>;
  canWriteProject(accountId: string, projectId: string): Promise<boolean>;
}

export class InvalidInvitationInput extends Error {}

function isUuid(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

export class InvitationService {
  readonly #repository: InvitationRepository;
  constructor(repository: InvitationRepository) { this.#repository = repository; }

  async create(organizationId: string, actorId: string, value: unknown) {
    if (!isUuid(organizationId) || !isInvitationInput(value)) throw new InvalidInvitationInput();
    const role = await this.#repository.organizationRole(organizationId, actorId);
    if (role !== "Owner" && role !== "Admin") return { status: "forbidden" as const };
    if (role === "Admin" && value.kind === "member" && value.role !== "Member") {
      return { status: "forbidden" as const };
    }
    const token = randomBytes(32).toString("base64url");
    const common = {
      id: randomUUID(), organizationId, tokenHash: hashToken(token), invitedByAccountId: actorId,
      expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
    };
    const record: InvitationRecord = value.kind === "member"
      ? { ...common, kind: "member", role: value.role }
      : { ...common, kind: "guest", projectIds: [...new Set(value.projectIds)] };
    const status = await this.#repository.createInvitation(record);
    return status === "created" ? { status, token, invitation: record } : { status };
  }

  async accept(accountId: string, value: unknown) {
    if (!isPlainObject(value) || Object.keys(value).length !== 1 || typeof value.token !== "string" || !/^[A-Za-z0-9_-]{40,}$/.test(value.token)) {
      throw new InvalidInvitationInput();
    }
    return this.#repository.acceptInvitation(hashToken(value.token), accountId, new Date().toISOString());
  }

  readProject(accountId: string, projectId: string) {
    if (!isUuid(projectId)) throw new InvalidInvitationInput();
    return this.#repository.readProject(accountId, projectId);
  }

  async canWriteProject(accountId: string, projectId: string) {
    if (!isUuid(projectId)) throw new InvalidInvitationInput();
    return this.#repository.canWriteProject(accountId, projectId);
  }
}

function hashToken(token: string): string { return createHash("sha256").update(token).digest("hex"); }
function isPlainObject(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === "object" && !Array.isArray(value); }
function isInvitationInput(value: unknown): value is { kind: "member"; role: BuiltInOrganizationRole } | { kind: "guest"; projectIds: string[] } {
  if (!isPlainObject(value)) return false;
  if (value.kind === "member") return Object.keys(value).length === 2 && ["Owner", "Admin", "Member"].includes(value.role as string);
  return value.kind === "guest" && Object.keys(value).length === 2 && Array.isArray(value.projectIds)
    && value.projectIds.length > 0 && value.projectIds.length <= 100 && value.projectIds.every(isUuid);
}
