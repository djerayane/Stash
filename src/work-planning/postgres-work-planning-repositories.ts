import type { ActivityCause, ActivityRecord } from "../activity.js";
import type { PortableExportTaskProjection } from "../notes.js";
import type { TaskPlanningReadModel, TaskPlanningRepository, TaskPlanningUpdate } from "../tasks.js";
import { PostgresKernel, type PostgresQueryable } from "../instance-operations/storage/postgres-kernel.js";

const taskPlanningSelect = `SELECT task.*, COALESCE(workspace_status.name,status.name) AS status_name,
  COALESCE(workspace_status.category,status.category) AS status_category, creator.name AS created_by_name,
  ARRAY(SELECT source.note_id FROM stash_task_note_sources source WHERE source.task_id = task.id ORDER BY source.note_id) AS source_note_ids,
  COALESCE((SELECT jsonb_agg(jsonb_build_object('noteId', source.note_id, 'blockId', source.block_id) ORDER BY source.note_id, source.block_id)
    FROM stash_task_block_sources source WHERE source.task_id = task.id), '[]'::jsonb) AS source_blocks,
  COALESCE((SELECT jsonb_agg(jsonb_build_object('projectId', alias.project_id, 'key', alias.task_key) ORDER BY alias.created_at)
    FROM stash_task_key_aliases alias WHERE alias.task_id = task.id), '[]'::jsonb) AS key_aliases,
  COALESCE((SELECT jsonb_agg(jsonb_build_object('projectId', association.project_id, 'key', association.task_key) ORDER BY association.project_id)
    FROM stash_task_projects association WHERE association.task_id = task.id), '[]'::jsonb) AS project_keys,
  COALESCE((SELECT jsonb_agg(relation ORDER BY relation->>'taskId', relation->>'type') FROM (
      SELECT jsonb_build_object('taskId', edge.prerequisite_task_id, 'type', 'depends_on') AS relation
      FROM stash_task_dependencies edge WHERE edge.dependent_task_id = task.id UNION ALL
      SELECT jsonb_build_object('taskId', edge.dependent_task_id, 'type', 'required_by') AS relation
      FROM stash_task_dependencies edge WHERE edge.prerequisite_task_id = task.id
    ) visible_dependencies), '[]'::jsonb) AS dependencies,
  COALESCE((SELECT jsonb_agg(jsonb_build_object('code', 'incomplete_dependency', 'taskId', prerequisite.id) ORDER BY prerequisite.id)
    FROM stash_task_dependencies edge JOIN stash_tasks prerequisite ON prerequisite.id = edge.prerequisite_task_id
    JOIN stash_workflow_statuses prerequisite_status ON prerequisite_status.id = prerequisite.workflow_status_id
    WHERE edge.dependent_task_id = task.id AND prerequisite_status.category <> 'completed'), '[]'::jsonb) AS dependency_warnings
  FROM stash_tasks task LEFT JOIN stash_workflow_statuses status ON status.id = task.workflow_status_id
  LEFT JOIN stash_workspace_workflow_statuses workspace_status ON workspace_status.id = task.workspace_workflow_status_id
  JOIN stash_accounts creator ON creator.id = task.created_by_account_id JOIN stash_workspaces workspace ON workspace.id = task.workspace_id
  WHERE (task.project_id = $1 AND task.task_key = $2 OR EXISTS (SELECT 1 FROM stash_task_projects association
      WHERE association.task_id=task.id AND association.project_id=$1 AND association.task_key=$2) OR EXISTS (SELECT 1 FROM stash_task_key_aliases alias
      WHERE alias.task_id = task.id AND alias.project_id = $1 AND alias.task_key = $2))
    AND ((workspace.owner_type = 'personal' AND workspace.personal_owner_id = $3)
      OR (workspace.owner_type = 'organization' AND EXISTS (SELECT 1 FROM stash_organization_memberships membership
        WHERE membership.organization_id = workspace.organization_owner_id AND membership.account_id = $3))
      OR EXISTS (SELECT 1 FROM stash_project_guests guest JOIN stash_task_projects association ON association.project_id=guest.project_id
        WHERE association.task_id=task.id AND guest.account_id=$3))`;
