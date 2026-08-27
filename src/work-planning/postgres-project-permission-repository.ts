import type { PostgresKernel, PostgresQueryable } from "../instance-operations/storage/postgres-kernel.js";

type PrepareProjects = (client: PostgresQueryable) => Promise<void>;

const permission = (workspace: string, member = "$2") => `((${workspace}.owner_type='personal'
  AND ${workspace}.personal_owner_id=${member}) OR (${workspace}.owner_type='organization' AND EXISTS (
    SELECT 1 FROM stash_organization_memberships membership
    WHERE membership.organization_id=${workspace}.organization_owner_id AND membership.account_id=${member}
      AND membership.role IN ('Owner','Admin')
  )) OR (${workspace}.owner_type='organization' AND EXISTS (
    SELECT 1 FROM stash_organization_custom_role_assignments assignment
    JOIN stash_organization_custom_roles role ON role.id=assignment.role_id
    JOIN stash_organization_custom_role_permissions role_permission ON role_permission.role_id=role.id
    JOIN stash_organization_memberships membership ON membership.organization_id=role.organization_id
      AND membership.account_id=assignment.account_id
    WHERE role.organization_id=${workspace}.organization_owner_id AND assignment.account_id=${member}
      AND role_permission.permission='create_project'
  )))`;

/** Work-planning-owned Project creation policy over focused identity Role tables. */
export class PostgresProjectPermissionRepository {
  constructor(private readonly kernel: PostgresKernel, private readonly prepareProjects: PrepareProjects) {}

  async authorize(client: PostgresQueryable, memberId: string, workspaceId: string): Promise<{ found: boolean; allowed: boolean }> {
    await this.prepareProjects(client);
    const result = await client.query<{ allowed: boolean }>(
      `SELECT ${permission("workspace")} AS allowed FROM stash_workspaces workspace WHERE workspace.id=$1`, [workspaceId, memberId]);
    return { found: Boolean(result.rowCount), allowed: result.rows[0]?.allowed === true };
  }

  async canCreateProject(memberId: string, workspaceId: string): Promise<boolean> {
    return this.kernel.withSession(async (client) => (await this.authorize(client, memberId, workspaceId)).allowed);
  }
}
