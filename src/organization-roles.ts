export const builtInOrganizationRoles = ["Owner", "Admin", "Member"] as const;
export type BuiltInOrganizationRole = (typeof builtInOrganizationRoles)[number];

type MembershipMutationResult = "updated" | "removed" | "member_not_found" | "final_owner";

export interface OrganizationRoleRepository {
  organizationRole(
    organizationId: string,
    accountId: string,
  ): Promise<BuiltInOrganizationRole | undefined>;
  assignBuiltInRole(
    organizationId: string,
    accountId: string,
    role: BuiltInOrganizationRole,
  ): Promise<Extract<MembershipMutationResult, "updated" | "member_not_found" | "final_owner">>;
  removeOrganizationMember(
    organizationId: string,
    accountId: string,
  ): Promise<Extract<MembershipMutationResult, "removed" | "member_not_found" | "final_owner">>;
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
    return builtInOrganizationRoles.map((name) => ({ name, immutable: true as const }));
  }

  async assign(
    organizationId: string,
    memberId: string,
    value: unknown,
  ) {
    if (!isRoleInput(value) || !validMemberId(memberId)) throw new InvalidOrganizationRoleInput();
    return this.#repository.assignBuiltInRole(organizationId, memberId, value.role);
  }

  async remove(organizationId: string, memberId: string) {
    if (!validMemberId(memberId)) throw new InvalidOrganizationRoleInput();
    return this.#repository.removeOrganizationMember(organizationId, memberId);
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
  return value.length > 0 && value.length <= 200;
}