const taskPlanningSelectById = taskPlanningSelect
  .replace(/\(task\.project_id = \$1[\s\S]*?alias\.task_key = \$2\)\)/, "task.id = $1").replaceAll("$3", "$2");

function projection(row: any): PortableExportTaskProjection {
  return { schema: "stash.task.v1", id: row.id, workspaceId: row.workspace_id, ...(row.project_id ? { projectId: row.project_id } : {}),
    ...(row.task_key ? { key: row.task_key } : {}), ...(row.project_keys?.length ? { projectKeys: row.project_keys,
      projectAssociations: row.project_keys.map((entry: any) => entry.projectId) } : {}),
    ...(row.key_aliases?.length ? { keyAliases: row.key_aliases } : {}), title: row.title,
    status: { id: row.workspace_workflow_status_id ?? row.workflow_status_id, name: row.status_name, category: row.status_category },
    assigneeIds: row.assignee_ids ?? [], ...(row.former_assignee_ids?.length ? { formerAssigneeIds: row.former_assignee_ids } : {}),
    priority: row.priority ?? "none", labelNames: row.label_names ?? [],
    ...(row.due_date ? { dueDate: typeof row.due_date === "string" ? row.due_date : row.due_date.toISOString().slice(0, 10) } : {}),
    ...(row.estimate == null ? {} : { estimate: Number(row.estimate) }), linkedNoteIds: row.linked_note_ids ?? [],
    dependencies: row.dependencies ?? [], developmentLinks: row.development_links ?? [], sourceNoteIds: row.source_note_ids ?? [],
    ...(row.source_blocks?.length ? { sourceBlocks: row.source_blocks } : {}), createdAt: new Date(row.created_at).toISOString(),
    createdBy: { localAccountId: row.created_by_account_id, displayName: row.created_by_name } };
}
function readModel(row: any): TaskPlanningReadModel {
  return { ...projection(row), revision: Number(row.revision), dependencyWarnings: row.dependency_warnings ?? [] } as TaskPlanningReadModel;
}
function hasCycle(taskIds: ReadonlySet<string>, edges: ReadonlyArray<{ dependent_task_id: string; prerequisite_task_id: string }>) {
  const outgoing = new Map([...taskIds].map((id) => [id, [] as string[]]));
  for (const edge of edges) outgoing.get(edge.dependent_task_id)?.push(edge.prerequisite_task_id);
  const active = new Set<string>(); const complete = new Set<string>();
  const visit = (id: string): boolean => active.has(id) || (!complete.has(id) && (() => { active.add(id);
    const cycle = (outgoing.get(id) ?? []).some(visit); active.delete(id); complete.add(id); return cycle; })());
  return [...outgoing.keys()].some(visit);
}

export interface WorkPlanningPersistenceHooks {
  prepare(client: PostgresQueryable): Promise<void>;
  recordProjection(client: PostgresQueryable, task: PortableExportTaskProjection): Promise<void>;
  recordActivity(client: PostgresQueryable, memberId: string, workspaceId: string, taskId: string,
    before: TaskPlanningReadModel, after: TaskPlanningReadModel, cause: ActivityCause): Promise<ActivityRecord>;
  recordAgentAudit(client: PostgresQueryable, memberId: string, workspaceId: string, taskId: string,
    cause: Extract<ActivityCause, { kind: "agent" }>): Promise<void>;
  recordAssignmentNotifications(client: PostgresQueryable, projectId: string, activity: ActivityRecord,
    before: TaskPlanningReadModel, after: TaskPlanningReadModel): Promise<void>;
}

export class PostgresWorkPlanningRepositories implements TaskPlanningRepository {
  constructor(private readonly kernel: PostgresKernel, private readonly hooks: WorkPlanningPersistenceHooks) {}

