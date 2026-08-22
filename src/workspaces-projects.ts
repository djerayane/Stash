import { randomUUID } from "node:crypto";
import type { PasswordAuthService } from "./password-auth.js";

export type MemberAccessResolver = Pick<PasswordAuthService, "authenticateBearer">;

export type WorkspaceOwner =
  | { type: "personal"; id: string }
  | { type: "organization"; id: string };

export interface WorkspaceRecord {
  id: string;
  name: string;
  owner: WorkspaceOwner;
  createdByMemberId: string;
}

export interface WorkspaceProjectRecord {
  id: string;
  workspaceId: string;
  name: string;
  key: string;
  createdByMemberId: string;
}

export interface WorkspaceProjectRepository {
  createWorkspace(record: WorkspaceRecord): Promise<"created" | "organization_forbidden">;
  createProject(
    memberId: string,
    record: WorkspaceProjectRecord,
  ): Promise<"created" | "workspace_forbidden" | "workspace_not_found" | "key_conflict">;
}

export class InvalidWorkspaceInput extends Error {}
export class InvalidProjectInput extends Error {}

interface WorkspaceInput {
  name: string;
  owner: { type: "personal" } | { type: "organization"; organizationId: string };
}

interface ProjectInput {
  name: string;
  key: string;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isWorkspaceInput(value: unknown): value is WorkspaceInput {
  if (!isPlainObject(value) || !isPlainObject(value.owner)) return false;
  if (typeof value.name !== "string" || value.name.trim().length < 1 || value.name.trim().length > 200) {
    return false;
  }
  if (value.owner.type === "personal") {
    return Object.keys(value.owner).length === 1;
  }
  return value.owner.type === "organization"
    && typeof value.owner.organizationId === "string"
    && value.owner.organizationId.length > 0
    && value.owner.organizationId.length <= 200
    && Object.keys(value.owner).length === 2;
}

function isProjectInput(value: unknown): value is ProjectInput {
  return isPlainObject(value)
    && typeof value.name === "string"
    && value.name.trim().length > 0
    && value.name.trim().length <= 200
    && typeof value.key === "string"
    && /^[A-Za-z][A-Za-z0-9-]{1,19}$/.test(value.key);
}

export class WorkspaceProjectService {
  readonly #repository: WorkspaceProjectRepository;

  constructor(repository: WorkspaceProjectRepository) {
    this.#repository = repository;
  }

  async createWorkspace(memberId: string, value: unknown): Promise<
    | { status: "created"; workspace: WorkspaceRecord }
    | { status: "organization_forbidden" }
  > {
    if (!isWorkspaceInput(value)) throw new InvalidWorkspaceInput();
    const workspace: WorkspaceRecord = {
      id: randomUUID(),
      name: value.name.trim(),
      owner: value.owner.type === "personal"
        ? { type: "personal", id: memberId }
        : { type: "organization", id: value.owner.organizationId },
      createdByMemberId: memberId,
    };
    const status = await this.#repository.createWorkspace(workspace);
    return status === "created" ? { status, workspace } : { status };
  }

  async createProject(memberId: string, workspaceId: string, value: unknown): Promise<
    | { status: "created"; project: WorkspaceProjectRecord }
    | { status: "workspace_forbidden" | "workspace_not_found" | "key_conflict" }
  > {
    if (!workspaceId || !isProjectInput(value)) throw new InvalidProjectInput();
    const project: WorkspaceProjectRecord = {
      id: randomUUID(),
      workspaceId,
      name: value.name.trim(),
      key: value.key.toUpperCase(),
      createdByMemberId: memberId,
    };
    const status = await this.#repository.createProject(memberId, project);
    return status === "created" ? { status, project } : { status };
  }
}
