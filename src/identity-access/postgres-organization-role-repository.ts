import type { PostgresKernel, PostgresQueryable } from "../instance-operations/storage/postgres-kernel.js";
import type { CustomOrganizationRole } from "../organization-roles.js";

type PrepareOrganizations = (client: PostgresQueryable) => Promise<void>;

/** Identity-access-owned custom Role persistence and administrator policy. */
export class PostgresOrganizationRoleRepository {
  constructor(private readonly kernel: PostgresKernel, private readonly prepareOrganizations: PrepareOrganizations) {}

  async prepare(client: PostgresQueryable): Promise<void> {
    await this.prepareOrganizations(client);
    await client.query(`
      CREATE TABLE IF NOT EXISTS stash_organization_custom_roles (
        id UUID PRIMARY KEY,
        organization_id UUID NOT NULL REFERENCES stash_organizations(id) ON DELETE CASCADE,
        name TEXT NOT NULL CHECK (char_length(name) BETWEEN 1 AND 100),
        UNIQUE (organization_id, name)
      );
      CREATE TABLE IF NOT EXISTS stash_organization_custom_role_permissions (
        role_id UUID NOT NULL REFERENCES stash_organization_custom_roles(id) ON DELETE CASCADE,
        permission TEXT NOT NULL CHECK (permission IN ('create_project')),
        PRIMARY KEY (role_id, permission)
      );
      CREATE TABLE IF NOT EXISTS stash_organization_custom_role_assignments (
        role_id UUID NOT NULL REFERENCES stash_organization_custom_roles(id) ON DELETE CASCADE,
        account_id UUID NOT NULL REFERENCES stash_accounts(id) ON DELETE CASCADE,
        PRIMARY KEY (role_id, account_id)
      );
    `);
  }

  async listCustomRoles(organizationId: string): Promise<CustomOrganizationRole[]> {
    return this.kernel.withSession(async (client) => {
      await this.prepare(client);
      const result = await client.query<any>(`SELECT role.id,role.name,
        ARRAY(SELECT permission FROM stash_organization_custom_role_permissions WHERE role_id=role.id ORDER BY permission) permissions,
        ARRAY(SELECT assignment.account_id FROM stash_organization_custom_role_assignments assignment
          JOIN stash_organization_memberships membership ON membership.organization_id=role.organization_id
            AND membership.account_id=assignment.account_id
          WHERE assignment.role_id=role.id ORDER BY assignment.account_id) member_ids
        FROM stash_organization_custom_roles role WHERE role.organization_id=$1 ORDER BY role.name,role.id`, [organizationId]);
      return result.rows.map((row: any) => ({ id: row.id, name: row.name, immutable: false,
        permissions: row.permissions, memberIds: row.member_ids }));
    });
  }

  async createCustomRole(organizationId: string, actorId: string, role: CustomOrganizationRole) {
    return this.kernel.transaction(async (client) => {
      await this.prepare(client);
      if (!await this.owner(client, organizationId, actorId)) return "forbidden" as const;
      const inserted = await client.query(`INSERT INTO stash_organization_custom_roles(id,organization_id,name)
        VALUES($1,$2,$3) ON CONFLICT(organization_id,name) DO NOTHING RETURNING id`, [role.id, organizationId, role.name]);
      if (!inserted.rowCount) return "name_conflict" as const;
      await this.replacePermissions(client, role.id, role.permissions);
      return "created" as const;
    });
  }

  async updateCustomRole(organizationId: string, actorId: string, roleId: string,
    input: { name: string; permissions: Array<"create_project"> }) {
    return this.kernel.transaction(async (client) => {
      await this.prepare(client);
      if (!await this.owner(client, organizationId, actorId)) return "forbidden" as const;
      const found = await client.query("SELECT 1 FROM stash_organization_custom_roles WHERE id=$1 AND organization_id=$2 FOR UPDATE", [roleId, organizationId]);
      if (!found.rowCount) return "role_not_found" as const;
      const conflict = await client.query("SELECT 1 FROM stash_organization_custom_roles WHERE organization_id=$1 AND name=$2 AND id<>$3", [organizationId, input.name, roleId]);
      if (conflict.rowCount) return "name_conflict" as const;
      await client.query("UPDATE stash_organization_custom_roles SET name=$3 WHERE id=$1 AND organization_id=$2", [roleId, organizationId, input.name]);
      await this.replacePermissions(client, roleId, input.permissions);
      return "updated" as const;
    });
  }

  async assignCustomRole(organizationId: string, actorId: string, roleId: string, memberId: string) {
    return this.kernel.transaction(async (client) => {
      await this.prepare(client);
      if (!await this.owner(client, organizationId, actorId)) return "forbidden" as const;
      if (!(await client.query("SELECT 1 FROM stash_organization_custom_roles WHERE id=$1 AND organization_id=$2", [roleId, organizationId])).rowCount)
        return "role_not_found" as const;
      if (!(await client.query("SELECT 1 FROM stash_organization_memberships WHERE organization_id=$1 AND account_id=$2", [organizationId, memberId])).rowCount)
        return "member_not_found" as const;
      await client.query(`INSERT INTO stash_organization_custom_role_assignments(role_id,account_id) VALUES($1,$2)
        ON CONFLICT DO NOTHING`, [roleId, memberId]);
      return "updated" as const;
    });
  }

  async revokeCustomRole(organizationId: string, actorId: string, roleId: string, memberId: string) {
    return this.kernel.transaction(async (client) => {
      await this.prepare(client);
      if (!await this.owner(client, organizationId, actorId)) return "forbidden" as const;
      if (!(await client.query("SELECT 1 FROM stash_organization_custom_roles WHERE id=$1 AND organization_id=$2", [roleId, organizationId])).rowCount)
        return "role_not_found" as const;
      if (!(await client.query("SELECT 1 FROM stash_organization_memberships WHERE organization_id=$1 AND account_id=$2", [organizationId, memberId])).rowCount)
        return "member_not_found" as const;
      await client.query("DELETE FROM stash_organization_custom_role_assignments WHERE role_id=$1 AND account_id=$2", [roleId, memberId]);
      return "updated" as const;
    });
  }

  async removeAssignmentsForMember(client: PostgresQueryable, organizationId: string, memberId: string): Promise<void> {
    await this.prepare(client);
    await client.query(`DELETE FROM stash_organization_custom_role_assignments assignment USING stash_organization_custom_roles role
      WHERE assignment.role_id=role.id AND role.organization_id=$1 AND assignment.account_id=$2`, [organizationId, memberId]);
  }

  private async owner(client: PostgresQueryable, organizationId: string, actorId: string): Promise<boolean> {
    return Boolean((await client.query(`SELECT 1 FROM stash_organization_memberships
      WHERE organization_id=$1 AND account_id=$2 AND role='Owner'`, [organizationId, actorId])).rowCount);
  }

  private async replacePermissions(client: PostgresQueryable, roleId: string, permissions: Array<"create_project">): Promise<void> {
    await client.query("DELETE FROM stash_organization_custom_role_permissions WHERE role_id=$1", [roleId]);
    for (const permission of permissions) await client.query(
      "INSERT INTO stash_organization_custom_role_permissions(role_id,permission) VALUES($1,$2)", [roleId, permission]);
  }
}
