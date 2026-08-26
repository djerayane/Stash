export const builtInOrganizationRoles = ["Owner", "Admin", "Member"] as const;
export type BuiltInOrganizationRole = (typeof builtInOrganizationRoles)[number];
export type OrganizationPermission =
  | "organization.roles.manage"
  | "organization.members.manage"
  | "workspace.create"
  | "create_project";

export const builtInProjectCreationPermissions = {
  Owner: ["create_project"],
  Admin: ["create_project"],
  Member: [],
} as const;

const builtInRoleDefinitions: ReadonlyArray<{
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

  listBuiltInRoles() {
    return builtInRoleDefinitions;
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

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function validMemberId(value: string): boolean {
  return isUuid(value);
}
