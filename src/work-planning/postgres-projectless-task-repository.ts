import type { PostgresKernel, PostgresQueryable } from "../instance-operations/storage/postgres-kernel.js";
import type { ProjectlessTaskRepository } from "./projectless-tasks.js";

type PrepareTasks = (client: PostgresQueryable) => Promise<void>;

/** Work-planning-owned read adapter for Workspace Tasks that have no Project execution context. */
export class PostgresProjectlessTaskRepository implements ProjectlessTaskRepository {
  constructor(private readonly kernel: PostgresKernel, private readonly prepareTasks: PrepareTasks) {}

  async listProjectlessTasks(memberId: string, workspaceId: string) {
    return this.kernel.withSession(async (client) => {
      await this.prepareTasks(client);
      const access = await client.query<{ allowed: boolean }>(`SELECT
        ((workspace.owner_type='personal' AND workspace.personal_owner_id=$2) OR
         (workspace.owner_type='organization' AND EXISTS (SELECT 1 FROM stash_organization_memberships membership
           WHERE membership.organization_id=workspace.organization_owner_id AND membership.account_id=$2))) AS allowed
        FROM stash_workspaces workspace WHERE workspace.id=$1`, [workspaceId, memberId]);
      if (!access.rows[0]?.allowed) return { status: "workspace_forbidden" as const };
      const result = await client.query<any>(`SELECT task.id,task.workspace_id,task.title,
        status.id status_id,status.name status_name,status.category status_category
        FROM stash_tasks task JOIN stash_workspace_workflow_statuses status ON status.id=task.workspace_workflow_status_id
        WHERE task.workspace_id=$1 AND task.project_id IS NULL ORDER BY task.title,task.id`, [workspaceId]);
      return { status: "found" as const, tasks: result.rows.map((row: any) => ({ id: row.id, workspaceId: row.workspace_id,
        title: row.title, status: { id: row.status_id, name: row.status_name, category: row.status_category } })) };
    });
  }
}