  async findTaskByKey(memberId: string, projectId: string, taskKey: string) {
    return this.kernel.withSession(async (client) => { await this.hooks.prepare(client);
      const row = (await client.query<any>(taskPlanningSelect, [projectId, taskKey, memberId])).rows[0];
      return row ? { status: "found" as const, task: readModel(row) } : { status: "not_found" as const }; });
  }

  async updateTaskByKey(memberId: string, projectId: string, taskKey: string, update: TaskPlanningUpdate,
    cause: ActivityCause = { kind: "member" }) {
    return this.kernel.transaction(async (client) => {
      await this.hooks.prepare(client);
      const writable = await client.query<{ workspace_id: string }>(`SELECT workspace.id AS workspace_id FROM stash_projects project
        JOIN stash_workspaces workspace ON workspace.id = project.workspace_id WHERE project.id = $1 AND
        ((workspace.owner_type = 'personal' AND workspace.personal_owner_id = $2) OR (workspace.owner_type = 'organization' AND EXISTS
        (SELECT 1 FROM stash_organization_memberships membership WHERE membership.organization_id = workspace.organization_owner_id
          AND membership.account_id = $2))) FOR UPDATE OF project`, [projectId, memberId]);
      if (!writable.rowCount) return { status: "not_found" as const };
      if (update.dependencies !== undefined) await client.query("SELECT pg_advisory_xact_lock(hashtext('stash-task-dependencies'),hashtext($1))", [writable.rows[0]!.workspace_id]);
      const row = (await client.query<any>(`${taskPlanningSelect} FOR UPDATE OF task`, [projectId, taskKey, memberId])).rows[0];
      if (!row) return { status: "not_found" as const };
      if (update.statusId && !(await client.query("SELECT 1 FROM stash_workflow_statuses WHERE id=$1 AND project_id=$2 AND archived=FALSE", [update.statusId, projectId])).rowCount)
        return { status: "invalid_reference" as const };
      if (update.assigneeIds) {
        const assignees = await client.query(`SELECT account.id FROM stash_accounts account JOIN stash_workspaces workspace ON workspace.id=$2
          WHERE account.id=ANY($1::uuid[]) AND ((workspace.owner_type='personal' AND workspace.personal_owner_id=account.id) OR
          (workspace.owner_type='organization' AND EXISTS (SELECT 1 FROM stash_organization_memberships membership
            WHERE membership.organization_id=workspace.organization_owner_id AND membership.account_id=account.id)))`, [update.assigneeIds, row.workspace_id]);
        if (assignees.rowCount !== new Set(update.assigneeIds).size) return { status: "invalid_reference" as const };
      }
      for (const noteId of update.linkedNoteIds ?? []) if (!(await client.query("SELECT 1 FROM stash_notes WHERE id=$1 AND workspace_id=$2", [noteId, row.workspace_id])).rowCount)
        return { status: "invalid_reference" as const };
      if (update.dependencies !== undefined) {
        const taskIds = new Set((await client.query<{ id: string }>("SELECT id FROM stash_tasks WHERE workspace_id=$1 ORDER BY id FOR UPDATE", [row.workspace_id])).rows.map(({ id }) => id));
        if (update.dependencies.some((dependency) => dependency.taskId === row.id || !taskIds.has(dependency.taskId))) return { status: "invalid_reference" as const };
        const stored = (await client.query<{ dependent_task_id: string; prerequisite_task_id: string }>(`SELECT edge.dependent_task_id, edge.prerequisite_task_id
          FROM stash_task_dependencies edge JOIN stash_tasks dependent ON dependent.id=edge.dependent_task_id WHERE dependent.workspace_id=$1`, [row.workspace_id])).rows;
        const retained = stored.filter((edge) => edge.dependent_task_id !== row.id && edge.prerequisite_task_id !== row.id);
        const proposed = update.dependencies.map((dependency) => dependency.type === "depends_on" ?
          { dependent_task_id: row.id, prerequisite_task_id: dependency.taskId } : { dependent_task_id: dependency.taskId, prerequisite_task_id: row.id });
        const unique = [...new Map(proposed.map((edge) => [`${edge.dependent_task_id}:${edge.prerequisite_task_id}`, edge])).values()];
        if (hasCycle(taskIds, [...retained, ...unique])) return { status: "invalid_reference" as const };
        row.affected_dependency_task_ids = [...new Set([...stored.filter((edge) => edge.dependent_task_id === row.id || edge.prerequisite_task_id === row.id), ...unique]
          .flatMap((edge) => [edge.dependent_task_id, edge.prerequisite_task_id]))];
        await client.query("DELETE FROM stash_task_dependencies WHERE dependent_task_id=$1 OR prerequisite_task_id=$1", [row.id]);
        for (const edge of unique) await client.query("INSERT INTO stash_task_dependencies (dependent_task_id,prerequisite_task_id) VALUES ($1,$2)", [edge.dependent_task_id, edge.prerequisite_task_id]);
      }
      const next = { ...projection(row), ...update } as PortableExportTaskProjection & { statusId?: string };
      if (update.statusId) next.status = (await client.query<any>("SELECT id,name,category FROM stash_workflow_statuses WHERE id=$1", [update.statusId])).rows[0];
      delete next.statusId;
      const revision = Number(row.revision) + 1; const fieldRevisions = { ...(row.field_revisions ?? {}) };
      for (const field of Object.keys(update)) fieldRevisions[field] = revision;
      const assigneeIds = [...new Set(next.assigneeIds ?? [])];
      const removedFormer = (row.former_assignee_ids ?? []).every((id: string) => !assigneeIds.includes(id));
      const replacement = assigneeIds.some((id) => !(row.former_assignee_ids ?? []).includes(id));
      const formerAssigneeIds = update.assigneeIds !== undefined && removedFormer && replacement ? [] : row.former_assignee_ids ?? [];
      await client.query(`UPDATE stash_tasks SET title=$2,workflow_status_id=$3,assignee_ids=$4::jsonb,priority=$5,label_names=$6::jsonb,
        due_date=$7,estimate=$8,linked_note_ids=$9::jsonb,development_links=$10::jsonb,revision=$11,field_revisions=$12::jsonb,
        former_assignee_ids=$13::jsonb WHERE id=$1`, [row.id, next.title.trim(), next.status.id, JSON.stringify(assigneeIds), next.priority ?? "none",
        JSON.stringify([...new Set((next.labelNames ?? []).map((label) => label.trim()))]), next.dueDate ?? null, next.estimate ?? null,
        JSON.stringify([...new Set(next.linkedNoteIds ?? [])]), JSON.stringify(next.developmentLinks ?? []), revision, JSON.stringify(fieldRevisions), JSON.stringify(formerAssigneeIds)]);
      const saved = (await client.query<any>(taskPlanningSelect, [projectId, taskKey, memberId])).rows[0]; const task = readModel(saved);
      await this.hooks.recordProjection(client, projection(saved)); const before = readModel(row);
      const activity = await this.hooks.recordActivity(client, memberId, task.workspaceId, task.id, before, task, cause);
      if (cause.kind === "agent") await this.hooks.recordAgentAudit(client, memberId, task.workspaceId, task.id, cause);
      await this.hooks.recordAssignmentNotifications(client, projectId, activity, before, task);
      for (const affectedId of (row.affected_dependency_task_ids ?? []).filter((id: string) => id !== task.id)) {
        const affectedBefore = (await client.query<any>(taskPlanningSelectById, [affectedId, memberId])).rows[0];
        await client.query("UPDATE stash_tasks SET revision=revision+1,field_revisions=jsonb_set(field_revisions,'{dependencies}',to_jsonb(revision+1),true) WHERE id=$1", [affectedId]);
        const affected = (await client.query<any>(taskPlanningSelectById, [affectedId, memberId])).rows[0];
        if (affected) { await this.hooks.recordProjection(client, projection(affected)); if (affectedBefore)
          await this.hooks.recordActivity(client, memberId, task.workspaceId, affectedId, readModel(affectedBefore), readModel(affected), cause); }
      }
      return { status: "updated" as const, task };
    });
  }
}
