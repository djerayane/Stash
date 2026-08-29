import { createHash, randomUUID } from "node:crypto";
import type { PostgresKernel, PostgresQueryable } from "../instance-operations/storage/postgres-kernel.js";
import type { CanonicalTask, CanonicalTaskChanges, CanonicalTaskRepository, WorkspaceWorkflow } from "./canonical-tasks.js";

type Prepare = (client: PostgresQueryable) => Promise<void>;
type CanReadNote = (memberId: string, noteId: string) => Promise<boolean>;
const access = `((workspace.owner_type='personal' AND workspace.personal_owner_id=$2) OR
  (workspace.owner_type='organization' AND EXISTS (SELECT 1 FROM stash_organization_memberships membership
    WHERE membership.organization_id=workspace.organization_owner_id AND membership.account_id=$2)))`;

export class PostgresCanonicalTaskRepository implements CanonicalTaskRepository {
  constructor(private readonly kernel: PostgresKernel, private readonly prepareBase: Prepare,
    private readonly canReadNote?: CanReadNote) {}
  async prepare(client: PostgresQueryable) {
    await this.prepareBase(client);
    await client.query(`CREATE TABLE IF NOT EXISTS stash_canonical_task_operations(
      task_id UUID NOT NULL REFERENCES stash_tasks(id) ON DELETE CASCADE,operation_id UUID NOT NULL,digest TEXT NOT NULL,outcome JSONB NOT NULL,
      PRIMARY KEY(task_id,operation_id))`);
  }
  async ensureWorkflow(client: PostgresQueryable, workspaceId: string): Promise<WorkspaceWorkflow> {
    const current = await client.query<any>(`SELECT id,name,category,position FROM stash_workspace_workflow_statuses
      WHERE workspace_id=$1 ORDER BY position,id`, [workspaceId]);
    if (!current.rows.length) {
      for (const [name, category, position] of [["To do", "unstarted", 1], ["In progress", "started", 2], ["Done", "completed", 3]] as const)
        await client.query("INSERT INTO stash_workspace_workflow_statuses(id,workspace_id,name,category,position) VALUES($1,$2,$3,$4,$5)",
          [randomUUID(), workspaceId, name, category, position]);
    }
    const statuses = await client.query<any>(`SELECT id,name,category,position FROM stash_workspace_workflow_statuses
      WHERE workspace_id=$1 ORDER BY position,id`, [workspaceId]);
    await client.query(`UPDATE stash_tasks task SET workspace_workflow_status_id=canonical.id
      FROM stash_workflow_statuses legacy JOIN stash_workspace_workflow_statuses canonical
        ON canonical.workspace_id=$1 AND canonical.category=legacy.category
      WHERE task.workspace_id=$1 AND task.workspace_workflow_status_id IS NULL AND task.workflow_status_id=legacy.id`, [workspaceId]);
    return { schema: "stash.workspace-workflow.v1", workspaceId, statuses: statuses.rows.map((row: any) => ({ id: row.id, name: row.name,
      category: row.category === "canceled" ? "completed" : row.category, position: Number(row.position) })) };
  }
  async workspaceAccess(client: PostgresQueryable, memberId: string, workspaceId: string) {
    return (await client.query<{ full_member: boolean }>(`SELECT ${access} full_member FROM stash_workspaces workspace WHERE workspace.id=$1
      AND (${access} OR EXISTS(SELECT 1 FROM stash_projects project JOIN stash_project_guests guest ON guest.project_id=project.id
        WHERE project.workspace_id=workspace.id AND guest.account_id=$2))`, [workspaceId, memberId])).rows[0];
  }
  async canonical(client: PostgresQueryable, taskId: string, memberId?: string): Promise<CanonicalTask> {
    const row = (await client.query<any>(`SELECT task.*,status.name status_name,status.category status_category,status.position status_position
      ,creator.name created_by_name FROM stash_tasks task JOIN stash_workspace_workflow_statuses status ON status.id=task.workspace_workflow_status_id
      JOIN stash_accounts creator ON creator.id=task.created_by_account_id WHERE task.id=$1`, [taskId])).rows[0];
    const links = await client.query<any>(`SELECT association.project_id,association.task_key FROM stash_task_projects association
      WHERE association.task_id=$1 AND ($2::uuid IS NULL OR EXISTS(SELECT 1 FROM stash_tasks task JOIN stash_workspaces workspace
        ON workspace.id=task.workspace_id WHERE task.id=association.task_id AND ((workspace.owner_type='personal' AND workspace.personal_owner_id=$2)
          OR (workspace.owner_type='organization' AND EXISTS(SELECT 1 FROM stash_organization_memberships membership
            WHERE membership.organization_id=workspace.organization_owner_id AND membership.account_id=$2))
          OR EXISTS(SELECT 1 FROM stash_project_guests guest WHERE guest.project_id=association.project_id AND guest.account_id=$2))))
      ORDER BY association.project_id`, [taskId, memberId ?? null]);
    const aliases = await client.query<any>(`SELECT alias.project_id,alias.task_key FROM stash_task_key_aliases alias WHERE task_id=$1
      AND NOT EXISTS(SELECT 1 FROM stash_task_projects active WHERE active.task_id=alias.task_id AND active.project_id=alias.project_id AND active.task_key=alias.task_key)
      AND ($2::uuid IS NULL OR EXISTS(SELECT 1 FROM stash_tasks task JOIN stash_workspaces workspace ON workspace.id=task.workspace_id
        WHERE task.id=alias.task_id AND ((workspace.owner_type='personal' AND workspace.personal_owner_id=$2)
          OR (workspace.owner_type='organization' AND EXISTS(SELECT 1 FROM stash_organization_memberships membership
            WHERE membership.organization_id=workspace.organization_owner_id AND membership.account_id=$2))
          OR EXISTS(SELECT 1 FROM stash_project_guests guest WHERE guest.project_id=alias.project_id AND guest.account_id=$2))))
      ORDER BY alias.project_id,alias.task_key`, [taskId, memberId ?? null]);
    const sourceRows = (await client.query<any>("SELECT note_id,block_id FROM stash_task_block_sources WHERE task_id=$1 ORDER BY note_id,block_id", [taskId])).rows;
    const sources = !memberId ? sourceRows : (await Promise.all(sourceRows.map(async (source: any) =>
      ({ source, visible: await this.canReadNote?.(memberId, source.note_id) === true })))).filter(({ visible }) => visible).map(({ source }) => source);
    return { schema: "stash.task.v1", id: row.id, workspaceId: row.workspace_id, title: row.title, description: row.description, revision:Number(row.revision),
      status: { id: row.workspace_workflow_status_id, name: row.status_name,
        category: row.status_category === "canceled" ? "completed" : row.status_category, position: Number(row.status_position) },
      assigneeIds: row.assignee_ids ?? [], ...(row.parent_task_id ? { parentTaskId: row.parent_task_id } : {}),
      projectAssociations: links.rows.map((entry: any) => entry.project_id), projectKeys: links.rows.map((entry: any) => ({ projectId: entry.project_id, key: entry.task_key })),
      keyAliases: aliases.rows.map((entry: any) => ({ projectId: entry.project_id, key: entry.task_key })),
      sourceNoteIds: [...new Set(sources.map((entry: any) => entry.note_id))],
      sourceBlocks: sources.map((entry: any) => ({ noteId: entry.note_id, blockId: entry.block_id })),
      createdBy: { localAccountId: row.created_by_account_id, displayName: row.created_by_name }, createdAt: new Date(row.created_at).toISOString() };
  }
  async projection(client: PostgresQueryable, task: CanonicalTask) {
    await client.query(`INSERT INTO stash_portable_projection_outbox(object_kind,object_id,revision,projection_schema,payload)
      VALUES('Task',$1,1,$2,$3::jsonb) ON CONFLICT(object_kind,object_id,revision) DO UPDATE SET projection_schema=EXCLUDED.projection_schema,payload=EXCLUDED.payload`,
    [task.id, task.schema, JSON.stringify(task)]);
  }
  async createTask(memberId: string, workspaceId: string, input: { title: string; description: string; parentTaskId?: string; projectIds: string[] }) {
    return this.kernel.transaction(async (client) => {
      await this.prepare(client); if (!(await this.workspaceAccess(client, memberId, workspaceId))?.full_member) return { status: "workspace_not_found" as const };
      const workflow = await this.ensureWorkflow(client, workspaceId); const status = workflow.statuses.find(({ category }) => category === "unstarted")!;
      if (input.parentTaskId && !(await client.query("SELECT 1 FROM stash_tasks WHERE id=$1 AND workspace_id=$2", [input.parentTaskId, workspaceId])).rowCount)
        return { status: "invalid_reference" as const };
      if (input.projectIds.length && (await client.query("SELECT id FROM stash_projects WHERE workspace_id=$1 AND id=ANY($2::uuid[])", [workspaceId, input.projectIds])).rows.length !== input.projectIds.length)
        return { status: "invalid_reference" as const };
      const id = randomUUID(); await client.query(`INSERT INTO stash_tasks(id,workspace_id,project_id,task_key,workflow_status_id,workspace_workflow_status_id,
        title,description,parent_task_id,created_by_account_id,created_at) VALUES($1,$2,NULL,NULL,NULL,$3,$4,$5,$6,$7,$8)`,
      [id, workspaceId, status.id, input.title, input.description, input.parentTaskId ?? null, memberId, new Date().toISOString()]);
      await this.replaceAssociations(client, id, input.projectIds); const task = await this.canonical(client, id); await this.projection(client, task);
      return { status: "created" as const, task };
    });
  }
  async taskAccess(client: PostgresQueryable, memberId: string, taskId: string, lock = false) {
    return (await client.query<any>(`SELECT task.workspace_id FROM stash_tasks task JOIN stash_workspaces workspace ON workspace.id=task.workspace_id
      WHERE task.id=$1 AND ${access} ${lock ? "FOR UPDATE OF task" : ""}`, [taskId, memberId])).rows[0];
  }
  async updateTask(memberId: string, taskId: string, input: CanonicalTaskChanges, operation?: { operationId:string; baseRevision:number }) {
    return this.kernel.transaction(async (client) => {
      await this.prepare(client); const found = await this.taskAccess(client, memberId, taskId, true); if (!found) return { status: "task_not_found" as const };
      const digest=operation?createHash("sha256").update(JSON.stringify({baseRevision:operation.baseRevision,changes:input})).digest("hex"):undefined;
      if(operation){const prior=await client.query<any>("SELECT digest,outcome FROM stash_canonical_task_operations WHERE task_id=$1 AND operation_id=$2",[taskId,operation.operationId]);
        if(prior.rows[0]){if(prior.rows[0].digest!==digest) return {status:"conflict" as const,task:await this.canonical(client,taskId),operationId:operation.operationId,baseRevision:operation.baseRevision,changes:input};
          return prior.rows[0].outcome;}}
      if (input.statusId && !(await client.query("SELECT 1 FROM stash_workspace_workflow_statuses WHERE id=$1 AND workspace_id=$2", [input.statusId, found.workspace_id])).rowCount)
        return { status: "invalid_reference" as const };
      if(operation){const changed=await client.query(`UPDATE stash_tasks SET title=COALESCE($2,title),description=COALESCE($3,description),
          workspace_workflow_status_id=COALESCE($4,workspace_workflow_status_id),revision=revision+1 WHERE id=$1 AND revision=$5 RETURNING id`,
        [taskId,input.title??null,input.description??null,input.statusId??null,operation.baseRevision]);
        if(!changed.rowCount){const outcome={status:"conflict" as const,task:await this.canonical(client,taskId),operationId:operation.operationId,baseRevision:operation.baseRevision,changes:input};
          await client.query("INSERT INTO stash_canonical_task_operations(task_id,operation_id,digest,outcome) VALUES($1,$2,$3,$4::jsonb)",[taskId,operation.operationId,digest,JSON.stringify(outcome)]);return outcome;}}
      else await client.query(`UPDATE stash_tasks SET title=COALESCE($2,title),description=COALESCE($3,description),
        workspace_workflow_status_id=COALESCE($4,workspace_workflow_status_id),revision=revision+1 WHERE id=$1`,[taskId,input.title??null,input.description??null,input.statusId??null]);
      const task=await this.canonical(client,taskId);await this.projection(client,task);const outcome={status:"updated" as const,task};
      if(operation)await client.query("INSERT INTO stash_canonical_task_operations(task_id,operation_id,digest,outcome) VALUES($1,$2,$3,$4::jsonb)",[taskId,operation.operationId,digest,JSON.stringify(outcome)]);
      return outcome;
    });
  }
  async replaceAssociations(client: PostgresQueryable, taskId: string, projectIds: string[]) {
    const task = (await client.query<any>("SELECT workspace_id FROM stash_tasks WHERE id=$1", [taskId])).rows[0];
    const current = await client.query<any>("SELECT project_id,task_key FROM stash_task_projects WHERE task_id=$1 FOR UPDATE", [taskId]);
    for (const old of current.rows.filter((row: any) => !projectIds.includes(row.project_id))) {
      await client.query("INSERT INTO stash_task_key_aliases(project_id,task_key,task_id) VALUES($1,$2,$3) ON CONFLICT DO NOTHING", [old.project_id, old.task_key, taskId]);
      await client.query("DELETE FROM stash_task_projects WHERE task_id=$1 AND project_id=$2", [taskId, old.project_id]);
    }
    for (const projectId of projectIds.filter((id) => !current.rows.some((row: any) => row.project_id === id))) {
      const project = (await client.query<any>("SELECT project_key,next_task_number FROM stash_projects WHERE id=$1 AND workspace_id=$2 FOR UPDATE", [projectId, task.workspace_id])).rows[0];
      if (!project) throw new Error("invalid_project_reference");
      const alias = (await client.query<any>("SELECT task_key FROM stash_task_key_aliases WHERE task_id=$1 AND project_id=$2 ORDER BY created_at LIMIT 1", [taskId, projectId])).rows[0];
      const key = alias?.task_key ?? `${project.project_key}-${project.next_task_number}`;
      if (!alias) await client.query("UPDATE stash_projects SET next_task_number=next_task_number+1 WHERE id=$1", [projectId]);
      await client.query("INSERT INTO stash_task_projects(task_id,project_id,task_key) VALUES($1,$2,$3)", [taskId, projectId, key]);
      if (alias) await client.query("DELETE FROM stash_task_key_aliases WHERE task_id=$1 AND project_id=$2 AND task_key=$3", [taskId, projectId, key]);
    }
  }
  async associateTask(memberId: string, taskId: string, projectIds: string[], impactToken?: string) {
    return this.kernel.transaction(async (client) => {
      await this.prepare(client); const found = await this.taskAccess(client, memberId, taskId, true); if (!found) return { status: "task_not_found" as const };
      const valid = await client.query("SELECT id FROM stash_projects WHERE workspace_id=$1 AND id=ANY($2::uuid[])", [found.workspace_id, projectIds]);
      if (valid.rows.length !== projectIds.length) return { status: "invalid_reference" as const };
      const current = await client.query<{ project_id: string }>("SELECT project_id FROM stash_task_projects WHERE task_id=$1", [taskId]);
      const before = await client.query<{ account_id: string }>(`SELECT DISTINCT guest.account_id FROM stash_task_projects association
        JOIN stash_project_guests guest ON guest.project_id=association.project_id WHERE association.task_id=$1`, [taskId]);
      const after = projectIds.length ? await client.query<{ account_id: string; project_id: string }>(`SELECT DISTINCT guest.account_id,guest.project_id
        FROM stash_project_guests guest WHERE guest.project_id=ANY($1::uuid[])`, [projectIds]) : { rows: [] };
      const previous = new Set(before.rows.map(({ account_id }) => account_id));
      const broadened = after.rows.filter(({ account_id }) => !previous.has(account_id));
      const memberIds=[...new Set(broadened.map(({account_id})=>account_id))].sort(); const broadenedProjects=[...new Set(broadened.map(({project_id})=>project_id))].sort();
      const expectedToken=createHash("sha256").update(JSON.stringify({taskId,projectIds:[...projectIds].sort(),memberIds})).digest("hex");
      if (broadened.length && impactToken !== expectedToken) return { status: "audience_broadening" as const,
        memberIds, projectIds: broadenedProjects, impactToken: expectedToken };
      await this.replaceAssociations(client, taskId, projectIds); const task = await this.canonical(client, taskId); await this.projection(client, task);
      return { status: "updated" as const, task, ...(broadened.length
        ? { audienceBroadenedProjectIds: [...new Set(broadened.map(({ project_id }) => project_id))] } : {}) };
    });
  }
  async setTaskParent(memberId: string, taskId: string, parentTaskId?: string) {
    return this.kernel.transaction(async (client) => {
      await this.prepare(client); const found = await this.taskAccess(client, memberId, taskId, true); if (!found) return { status: "task_not_found" as const };
      if (parentTaskId) {
        const parent = await client.query(`WITH RECURSIVE ancestors(id,parent_task_id) AS (
          SELECT id,parent_task_id FROM stash_tasks WHERE id=$1 AND workspace_id=$2 UNION ALL
          SELECT task.id,task.parent_task_id FROM stash_tasks task JOIN ancestors ON task.id=ancestors.parent_task_id)
          SELECT id FROM ancestors`, [parentTaskId, found.workspace_id]);
        if (!parent.rowCount) return { status: "invalid_reference" as const };
        if (parent.rows.some((row: any) => row.id === taskId)) return { status: "cycle" as const };
      }
      await client.query("UPDATE stash_tasks SET parent_task_id=$2,revision=revision+1 WHERE id=$1", [taskId, parentTaskId ?? null]);
      const task = await this.canonical(client, taskId); await this.projection(client, task); return { status: "updated" as const, task };
    });
  }
  async resolveTaskKey(memberId: string, projectId: string, key: string) {
    return this.kernel.withSession(async (client) => {
      await this.prepare(client); const row = await client.query<any>(`SELECT task.id FROM stash_tasks task JOIN stash_workspaces workspace ON workspace.id=task.workspace_id
        WHERE (${access} OR EXISTS(SELECT 1 FROM stash_project_guests guest WHERE guest.project_id=$1 AND guest.account_id=$2))
          AND (EXISTS(SELECT 1 FROM stash_task_projects link WHERE link.task_id=task.id AND link.project_id=$1 AND link.task_key=$3)
          OR EXISTS(SELECT 1 FROM stash_task_key_aliases alias WHERE alias.task_id=task.id AND alias.project_id=$1 AND alias.task_key=$3)) LIMIT 1`,
      [projectId, memberId, key]);
      return row.rows[0] ? { status: "found" as const, task: await this.canonical(client, row.rows[0].id, memberId) } : { status: "task_not_found" as const };
    });
  }
  async workspaceWorkflow(memberId: string, workspaceId: string) {
    return this.kernel.transaction(async (client) => { await this.prepare(client);
      if (!await this.workspaceAccess(client, memberId, workspaceId)) return { status: "workspace_not_found" as const };
      return { status: "found" as const, workflow: await this.ensureWorkflow(client, workspaceId) }; });
  }
  async configureWorkflow(memberId: string, workspaceId: string, statuses: WorkspaceWorkflow["statuses"]) {
    return this.kernel.transaction(async (client) => { await this.prepare(client);
      if (!(await this.workspaceAccess(client, memberId, workspaceId))?.full_member) return { status: "workspace_not_found" as const };
      const current = await this.ensureWorkflow(client, workspaceId);
      if (statuses.length !== current.statuses.length || statuses.some((status) => !current.statuses.some(({ id }) => id === status.id)) || new Set(statuses.map(({ id }) => id)).size !== statuses.length
        || new Set(statuses.map(({ name }) => name)).size !== statuses.length || new Set(statuses.map(({ position }) => position)).size !== statuses.length)
        return { status: "invalid_reference" as const };
      await client.query("UPDATE stash_workspace_workflow_statuses SET position=position+10000,name=id::text WHERE workspace_id=$1", [workspaceId]);
      for (const status of statuses) await client.query(`UPDATE stash_workspace_workflow_statuses SET name=$2,category=$3,position=$4
        WHERE id=$1 AND workspace_id=$5`, [status.id, status.name, status.category, status.position, workspaceId]);
      return { status: "updated" as const, workflow: await this.ensureWorkflow(client, workspaceId) };
    });
  }
  async setProjectParent(memberId: string, projectId: string, parentProjectId?: string) {
    return this.kernel.transaction(async (client) => { await this.prepare(client);
      const project = (await client.query<any>(`SELECT project.id,project.workspace_id FROM stash_projects project JOIN stash_workspaces workspace
        ON workspace.id=project.workspace_id WHERE project.id=$1 AND ${access} FOR UPDATE OF project`, [projectId, memberId])).rows[0];
      if (!project) return { status: "project_not_found" as const };
      if (parentProjectId) {
        const ancestors = await client.query<any>(`WITH RECURSIVE chain(id,parent_project_id) AS (
          SELECT id,parent_project_id FROM stash_projects WHERE id=$1 AND workspace_id=$2 UNION ALL
          SELECT project.id,project.parent_project_id FROM stash_projects project JOIN chain ON project.id=chain.parent_project_id)
          SELECT id FROM chain`, [parentProjectId, project.workspace_id]);
        if (!ancestors.rowCount) return { status: "invalid_reference" as const };
        if (ancestors.rows.some(({ id }: any) => id === projectId)) return { status: "cycle" as const };
      }
      await client.query("UPDATE stash_projects SET parent_project_id=$2 WHERE id=$1", [projectId, parentProjectId ?? null]);
      await client.query(`UPDATE stash_portable_projection_outbox SET payload=CASE WHEN $2::uuid IS NULL THEN payload-'parentProjectId'
        ELSE payload||jsonb_build_object('parentProjectId',$2::uuid) END WHERE object_kind='Project' AND object_id=$1`, [projectId, parentProjectId ?? null]);
      return { status: "updated" as const };
    });
  }
  async listProjectTasks(memberId: string, projectId: string) {
    return this.kernel.withSession(async (client) => { await this.prepare(client);
      const root = (await client.query<any>(`SELECT project.workspace_id FROM stash_projects project JOIN stash_workspaces workspace
        ON workspace.id=project.workspace_id WHERE project.id=$1 AND (${access} OR EXISTS(SELECT 1 FROM stash_project_guests guest
          WHERE guest.project_id=project.id AND guest.account_id=$2))`, [projectId, memberId])).rows[0];
      if (!root) return { status: "project_not_found" as const };
      const ids = await client.query<any>(`WITH RECURSIVE descendants(id) AS (SELECT $1::uuid UNION ALL SELECT project.id FROM stash_projects project
        JOIN descendants parent ON project.parent_project_id=parent.id) SELECT descendants.id FROM descendants
        WHERE EXISTS(SELECT 1 FROM stash_workspaces workspace WHERE workspace.id=$3 AND (${access}))
          OR EXISTS(SELECT 1 FROM stash_project_guests guest WHERE guest.project_id=descendants.id AND guest.account_id=$2)`,
      [projectId, memberId, root.workspace_id]);
      const rows = await client.query<any>(`SELECT DISTINCT association.task_id id FROM stash_task_projects association
        WHERE association.project_id=ANY($1::uuid[]) ORDER BY association.task_id`, [ids.rows.map(({ id }: any) => id)]);
      return { status: "found" as const, tasks: await Promise.all(rows.rows.map(({ id }: any) => this.canonical(client, id, memberId))) };
    });
  }
  async listTasks(memberId: string, workspaceId: string) {
    return this.kernel.transaction(async (client) => { await this.prepare(client);
      const permission = await this.workspaceAccess(client, memberId, workspaceId); if (!permission) return { status: "workspace_not_found" as const };
      const workflow = await this.ensureWorkflow(client, workspaceId); const rows = await client.query<any>(`SELECT task.id FROM stash_tasks task
        WHERE task.workspace_id=$1 AND ($3::boolean OR EXISTS(SELECT 1 FROM stash_task_projects association
          JOIN stash_project_guests guest ON guest.project_id=association.project_id WHERE association.task_id=task.id AND guest.account_id=$2))
        ORDER BY task.created_at,task.id`, [workspaceId, memberId, permission.full_member]);
      const tasks = await Promise.all(rows.rows.map((row: any) => this.canonical(client, row.id, memberId)));
      const assigneeIds = [...new Set(tasks.flatMap(({ assigneeIds }) => assigneeIds))];
      const members = assigneeIds.length ? (await client.query<{ id: string; name: string }>(
        "SELECT id,name FROM stash_accounts WHERE id=ANY($1::uuid[]) ORDER BY id", [assigneeIds])).rows : [];
      return { status: "found" as const, tasks, workflow, members }; });
  }
}
