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

export interface PortableIdentity {
  localAccountId: string;
  displayName: string;
}

export interface PortableOrganizationIdentity {
  localOrganizationId: string;
  displayName: string;
}

export interface PortableWorkspaceProjection {
  schema: "stash.workspace.v1";
  id: string;
  name: string;
  owner:
    | { type: "personal"; identity: PortableIdentity }
    | { type: "organization"; identity: PortableOrganizationIdentity };
  createdBy: PortableIdentity;
}

export interface PortableProjectProjection {
  schema: "stash.project.v1";
  id: string;
  workspaceId: string;
  name: string;
  key: string;
  createdBy: PortableIdentity;
}

export interface WorkspaceProjectRepository {
  findPortableMemberIdentity(memberId: string): Promise<PortableIdentity | undefined>;
  findPortableOrganizationIdentity(
    organizationId: string,
  ): Promise<PortableOrganizationIdentity | undefined>;
  createWorkspace(
    record: WorkspaceRecord,
    projection: PortableWorkspaceProjection,
  ): Promise<"created" | "organization_forbidden">;
  createProject(
    memberId: string,
    record: WorkspaceProjectRecord,
    projection: PortableProjectProjection,
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
    && isUuid(value.owner.organizationId)
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

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

export class WorkspaceProjectService {
  readonly #repository: WorkspaceProjectRepository;

  constructor(repository: WorkspaceProjectRepository) {
    this.#repository = repository;
  }

  async createWorkspace(memberId: string, value: unknown): Promise<
    | {
      status: "created";
      workspace: WorkspaceRecord;
      projection: PortableWorkspaceProjection;
    }
    | { status: "organization_forbidden" }
  > {
    if (!isWorkspaceInput(value)) throw new InvalidWorkspaceInput();
    const createdBy = await this.#repository.findPortableMemberIdentity(memberId);
    if (!createdBy) throw new Error("member_identity_unavailable");
    let portableOwner: PortableWorkspaceProjection["owner"];
    if (value.owner.type === "personal") {
      portableOwner = { type: "personal", identity: createdBy };
    } else {
      const identity = await this.#repository.findPortableOrganizationIdentity(
        value.owner.organizationId,
      );
      if (!identity) return { status: "organization_forbidden" };
      portableOwner = { type: "organization", identity };
    }
    const workspace: WorkspaceRecord = {
      id: randomUUID(),
      name: value.name.trim(),
      owner: value.owner.type === "personal"
        ? { type: "personal", id: memberId }
        : { type: "organization", id: value.owner.organizationId },
      createdByMemberId: memberId,
    };
    const projection: PortableWorkspaceProjection = {
      schema: "stash.workspace.v1",
      id: workspace.id,
      name: workspace.name,
      owner: portableOwner,
      createdBy,
    };
    const status = await this.#repository.createWorkspace(workspace, projection);
    return status === "created" ? { status, workspace, projection } : { status };
  }

  async createProject(memberId: string, workspaceId: string, value: unknown): Promise<
    | {
      status: "created";
      project: WorkspaceProjectRecord;
      projection: PortableProjectProjection;
    }
    | { status: "workspace_forbidden" | "workspace_not_found" | "key_conflict" }
  > {
    if (!isUuid(workspaceId) || !isProjectInput(value)) throw new InvalidProjectInput();
    const createdBy = await this.#repository.findPortableMemberIdentity(memberId);
    if (!createdBy) throw new Error("member_identity_unavailable");
    const project: WorkspaceProjectRecord = {
      id: randomUUID(),
      workspaceId,
      name: value.name.trim(),
      key: value.key.toUpperCase(),
      createdByMemberId: memberId,
    };
    const projection: PortableProjectProjection = {
      schema: "stash.project.v1",
      id: project.id,
      workspaceId: project.workspaceId,
      name: project.name,
      key: project.key,
      createdBy,
    };
    const status = await this.#repository.createProject(memberId, project, projection);
    return status === "created" ? { status, project, projection } : { status };
  }
}
