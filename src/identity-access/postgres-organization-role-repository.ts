import { randomUUID } from "node:crypto";
import type { PostgresKernel, PostgresQueryable } from "../instance-operations/storage/postgres-kernel.js";
import type { BuiltInOrganizationRole, CustomOrganizationRole, MemberDeparture } from "../organization-roles.js";

type PrepareOrganizations = (client: PostgresQueryable) => Promise<void>;

/** Identity-access-owned custom Role persistence and administrator policy. */
export class PostgresOrganizationRoleRepository {
  constructor(private readonly kernel: PostgresKernel, private readonly prepareOrganizations: PrepareOrganizations,
    private readonly departure: {
      prepareAuthority(client:PostgresQueryable):Promise<void>;
      markFormerAssignments(client:PostgresQueryable,organizationId:string,accountId:string,actorId:string):Promise<string[]>;
      degradePersonalConnections(client:PostgresQueryable,organizationId:string,accountId:string):Promise<string[]>;
    }) {}

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

  async lockedMemberships(client:PostgresQueryable,organizationId:string){await this.prepareOrganizations(client);return (await client.query<{
    account_id:string;role:BuiltInOrganizationRole}>("SELECT account_id,role FROM stash_organization_memberships WHERE organization_id=$1 FOR UPDATE",
  [organizationId])).rows;}

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

  async assignBuiltInRole(organizationId:string,actorId:string,accountId:string,role:BuiltInOrganizationRole) {
    return this.kernel.transaction(async(client)=>{await this.prepare(client);
      const memberships=(await client.query<{account_id:string;role:BuiltInOrganizationRole}>(
        "SELECT account_id,role FROM stash_organization_memberships WHERE organization_id=$1 FOR UPDATE",[organizationId])).rows;
      if(!memberships.some((member)=>member.account_id===actorId&&member.role==="Owner"))return "forbidden" as const;
      const target=memberships.find((member)=>member.account_id===accountId);if(!target)return "member_not_found" as const;
      if(target.role==="Owner"&&role!=="Owner"&&memberships.filter((member)=>member.role==="Owner").length===1)return "final_owner" as const;
      await client.query("UPDATE stash_organization_memberships SET role=$3 WHERE organization_id=$1 AND account_id=$2",[organizationId,accountId,role]);
      return "updated" as const;});
  }

  async removeOrganizationMember(organizationId:string,actorId:string,accountId:string):Promise<
    {status:"removed";departure:MemberDeparture}|"member_not_found"|"final_owner"|"forbidden">{
    return this.kernel.transaction(async(client)=>{await this.departure.prepareAuthority(client);
      const memberships=(await client.query<{account_id:string;role:BuiltInOrganizationRole}>(
        "SELECT account_id,role FROM stash_organization_memberships WHERE organization_id=$1 FOR UPDATE",[organizationId])).rows;
      const actorRole=memberships.find((member)=>member.account_id===actorId)?.role;
      if(actorRole!=="Owner"&&actorRole!=="Admin")return "forbidden";const target=memberships.find((member)=>member.account_id===accountId);
      if(!target)return "member_not_found";if(target.role==="Owner"&&memberships.filter((member)=>member.role==="Owner").length===1)return "final_owner";
      if(actorRole==="Admin"&&target.role==="Owner")return "forbidden";await this.removeAssignmentsForMember(client,organizationId,accountId);
      const affectedTaskIds=await this.departure.markFormerAssignments(client,organizationId,accountId,actorId);
      await client.query("DELETE FROM stash_organization_memberships WHERE organization_id=$1 AND account_id=$2",[organizationId,accountId]);
      const authorityTables=await client.query<{tablename:string}>(`SELECT tablename FROM pg_tables WHERE schemaname=current_schema()
        AND tablename=ANY($1::text[])`,[["stash_sessions","stash_personal_access_tokens"]]);const present=new Set(authorityTables.rows.map(({tablename})=>tablename));
      const sessions=present.has("stash_sessions")?await client.query("DELETE FROM stash_sessions WHERE account_id=$1",[accountId]):{rowCount:0};
      const personalTokens=present.has("stash_personal_access_tokens")?await client.query(`UPDATE stash_personal_access_tokens SET revoked_at=CURRENT_TIMESTAMP
        WHERE organization_id=$1 AND account_id=$2 AND revoked_at IS NULL`,[organizationId,accountId]):{rowCount:0};
      const grants=await client.query(`UPDATE stash_agent_grants SET revoked_at=CURRENT_TIMESTAMP
        WHERE organization_id=$1 AND sponsoring_member_id=$2 AND revoked_at IS NULL`,[organizationId,accountId]);
      const degradedRepositoryConnectionIds=await this.departure.degradePersonalConnections(client,organizationId,accountId);
      const revokedSessions=sessions.rowCount??0,revokedCredentials=personalTokens.rowCount??0,revokedAgentGrants=grants.rowCount??0;
      await client.query(`INSERT INTO stash_operator_audit(id,action,actor_account_id,organization_id,target_account_id,occurred_at,before_state,after_state)
        VALUES($1,'organization_member_departed',$2,$3,$4,CURRENT_TIMESTAMP,$5::jsonb,$6::jsonb)`,[randomUUID(),actorId,organizationId,accountId,
        JSON.stringify({role:target.role,active:true}),JSON.stringify({active:false,affectedTaskIds,degradedRepositoryConnectionIds,
          revokedSessions,revokedCredentials,revokedAgentGrants})]);
      return {status:"removed" as const,departure:{memberId:accountId,affectedTaskIds,revokedSessions,revokedCredentials,revokedAgentGrants,
        degradedRepositoryConnectionIds}};});
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
