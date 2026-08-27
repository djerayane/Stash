export const builtInOrganizationRoles = ["Owner", "Admin", "Member"] as const;
export type BuiltInOrganizationRole = (typeof builtInOrganizationRoles)[number];
export type OrganizationPermission =
  | "organization.roles.manage"
  | "organization.members.manage"
  | "workspace.create"
  | "create_project";

export interface CustomOrganizationRole {
  id: string;
  name: string;
  immutable: false;
  permissions: Array<Extract<OrganizationPermission, "create_project">>;
  memberIds: string[];
}

export const builtInOrganizationRoleDefinitions: ReadonlyArray<{
  name: BuiltInOrganizationRole;
  immutable: true;
  permissions: readonly OrganizationPermission[];
}> = [
  {
    name: "Owner",
    immutable: true,
    permissions: [
      "organization.roles.manage",
      "organization.members.manage",
      "workspace.create",
      "create_project",
    ],
  },
  {
    name: "Admin",
    immutable: true,
    permissions: ["organization.members.manage", "workspace.create", "create_project"],
  },
  {
    name: "Member",
    immutable: true,
    permissions: ["workspace.create"],
  },
];

export const builtInProjectCreationPermissions = builtInOrganizationRoleDefinitions.reduce((permissions, role) => ({
  ...permissions, [role.name]: role.permissions.includes("create_project") ? ["create_project"] : [],
}), {} as Record<BuiltInOrganizationRole, readonly Extract<OrganizationPermission, "create_project">[]>);

export function builtInRolesWithPermission(permission: OrganizationPermission): BuiltInOrganizationRole[] {
  return builtInOrganizationRoleDefinitions.filter((role) => role.permissions.includes(permission)).map(({ name }) => name);
}

type MembershipMutationResult = "updated" | "member_not_found" | "final_owner";

export interface MemberDeparture {
  memberId: string;
  affectedTaskIds: string[];
  revokedSessions: number;
  revokedCredentials: number;
  revokedAgentGrants: number;
  degradedRepositoryConnectionIds: string[];
}

export interface OrganizationRoleRepository {
  organizationRole(
    organizationId: string,
    accountId: string,
  ): Promise<BuiltInOrganizationRole | undefined>;
  assignBuiltInRole(
    organizationId: string,
    actorId: string,
    accountId: string,
    role: BuiltInOrganizationRole,
  ): Promise<Extract<MembershipMutationResult, "updated" | "member_not_found" | "final_owner"> | "forbidden">;
  removeOrganizationMember(
    organizationId: string,
    actorId: string,
    accountId: string,
  ): Promise<{ status: "removed"; departure: MemberDeparture }
    | Extract<MembershipMutationResult, "member_not_found" | "final_owner"> | "forbidden">;
  listCustomRoles(organizationId: string): Promise<CustomOrganizationRole[]>;
  createCustomRole(organizationId: string, actorId: string, role: CustomOrganizationRole): Promise<"created" | "forbidden" | "name_conflict">;
  updateCustomRole(organizationId: string, actorId: string, roleId: string,
    input: { name: string; permissions: CustomOrganizationRole["permissions"] }): Promise<"updated" | "forbidden" | "role_not_found" | "name_conflict">;
  assignCustomRole(organizationId: string, actorId: string, roleId: string, memberId: string): Promise<"updated" | "forbidden" | "role_not_found" | "member_not_found">;
  revokeCustomRole(organizationId: string, actorId: string, roleId: string, memberId: string): Promise<"updated" | "forbidden" | "role_not_found" | "member_not_found">;
}

export class InvalidOrganizationRoleInput extends Error {}

export class OrganizationRoleService {
  readonly #repository: OrganizationRoleRepository;

  constructor(repository: OrganizationRoleRepository) {
    this.#repository = repository;
  }

  async authorizeOwner(organizationId: string, actorId: string): Promise<boolean> {
    if (!isUuid(organizationId)) throw new InvalidOrganizationRoleInput();
    return await this.#repository.organizationRole(organizationId, actorId) === "Owner";
  }

  async listRoles(organizationId: string) {
    if (!isUuid(organizationId)) throw new InvalidOrganizationRoleInput();
    return [...builtInOrganizationRoleDefinitions, ...await this.#repository.listCustomRoles(organizationId)];
  }

  async createCustom(organizationId: string, actorId: string, value: unknown) {
    const input = customRoleInput(value);
    if (!isUuid(organizationId) || !input) throw new InvalidOrganizationRoleInput();
    const role: CustomOrganizationRole = { id: randomUUID(), immutable: false, memberIds: [], ...input };
    return { result: await this.#repository.createCustomRole(organizationId, actorId, role), role };
  }

  updateCustom(organizationId: string, actorId: string, roleId: string, value: unknown) {
    const input = customRoleInput(value);
    if (!isUuid(organizationId) || !isUuid(roleId) || !input) throw new InvalidOrganizationRoleInput();
    return this.#repository.updateCustomRole(organizationId, actorId, roleId, input);
  }

  assignCustom(organizationId: string, actorId: string, roleId: string, memberId: string) {
    if (![organizationId, roleId, memberId].every(isUuid)) throw new InvalidOrganizationRoleInput();
    return this.#repository.assignCustomRole(organizationId, actorId, roleId, memberId);
  }

  revokeCustom(organizationId: string, actorId: string, roleId: string, memberId: string) {
    if (![organizationId, roleId, memberId].every(isUuid)) throw new InvalidOrganizationRoleInput();
    return this.#repository.revokeCustomRole(organizationId, actorId, roleId, memberId);
  }

  async assign(
    organizationId: string,
    actorId: string,
    memberId: string,
    value: unknown,
  ) {
    if (!isRoleInput(value) || !validMemberId(memberId)) throw new InvalidOrganizationRoleInput();
    return this.#repository.assignBuiltInRole(organizationId, actorId, memberId, value.role);
  }

  async remove(organizationId: string, actorId: string, memberId: string) {
    if (!validMemberId(memberId)) throw new InvalidOrganizationRoleInput();
    return this.#repository.removeOrganizationMember(organizationId, actorId, memberId);
  }
}

function isRoleInput(value: unknown): value is { role: BuiltInOrganizationRole } {
  return value !== null
    && typeof value === "object"
    && !Array.isArray(value)
    && Object.keys(value).length === 1
    && "role" in value
    && builtInOrganizationRoles.includes(value.role as BuiltInOrganizationRole);
}

function customRoleInput(value: unknown): { name: string; permissions: Array<"create_project"> } | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const input = value as Record<string, unknown>;
  if (!Object.keys(input).every((key) => key === "name" || key === "permissions")
    || typeof input.name !== "string" || !input.name.trim() || input.name.trim().length > 100 || /[\r\n]/.test(input.name)
    || !Array.isArray(input.permissions) || !input.permissions.every((permission) => permission === "create_project")
    || new Set(input.permissions).size !== input.permissions.length) return undefined;
  return { name: input.name.trim(), permissions: input.permissions as Array<"create_project"> };
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function validMemberId(value: string): boolean {
  return isUuid(value);
}
import { randomUUID } from "node:crypto";
