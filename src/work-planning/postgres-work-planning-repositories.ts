import { randomUUID } from "node:crypto";
import type { ActivityCause, ActivityRecord } from "../activity.js";
import type { DevelopmentArtifactKind } from "../github-artifacts.js";
import type { AutomationCandidate, AutomationFailureNotification, AutomationRecipe, AutomationRepository, AutomationState, AutomationTransition, AutomationTrigger } from "../automations.js";
import type { Board, BoardRepository, BoardTask } from "../boards.js";
import type { PortableExportTaskProjection, PortableNoteProjection, PortableTaskProjection, TaskCreation } from "../notes.js";
import { initialWorkflowStatus, type ProjectWorkflow, type ProjectWorkflowRepository, type WorkflowStatus } from "../project-workflows.js";
import { taskEditDigest, type StructuredTaskEditRepository, type TaskEditBatch, type TaskEditConflict, type TaskMoveActivity,
  type CreateTaskFromBlockDraft, type CreateTaskFromBlockOutcome, type CreateWorkspaceTaskFromBlockOutcome, type TaskFromBlockRepository,
  type TaskMoveRepository, type TaskPlanningReadModel, type TaskPlanningRepository, type TaskPlanningUpdate, type TaskSourceBlockReference } from "../tasks.js";
import { assignmentNotificationInputs, notificationDeliveryMode, type NotificationDelivery, type NotificationPreferences,
  type NotificationRepository } from "../notifications.js";
import { PostgresKernel, type PostgresQueryable } from "../instance-operations/storage/postgres-kernel.js";
import type { WorkspaceWorkflow } from "./canonical-tasks.js";
import { richTextToMarkdown } from "../rich-text.js";
import type { DevelopmentArtifactTarget, WorkPlanningDevelopmentArtifactPort } from "./development-artifact-port.js";

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
export const workflowTemporaryRenameSql = `UPDATE stash_workflow_statuses
  SET position = -position - 1, name = repeat('__stash_workflow_transition__', 4) || id::text
  WHERE project_id = $1`;

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
function boardFromRow(row: any): Board {
  return { schema: "stash.board.v1", id: row.id, projectId: row.project_id, name: row.name,
    groupBy: row.group_by, createdAt: new Date(row.created_at).toISOString() };
}
function taskConflictFromRow(row: any): TaskEditConflict {
  return { id: row.id, taskId: row.task_id, baseRevision: row.base_revision, currentRevision: row.current_revision,
    fields: row.fields, contribution: row.contribution, createdAt: new Date(row.created_at).toISOString(),
    createdBy: { displayName: row.created_by_display_name, attribution: "recorded" },
    ...(row.resolved_at ? { resolvedAt: new Date(row.resolved_at).toISOString(), resolution: row.resolution } : {}) };
}
function formerAssignmentsAfterUpdate(previous: readonly string[], next: readonly string[], updated: boolean) {
  if (!updated) return [...previous];
  return previous.every((id) => !next.includes(id)) && next.some((id) => !previous.includes(id)) ? [] : [...previous];
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
  recordWorkflowProjection(client: PostgresQueryable, workflow: ProjectWorkflow): Promise<void>;
  recordBoardProjection(client: PostgresQueryable, board: Board): Promise<void>;
  recordAgentAudit(client: PostgresQueryable, memberId: string, workspaceId: string, taskId: string,
    cause: Extract<ActivityCause, { kind: "agent" }>): Promise<void>;
  prepareAutomationDependencies(client: PostgresQueryable): Promise<void>;
  recordStructuredAgentAudit(client: PostgresQueryable, memberId: string, workspaceId: string, taskId: string,
    cause: Extract<ActivityCause, { kind: "agent" }>): Promise<void>;
  recordActivityProjection(client: PostgresQueryable, activity: ActivityRecord): Promise<void>;
  prepareDiscussionScope(client: PostgresQueryable): Promise<void>;
  recordIdentifiedNoteBlock(client: PostgresQueryable, memberId: string, beforeRow: any, afterRow: any,
    projection: PortableNoteProjection): Promise<void>;
  recordTaskSourceActivity(client: PostgresQueryable, memberId: string, workspaceId: string,
    task: PortableExportTaskProjection): Promise<void>;
  ensureCanonicalWorkflow(client: PostgresQueryable, workspaceId: string): Promise<WorkspaceWorkflow>;
}

interface FailedAutomationRun {
  automationId: string; configuringMemberId: string; configuringMemberName: string; workspaceId: string;
  projectId: string; taskId: string; taskKey: string; taskTitle: string;
}

export class PostgresWorkPlanningRepositories implements TaskFromBlockRepository, TaskPlanningRepository, StructuredTaskEditRepository, TaskMoveRepository,
  ProjectWorkflowRepository, BoardRepository, NotificationRepository, AutomationRepository, WorkPlanningDevelopmentArtifactPort {
  constructor(private readonly kernel: PostgresKernel, private readonly hooks: WorkPlanningPersistenceHooks) {}

  async linkDevelopmentArtifact(client: PostgresQueryable, target: DevelopmentArtifactTarget,
    artifact: { kind: DevelopmentArtifactKind; url: string }, action: string, cause: ActivityCause): Promise<"linked" | "forbidden"> {
    await this.hooks.prepare(client);
    let actorId: string;
    let row: any;
    if (target.kind === "task_key") {
      actorId = target.memberId;
      row = (await client.query<any>(`${taskPlanningSelect} FOR UPDATE OF task`,
        [target.projectId, target.taskKey, actorId])).rows[0];
      if (!row) return "forbidden";
      const writable = await client.query(`SELECT 1 FROM stash_workspaces workspace WHERE workspace.id = $1
        AND ((workspace.owner_type = 'personal' AND workspace.personal_owner_id = $2)
          OR (workspace.owner_type = 'organization' AND EXISTS (SELECT 1 FROM stash_organization_memberships membership
            WHERE membership.organization_id = workspace.organization_owner_id AND membership.account_id = $2))) FOR UPDATE`,
        [row.workspace_id, actorId]);
      if (!writable.rowCount) return "forbidden";
    } else {
      const actor = target.actor.kind === "member" ? { id: target.actor.memberId }
        : (await client.query<{ id: string }>(`SELECT membership.account_id AS id FROM stash_organization_memberships membership
          WHERE membership.organization_id=$1 AND membership.role='Owner' ORDER BY membership.account_id LIMIT 1`,
          [target.actor.organizationId])).rows[0];
      if (!actor) return "forbidden";
      actorId = actor.id;
      row = (await client.query<any>(`${taskPlanningSelectById} FOR UPDATE OF task`, [target.taskId, actorId])).rows[0];
      if (!row) return "forbidden";
    }
    await this.persistTaskDevelopmentArtifact(client, row, actorId, artifact, action, cause);
    return "linked";
  }

  private async persistTaskDevelopmentArtifact(client: PostgresQueryable, row: any, actorId: string,
    artifact: { kind: DevelopmentArtifactKind; url: string }, action: string, cause: ActivityCause): Promise<void> {
    const before = readModel(row); const links = before.developmentLinks ?? [];
    if (links.some(({ url }) => url === artifact.url)) return;
    const revision = Number(row.revision) + 1;
    await client.query(`UPDATE stash_tasks SET development_links=$2::jsonb, revision=$3,
      field_revisions=jsonb_set(field_revisions,'{developmentLinks}',to_jsonb($3::int),true) WHERE id=$1`,
      [row.id, JSON.stringify([...links, { provider: "github", kind: artifact.kind, url: artifact.url }]), revision]);
    const saved = await client.query<any>(taskPlanningSelectById, [row.id, actorId]);
    const after = readModel(saved.rows[0]);
    await this.hooks.recordProjection(client, projection(saved.rows[0]));
    await this.recordTaskActivity(client, actorId, after.workspaceId, after.id, action, before, after, cause);
  }

  async prepareNotifications(client: PostgresQueryable): Promise<void> {
    await this.hooks.prepare(client);
    await client.query(`CREATE TABLE IF NOT EXISTS stash_notification_preferences (
      member_id UUID NOT NULL REFERENCES stash_accounts(id) ON DELETE CASCADE,
      project_id UUID NOT NULL REFERENCES stash_projects(id) ON DELETE CASCADE,
      activity TEXT NOT NULL CHECK (activity IN ('all','followed','muted')),
      digest TEXT NOT NULL CHECK (digest IN ('off','daily','weekly')),
      quiet_start TEXT, quiet_end TEXT, quiet_time_zone TEXT,
      CHECK ((quiet_start IS NULL AND quiet_end IS NULL AND quiet_time_zone IS NULL) OR
        (quiet_start IS NOT NULL AND quiet_end IS NOT NULL AND quiet_time_zone IS NOT NULL)),
      PRIMARY KEY (member_id,project_id)
    );
    CREATE TABLE IF NOT EXISTS stash_project_follows (
      member_id UUID NOT NULL REFERENCES stash_accounts(id) ON DELETE CASCADE,
      project_id UUID NOT NULL REFERENCES stash_projects(id) ON DELETE CASCADE,
      followed_at TIMESTAMPTZ NOT NULL,
      PRIMARY KEY (member_id,project_id)
    );
    CREATE TABLE IF NOT EXISTS stash_notifications (
      id UUID PRIMARY KEY,
      member_id UUID NOT NULL REFERENCES stash_accounts(id) ON DELETE CASCADE,
      workspace_id UUID NOT NULL REFERENCES stash_workspaces(id) ON DELETE CASCADE,
      project_id UUID NOT NULL REFERENCES stash_projects(id) ON DELETE CASCADE,
      trigger TEXT NOT NULL CHECK (trigger IN ('direct_mention','assignment','requested_review','automation_failure','followed_change')),
      summary TEXT NOT NULL,
      activity JSONB NOT NULL,
      activity_id TEXT GENERATED ALWAYS AS (activity->>'id') STORED,
      created_at TIMESTAMPTZ NOT NULL,
      delivery TEXT NOT NULL CHECK (delivery IN ('immediate','quiet_hours')),
      read_at TIMESTAMPTZ,
      digested_at TIMESTAMPTZ,
      UNIQUE (member_id,activity_id,trigger)
    );
    ALTER TABLE stash_notifications ADD COLUMN IF NOT EXISTS digested_at TIMESTAMPTZ;
    ALTER TABLE stash_notifications ALTER COLUMN project_id DROP NOT NULL;
    CREATE INDEX IF NOT EXISTS stash_notifications_member_created_idx ON stash_notifications(member_id,created_at DESC)`);
  }

  async recordTaskActivity(client: PostgresQueryable, memberId: string, workspaceId: string, taskId: string,
    action: string, before: TaskPlanningReadModel, after: TaskPlanningReadModel,
    cause: ActivityCause = { kind: "member" }): Promise<ActivityRecord> {
    const actor = await client.query<{ name: string }>("SELECT name FROM stash_accounts WHERE id=$1", [memberId]);
    if (!actor.rows[0]) throw new Error("member_identity_unavailable");
    const activity: ActivityRecord = { schema: "stash.activity.v1", id: randomUUID(), workspaceId,
      object: { kind: "Task", id: taskId }, action, actor: { localAccountId: memberId, displayName: actor.rows[0].name },
      cause, occurredAt: new Date().toISOString(), before: { ...before }, after: { ...after } };
    await this.persistTaskActivity(client, activity);
    return activity;
  }

  async persistTaskActivity(client: PostgresQueryable, activity: ActivityRecord): Promise<void> {
    if (activity.object.kind !== "Task") throw new Error("task_activity_object_required");
    await client.query(`INSERT INTO stash_workspace_activity
      (id,workspace_id,object_kind,object_id,action,actor_account_id,cause,occurred_at,before_state,after_state)
      VALUES ($1,$2,'Task',$3,$4,$5,$6,$7,$8::jsonb,$9::jsonb)`, [activity.id, activity.workspaceId, activity.object.id,
      activity.action, activity.actor.localAccountId, JSON.stringify(activity.cause), activity.occurredAt,
      JSON.stringify(activity.before), JSON.stringify(activity.after)]);
    await this.hooks.recordActivityProjection(client, activity);
    if (activity.action !== "automation_execution_failed" && JSON.stringify(activity.before) !== JSON.stringify(activity.after))
      await this.recordProjectActivityNotifications(client, activity);
  }

  async recordProjectActivityNotifications(client: PostgresQueryable, activity: ActivityRecord): Promise<void> {
    await this.hooks.prepare(client);
    await this.hooks.prepareDiscussionScope(client);
    await this.prepareNotifications(client);
    const scope = await client.query<any>(`WITH activity_scope AS (
      SELECT COALESCE(task.project_id, note.project_id, location_note.project_id, link_note.project_id,
        discussion_task.project_id, discussion_note.project_id) AS project_id
      FROM (SELECT 1) seed
      LEFT JOIN stash_tasks task ON $2='Task' AND task.id=$1
      LEFT JOIN stash_notes note ON $2='Note' AND note.id=$1
      LEFT JOIN stash_notes location_note ON $2='NoteLocation' AND location_note.id=$1
      LEFT JOIN stash_note_links link ON $2='NoteLink' AND link.id=$1
      LEFT JOIN stash_notes link_note ON link_note.id=link.source_note_id
      LEFT JOIN stash_discussions discussion ON $2='Discussion' AND discussion.id=$1
      LEFT JOIN stash_tasks discussion_task ON discussion_task.id=discussion.task_id
      LEFT JOIN stash_notes discussion_note ON discussion_note.id=discussion.note_id
    ) SELECT scope.project_id, account.id AS member_id,
      COALESCE(preference.activity,'followed') AS activity_preference, COALESCE(preference.digest,'off') AS digest,
      preference.quiet_start, preference.quiet_end, preference.quiet_time_zone
      FROM activity_scope scope JOIN stash_projects project ON project.id=scope.project_id
      JOIN stash_workspaces workspace ON workspace.id=project.workspace_id
      JOIN stash_accounts account ON (workspace.owner_type='personal' AND account.id=workspace.personal_owner_id) OR
        (workspace.owner_type='organization' AND EXISTS (SELECT 1 FROM stash_organization_memberships membership
          WHERE membership.organization_id=workspace.organization_owner_id AND membership.account_id=account.id))
      LEFT JOIN stash_notification_preferences preference ON preference.project_id=project.id AND preference.member_id=account.id
      LEFT JOIN stash_project_follows follow ON follow.project_id=project.id AND follow.member_id=account.id
      WHERE account.id<>$3 AND COALESCE(preference.activity,'followed')<>'muted'
        AND (COALESCE(preference.activity,'followed')='all' OR follow.member_id IS NOT NULL)
      ORDER BY account.id`, [activity.object.id, activity.object.kind, activity.actor.localAccountId]);
    for (const recipient of scope.rows) {
      const preferences: NotificationPreferences = { activity: recipient.activity_preference, digest: recipient.digest,
        ...(recipient.quiet_start ? { quietHours: { start: recipient.quiet_start, end: recipient.quiet_end, timeZone: recipient.quiet_time_zone } } : {}) };
      await client.query(`INSERT INTO stash_notifications
        (id,member_id,workspace_id,project_id,trigger,summary,activity,created_at,delivery)
        VALUES($1,$2,$3,$4,'followed_change',$5,$6::jsonb,$7,$8)
        ON CONFLICT(member_id,activity_id,trigger) DO NOTHING`, [randomUUID(), recipient.member_id, activity.workspaceId,
        recipient.project_id, `${activity.actor.displayName} changed ${activity.object.kind === "Note" ? "a Note" : activity.object.kind === "Task" ? "a Task" : "Project content"}`,
        JSON.stringify(activity), activity.occurredAt, notificationDeliveryMode(new Date(activity.occurredAt), preferences)]);
    }
  }

  async recordAssignmentNotifications(client: PostgresQueryable, projectId: string, activity: ActivityRecord,
    before: { assigneeIds?: string[] }, after: { assigneeIds?: string[]; key?: string; title?: string }): Promise<void> {
    const inputs = assignmentNotificationInputs(activity, projectId, before, after);
    if (!inputs.length) return;
    await this.prepareNotifications(client);
    for (const input of inputs) {
      await client.query("DELETE FROM stash_notifications WHERE member_id=$1 AND activity_id=$2 AND trigger='followed_change'",
        [input.memberId, activity.id]);
      const settings = await client.query<any>(`SELECT preference.* FROM stash_projects project
        JOIN stash_workspaces workspace ON workspace.id=project.workspace_id
        LEFT JOIN stash_notification_preferences preference ON preference.project_id=project.id AND preference.member_id=$1
        WHERE project.id=$2 AND ((workspace.owner_type='personal' AND workspace.personal_owner_id=$1) OR
          (workspace.owner_type='organization' AND EXISTS (SELECT 1 FROM stash_organization_memberships membership
            WHERE membership.organization_id=workspace.organization_owner_id AND membership.account_id=$1)))`, [input.memberId, projectId]);
      if (!settings.rowCount) throw new Error("notification_recipient_forbidden");
      const row = settings.rows[0];
      const preferences: NotificationPreferences = row.member_id ? { activity: row.activity, digest: row.digest,
        ...(row.quiet_start ? { quietHours: { start: row.quiet_start, end: row.quiet_end, timeZone: row.quiet_time_zone } } : {}) }
        : { activity: "followed", digest: "off" };
      await client.query(`INSERT INTO stash_notifications
        (id,member_id,workspace_id,project_id,trigger,summary,activity,created_at,delivery)
        VALUES ($1,$2,$3,$4,'assignment',$5,$6::jsonb,$7,$8)
        ON CONFLICT (member_id,activity_id,trigger) DO NOTHING`, [randomUUID(), input.memberId, activity.workspaceId,
        projectId, input.summary, JSON.stringify(activity), activity.occurredAt,
        notificationDeliveryMode(new Date(activity.occurredAt), preferences)]);
    }
  }

  async markFormerAssignments(client:PostgresQueryable,organizationId:string,accountId:string,actorId:string):Promise<string[]>{
    const table=await client.query<{exists:boolean}>("SELECT to_regclass('stash_tasks') IS NOT NULL AS exists");if(!table.rows[0]?.exists)return [];
    await client.query("ALTER TABLE stash_tasks ADD COLUMN IF NOT EXISTS former_assignee_ids JSONB NOT NULL DEFAULT '[]'::jsonb CHECK(jsonb_typeof(former_assignee_ids)='array')");
    const affected=await client.query<{id:string}>(`SELECT task.id FROM stash_tasks task JOIN stash_workspaces workspace ON task.workspace_id=workspace.id
      WHERE workspace.owner_type='organization' AND workspace.organization_owner_id=$1 AND task.assignee_ids ? $2 ORDER BY task.id FOR UPDATE OF task`,[organizationId,accountId]);
    const before=new Map<string,TaskPlanningReadModel>();for(const {id} of affected.rows){const current=await client.query<any>(taskPlanningSelectById,[id,actorId]);
      if(current.rows[0])before.set(id,readModel(current.rows[0]));}
    await client.query(`UPDATE stash_tasks task SET former_assignee_ids=CASE WHEN former_assignee_ids ? $2 THEN former_assignee_ids
      ELSE former_assignee_ids||to_jsonb($2::text) END FROM stash_workspaces workspace WHERE task.workspace_id=workspace.id
      AND workspace.owner_type='organization' AND workspace.organization_owner_id=$1 AND task.assignee_ids ? $2`,[organizationId,accountId]);
    const ids=affected.rows.map(({id})=>id).sort();for(const taskId of ids){const refreshed=await client.query<any>(taskPlanningSelectById,[taskId,actorId]);
      if(!refreshed.rows[0])continue;const taskProjection=projection(refreshed.rows[0]);await this.hooks.recordProjection(client,taskProjection);
      const previous=before.get(taskId);if(previous)await this.recordTaskActivity(client,actorId,taskProjection.workspaceId,taskId,
        "task_departed_assignee_marked",previous,readModel(refreshed.rows[0]));}return ids;
  }

  createTaskFromBlock(memberId: string, noteId: string, blockKey: string, draft: CreateTaskFromBlockDraft): Promise<CreateTaskFromBlockOutcome> {
    return this.createTaskFromSourceBlock(memberId, noteId, blockKey, draft) as Promise<CreateTaskFromBlockOutcome>;
  }

  createWorkspaceTaskFromBlock(memberId: string, noteId: string, blockKey: string,
    draft: Omit<CreateTaskFromBlockDraft, "projectId">): Promise<CreateWorkspaceTaskFromBlockOutcome> {
    return this.createTaskFromSourceBlock(memberId, noteId, blockKey, draft) as Promise<CreateWorkspaceTaskFromBlockOutcome>;
  }

  private async createTaskFromSourceBlock(memberId: string, noteId: string, blockKey: string,
    draft: CreateTaskFromBlockDraft | Omit<CreateTaskFromBlockDraft, "projectId">) {
    return this.kernel.transaction(async (client) => { await this.hooks.prepare(client);
      const row = (await client.query<any>(`SELECT note.workspace_id, note.content, note.document, note.revision,
        note.tags, note.project_id, note.reminder_at, note.created_by_account_id, note.created_at, note.archived_at,
        creator.name AS created_by_name FROM stash_notes note JOIN stash_workspaces workspace ON workspace.id=note.workspace_id
        JOIN stash_accounts creator ON creator.id=note.created_by_account_id WHERE note.id=$1 AND note.archived_at IS NULL AND
        ((workspace.owner_type='personal' AND workspace.personal_owner_id=$2) OR (workspace.owner_type='organization' AND EXISTS
          (SELECT 1 FROM stash_organization_memberships membership WHERE membership.organization_id=workspace.organization_owner_id
            AND membership.account_id=$2))) FOR UPDATE`, [noteId, memberId])).rows[0];
      if (!row) return { status: "note_not_found" as const };
      if ("projectId" in draft && !(await client.query("SELECT 1 FROM stash_projects WHERE id=$1 AND workspace_id=$2", [draft.projectId, row.workspace_id])).rowCount)
        return { status: "project_forbidden" as const };
      const blocks = row.document.blocks as Array<{ blockKey?: string; id?: string }>;
      const matches = blocks.filter((block) => block.blockKey === blockKey); if (matches.length !== 1) return { status: "block_not_found" as const };
      const block = matches[0]!; const blockId = block.id ?? randomUUID();
      if (block.id && blocks.filter((candidate) => candidate.id === blockId).length !== 1) return { status: "ambiguous_block" as const };
      if (!block.id) {
        const before = { ...row, id: noteId, workspace_id: row.workspace_id }; block.id = blockId;
        const content = richTextToMarkdown(row.document);
        await client.query("UPDATE stash_notes SET document=$2::jsonb,content=$3,revision=revision+1 WHERE id=$1", [noteId, JSON.stringify(row.document), content]);
        row.content = content; row.revision = Number(row.revision) + 1;
        await this.hooks.recordIdentifiedNoteBlock(client, memberId, before, { ...row, id: noteId, workspace_id: row.workspace_id }, noteProjection(row, noteId));
      }
      let task: PortableExportTaskProjection;
      if ("projectId" in draft) {
        task = await this.createTask(client, { ...draft, workspaceId: row.workspace_id, sourceNoteIds: [noteId], sourceBlocks: [{ noteId, blockId }] });
        await client.query("INSERT INTO stash_tasks (id,workspace_id,project_id,task_key,workflow_status_id,title,created_by_account_id,created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)",
          [task.id, row.workspace_id, task.projectId, task.key, task.status.id, task.title, memberId, task.createdAt]);
      } else {
        const workflow = await this.hooks.ensureCanonicalWorkflow(client, row.workspace_id);
        const status = workflow.statuses.find(({ category }) => category === "unstarted")!;
        task = { schema: "stash.task.v1", ...draft, workspaceId: row.workspace_id, status,
          sourceNoteIds: [noteId], sourceBlocks: [{ noteId, blockId }] };
        await client.query(`INSERT INTO stash_tasks(id,workspace_id,project_id,task_key,workflow_status_id,workspace_workflow_status_id,title,description,
          created_by_account_id,created_at) VALUES($1,$2,NULL,NULL,NULL,$3,$4,'',$5,$6)`, [task.id, row.workspace_id, status.id, task.title, memberId, task.createdAt]);
      }
      await client.query("INSERT INTO stash_task_note_sources(task_id,note_id) VALUES($1,$2)", [task.id, noteId]);
      await client.query("INSERT INTO stash_task_block_sources(task_id,note_id,block_id) VALUES($1,$2,$3)", [task.id, noteId, blockId]);
      await this.hooks.recordProjection(client, task); await this.hooks.recordTaskSourceActivity(client, memberId, row.workspace_id, task);
      return { status: "created" as const, task, sourceBlock: { noteId, blockId } };
    });
  }

  async linkTaskToBlock(memberId: string, taskId: string, noteId: string, blockKey: string) {
    return this.kernel.transaction(async (client) => { await this.hooks.prepare(client);
      const taskRow = (await client.query<any>(`SELECT task.*,status.name AS status_name,status.category,creator.name AS created_by_name
        FROM stash_tasks task JOIN stash_workflow_statuses status ON status.id=task.workflow_status_id
        JOIN stash_accounts creator ON creator.id=task.created_by_account_id JOIN stash_workspaces workspace ON workspace.id=task.workspace_id
        WHERE task.id=$1 AND ((workspace.owner_type='personal' AND workspace.personal_owner_id=$2) OR (workspace.owner_type='organization' AND EXISTS
          (SELECT 1 FROM stash_organization_memberships membership WHERE membership.organization_id=workspace.organization_owner_id
            AND membership.account_id=$2))) FOR UPDATE`, [taskId, memberId])).rows[0];
      if (!taskRow) return { status: "task_not_found" as const };
      const noteRow = (await client.query<any>(`SELECT note.*,creator.name AS created_by_name FROM stash_notes note
        JOIN stash_accounts creator ON creator.id=note.created_by_account_id WHERE note.id=$1 AND note.workspace_id=$2
        AND note.archived_at IS NULL FOR UPDATE`, [noteId, taskRow.workspace_id])).rows[0];
      if (!noteRow) return { status: "note_not_found" as const };
      const blocks = noteRow.document.blocks as Array<{ blockKey?: string; id?: string }>;
      const matches = blocks.filter((block) => block.blockKey === blockKey); if (matches.length !== 1) return { status: "block_not_found" as const };
      const block = matches[0]!; const blockId = block.id ?? randomUUID();
      if (block.id && blocks.filter((candidate) => candidate.id === blockId).length !== 1) return { status: "ambiguous_block" as const };
      const existing = await client.query("SELECT 1 FROM stash_task_block_sources WHERE task_id=$1 AND note_id=$2 AND block_id=$3", [taskId, noteId, blockId]);
      const sourceBlock: TaskSourceBlockReference = { noteId, blockId };
      if (!existing.rowCount) {
        if (!block.id) {
          const before = { ...noteRow }; block.id = blockId; const content = richTextToMarkdown(noteRow.document);
          await client.query("UPDATE stash_notes SET document=$2::jsonb,content=$3,revision=revision+1 WHERE id=$1", [noteId, JSON.stringify(noteRow.document), content]);
          noteRow.content = content; noteRow.revision = Number(noteRow.revision) + 1;
          await this.hooks.recordIdentifiedNoteBlock(client, memberId, before, noteRow, noteProjection(noteRow, noteId));
        }
        await client.query("INSERT INTO stash_task_note_sources(task_id,note_id) VALUES($1,$2) ON CONFLICT DO NOTHING", [taskId, noteId]);
        await client.query("INSERT INTO stash_task_block_sources(task_id,note_id,block_id) VALUES($1,$2,$3)", [taskId, noteId, blockId]);
      }
      const noteSources = await client.query<{ note_id: string }>("SELECT note_id FROM stash_task_note_sources WHERE task_id=$1 ORDER BY note_id", [taskId]);
      const blockSources = await client.query<{ note_id: string; block_id: string }>("SELECT note_id,block_id FROM stash_task_block_sources WHERE task_id=$1 ORDER BY note_id,block_id", [taskId]);
      const task: PortableTaskProjection = { schema: "stash.task.v1", id: taskId, workspaceId: taskRow.workspace_id,
        projectId: taskRow.project_id, title: taskRow.title, key: taskRow.task_key,
        status: { id: taskRow.workflow_status_id, name: taskRow.status_name, category: taskRow.category },
        sourceNoteIds: noteSources.rows.map(({ note_id }) => note_id), sourceBlocks: blockSources.rows.map(({ note_id, block_id }) => ({ noteId: note_id, blockId: block_id })),
        createdAt: new Date(taskRow.created_at).toISOString(), createdBy: { localAccountId: taskRow.created_by_account_id, displayName: taskRow.created_by_name } };
      if (!existing.rowCount) await this.hooks.recordProjection(client, task);
      return { status: existing.rowCount ? "already_linked" as const : "linked" as const, task, sourceBlock };
    });
  }

  async findTaskByKey(memberId: string, projectId: string, taskKey: string) {
    return this.kernel.withSession(async (client) => { await this.hooks.prepare(client);
      const row = (await client.query<any>(taskPlanningSelect, [projectId, taskKey, memberId])).rows[0];
      return row ? { status: "found" as const, task: readModel(row) } : { status: "not_found" as const }; });
  }

  async listTaskSourceBlocks(memberId: string, taskId: string) {
    return this.kernel.withSession(async (client) => { await this.hooks.prepare(client);
      const result = await client.query<any>(`SELECT source.note_id, source.block_id, note.document
        FROM stash_tasks task JOIN stash_workspaces workspace ON workspace.id = task.workspace_id
        LEFT JOIN stash_task_block_sources source ON source.task_id = task.id
        LEFT JOIN stash_notes note ON note.id = source.note_id
        WHERE task.id = $1 AND ((workspace.owner_type = 'personal' AND workspace.personal_owner_id = $2)
        OR (workspace.owner_type = 'organization' AND EXISTS (SELECT 1 FROM stash_organization_memberships membership
          WHERE membership.organization_id = workspace.organization_owner_id AND membership.account_id = $2)))
        ORDER BY source.note_id NULLS FIRST, source.block_id NULLS FIRST`, [taskId, memberId]);
      if (!result.rowCount) return { status: "task_not_found" as const };
      return { status: "found" as const, sourceBlocks: result.rows.filter((row: any) => row.note_id !== null).map((row: any) => {
        const matches = Array.isArray(row.document?.blocks) ? row.document.blocks.filter((block: any) => block.id === row.block_id).length : 0;
        return { noteId: row.note_id, blockId: row.block_id,
          state: matches === 1 ? "linked" as const : matches > 1 ? "ambiguous" as const : "broken" as const };
      }) };
    });
  }

  async listLinkedTasks(memberId: string, noteId: string) {
    return this.kernel.withSession(async (client) => { await this.hooks.prepare(client);
      const result = await client.query<any>(`SELECT task.id, task.task_key, task.title, status.id AS status_id,
        status.name AS status_name, status.category, source.block_id, note.document
        FROM stash_notes note JOIN stash_workspaces workspace ON workspace.id = note.workspace_id
        LEFT JOIN stash_task_block_sources source ON source.note_id = note.id
        LEFT JOIN stash_tasks task ON task.id = source.task_id
        LEFT JOIN stash_workflow_statuses status ON status.id = task.workflow_status_id
        WHERE note.id = $1 AND note.archived_at IS NULL AND ((workspace.owner_type = 'personal' AND workspace.personal_owner_id = $2)
        OR (workspace.owner_type = 'organization' AND EXISTS (SELECT 1 FROM stash_organization_memberships membership
          WHERE membership.organization_id = workspace.organization_owner_id AND membership.account_id = $2)))
        ORDER BY task.created_at NULLS FIRST, task.id NULLS FIRST`, [noteId, memberId]);
      if (!result.rowCount) return { status: "note_not_found" as const };
      return { status: "found" as const, tasks: result.rows.filter((row: any) => row.id !== null).map((row: any) => {
        const matches = Array.isArray(row.document?.blocks) ? row.document.blocks.filter((block: any) => block.id === row.block_id).length : 0;
        return { id: row.id, key: row.task_key, title: row.title,
          status: { id: row.status_id, name: row.status_name, category: row.category }, sourceBlock: { noteId, blockId: row.block_id },
          relationshipState: matches === 1 ? "linked" as const : matches > 1 ? "ambiguous" as const : "broken" as const };
      }) };
    });
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
      const activity = await this.recordTaskActivity(client, memberId, task.workspaceId, task.id, "task_planning_updated", before, task, cause);
      if (cause.kind === "agent") await this.hooks.recordAgentAudit(client, memberId, task.workspaceId, task.id, cause);
      await this.recordAssignmentNotifications(client, projectId, activity, before, task);
      for (const affectedId of (row.affected_dependency_task_ids ?? []).filter((id: string) => id !== task.id)) {
        const affectedBefore = (await client.query<any>(taskPlanningSelectById, [affectedId, memberId])).rows[0];
        await client.query("UPDATE stash_tasks SET revision=revision+1,field_revisions=jsonb_set(field_revisions,'{dependencies}',to_jsonb(revision+1),true) WHERE id=$1", [affectedId]);
        const affected = (await client.query<any>(taskPlanningSelectById, [affectedId, memberId])).rows[0];
        if (affected) { await this.hooks.recordProjection(client, projection(affected)); if (affectedBefore)
          await this.recordTaskActivity(client, memberId, task.workspaceId, affectedId, "task_planning_updated",
            readModel(affectedBefore), readModel(affected), cause); }
      }
      return { status: "updated" as const, task };
    });
  }

  async findWorkflow(memberId: string, projectId: string) {
    return this.kernel.transaction(async (client) => {
      await this.hooks.prepare(client);
      const access = await this.findProjectWorkflowAccess(client, memberId, projectId, true);
      if (access !== "member") return { status: access };
      await this.ensureDefaultWorkflow(client, projectId);
      return { status: "found" as const, workflow: await this.loadWorkflow(client, projectId) };
    });
  }

  async replaceWorkflow(memberId: string, projectId: string, expectedRevision: number, statuses: WorkflowStatus[], newStatusIds: ReadonlySet<string>) {
    return this.kernel.transaction(async (client) => {
      await this.hooks.prepare(client);
      const access = await this.findProjectWorkflowAccess(client, memberId, projectId, true);
      if (access !== "member") return { status: access };
      await this.ensureDefaultWorkflow(client, projectId);
      const currentRevision = await client.query<{ workflow_revision: number }>("SELECT workflow_revision FROM stash_projects WHERE id = $1", [projectId]);
      if (currentRevision.rows[0]!.workflow_revision !== expectedRevision) return { status: "stale_status" as const };
      const current = await client.query<{ id: string }>("SELECT id FROM stash_workflow_statuses WHERE project_id = $1 ORDER BY position FOR UPDATE", [projectId]);
      const currentIds = new Set(current.rows.map(({ id }) => id));
      if (statuses.filter(({ id }) => currentIds.has(id)).length !== currentIds.size
        || statuses.some(({ id }) => !currentIds.has(id) && !newStatusIds.has(id))) return { status: "stale_status" as const };
      const currentWorkflow = await this.loadWorkflow(client, projectId);
      if (JSON.stringify(currentWorkflow.statuses) === JSON.stringify(statuses)) return { status: "updated" as const, workflow: currentWorkflow };
      const previousStatuses = new Map(currentWorkflow.statuses.map((status) => [status.id, status]));
      const taskVisibleStatusChanges = statuses.filter((status) => { const previous = previousStatuses.get(status.id);
        return previous && (previous.name !== status.name || previous.category !== status.category || previous.archived !== status.archived); }).map(({ id }) => id);
      const collision = await client.query("SELECT 1 FROM stash_workflow_statuses WHERE id = ANY($1::uuid[]) AND project_id <> $2 LIMIT 1", [statuses.map(({ id }) => id), projectId]);
      if (collision.rowCount) return { status: "stale_status" as const };
      await client.query(workflowTemporaryRenameSql, [projectId]);
      for (const status of statuses) await client.query(`INSERT INTO stash_workflow_statuses (id, project_id, name, category, position, archived)
        VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (id) DO UPDATE SET name=EXCLUDED.name,category=EXCLUDED.category,
        position=EXCLUDED.position,archived=EXCLUDED.archived WHERE stash_workflow_statuses.project_id=EXCLUDED.project_id`,
      [status.id, projectId, status.name, status.category, status.position, status.archived]);
      await client.query("UPDATE stash_projects SET workflow_revision = workflow_revision + 1 WHERE id = $1", [projectId]);
      if (taskVisibleStatusChanges.length) {
        const assigned = await client.query<{ id: string }>(`SELECT id FROM stash_tasks WHERE project_id=$1 AND workflow_status_id=ANY($2::uuid[]) ORDER BY id FOR UPDATE`, [projectId, taskVisibleStatusChanges]);
        for (const { id } of assigned.rows) await client.query(`UPDATE stash_tasks SET revision=revision+1,
          field_revisions=jsonb_set(field_revisions,'{statusId}',to_jsonb(revision+1),true) WHERE id=$1`, [id]);
      }
      const workflow = await this.loadWorkflow(client, projectId);
      await this.hooks.recordWorkflowProjection(client, workflow);
      const affectedTasks = await client.query<{ id: string }>("SELECT id FROM stash_tasks WHERE project_id = $1 ORDER BY id", [projectId]);
      for (const { id } of affectedTasks.rows) {
        const taskRow = await client.query<any>(taskPlanningSelectById, [id, memberId]);
        if (taskRow.rows[0]) await this.hooks.recordProjection(client, projection(taskRow.rows[0]));
      }
      return { status: "updated" as const, workflow };
    });
  }

  async listBoards(memberId: string, projectId: string) {
    return this.kernel.withSession(async (client) => { await this.prepareBoards(client);
      if (await this.findProjectWorkflowAccess(client, memberId, projectId) === "not_found") return { status: "not_found" as const };
      const result = await client.query<any>("SELECT id, project_id, name, group_by, created_at FROM stash_boards WHERE project_id = $1 ORDER BY created_at, id", [projectId]);
      return { status: "found" as const, boards: result.rows.map((row: any) => boardFromRow(row)) }; });
  }

  async createBoard(memberId: string, board: Board) {
    return this.kernel.transaction(async (client) => { await this.prepareBoards(client);
      const access = await this.findProjectWorkflowAccess(client, memberId, board.projectId, true);
      if (access !== "member") return { status: access };
      await client.query("INSERT INTO stash_boards (id, project_id, name, group_by, created_at) VALUES ($1,$2,$3,$4,$5)", [board.id, board.projectId, board.name, board.groupBy, board.createdAt]);
      await this.hooks.recordBoardProjection(client, board);
      return { status: "created" as const, board }; });
  }

  async readBoard(memberId: string, projectId: string, boardId: string) {
    return this.kernel.withSession(async (client) => { await this.prepareBoards(client);
      if (await this.findProjectWorkflowAccess(client, memberId, projectId) === "not_found") return { status: "not_found" as const };
      const found = await client.query<any>("SELECT id, project_id, name, group_by, created_at FROM stash_boards WHERE id = $1 AND project_id = $2", [boardId, projectId]);
      if (!found.rowCount) return { status: "not_found" as const };
      const rows = await client.query<any>(`SELECT task.id, task.task_key, task.title, task.assignee_ids, task.priority, task.label_names,
        status.id AS status_id, status.name AS status_name, status.category FROM stash_tasks task JOIN stash_workflow_statuses status
        ON status.id=task.workflow_status_id WHERE task.project_id=$1 ORDER BY task.task_key,task.id`, [projectId]);
      const tasks: BoardTask[] = rows.rows.map((row: any) => ({ id: row.id, key: row.task_key, title: row.title,
        status: { id: row.status_id, name: row.status_name, category: row.category }, assigneeIds: row.assignee_ids, priority: row.priority, labelNames: row.label_names }));
      return { status: "found" as const, board: boardFromRow(found.rows[0]), tasks, statuses: (await this.loadWorkflow(client, projectId)).statuses }; });
  }

  async moveTaskOnBoard(memberId: string, projectId: string, boardId: string, taskKey: string, statusId: string) {
    return this.kernel.transaction(async (client) => { await this.prepareBoards(client);
      const access = await this.findProjectWorkflowAccess(client, memberId, projectId, true);
      if (access !== "member") return { status: access };
      const board = await client.query<{ group_by: string }>("SELECT group_by FROM stash_boards WHERE id=$1 AND project_id=$2", [boardId, projectId]);
      if (!board.rowCount) return { status: "not_found" as const };
      if (board.rows[0]!.group_by !== "status") return { status: "unsupported_group" as const };
      const status = await client.query<any>("SELECT id,name,category FROM stash_workflow_statuses WHERE id=$1 AND project_id=$2 AND archived=FALSE", [statusId, projectId]);
      if (!status.rowCount) return { status: "invalid_status" as const };
      const beforeRow = (await client.query<any>(taskPlanningSelect, [projectId, taskKey, memberId])).rows[0];
      if (!beforeRow) return { status: "not_found" as const };
      const changed = await client.query<any>(`UPDATE stash_tasks SET workflow_status_id=$3,revision=revision+1,
        field_revisions=jsonb_set(field_revisions,'{statusId}',to_jsonb(revision+1),true) WHERE project_id=$1 AND task_key=$2
        RETURNING id,task_key,title,assignee_ids,priority,label_names`, [projectId, taskKey, statusId]);
      if (!changed.rowCount) return { status: "not_found" as const };
      const row = changed.rows[0]; const task: BoardTask = { id: row.id, key: row.task_key, title: row.title, status: status.rows[0],
        assigneeIds: row.assignee_ids, priority: row.priority, labelNames: row.label_names };
      const afterRow = (await client.query<any>(taskPlanningSelectById, [task.id, memberId])).rows[0];
      if (afterRow) { const after = readModel(afterRow); await this.hooks.recordProjection(client, projection(afterRow));
        await this.recordTaskActivity(client, memberId, after.workspaceId, task.id, "task_status_changed", readModel(beforeRow), after); }
      return { status: "moved" as const, task }; });
  }

  async findProjectWorkflowAccess(client: PostgresQueryable, memberId: string, projectId: string, lock = false) {
    const result = await client.query<{ member: boolean; guest: boolean }>(`SELECT
      ((workspace.owner_type='personal' AND workspace.personal_owner_id=$2) OR (workspace.owner_type='organization' AND EXISTS
        (SELECT 1 FROM stash_organization_memberships membership WHERE membership.organization_id=workspace.organization_owner_id AND membership.account_id=$2))) AS member,
      EXISTS (SELECT 1 FROM stash_project_guests guest WHERE guest.project_id=project.id AND guest.account_id=$2) AS guest
      FROM stash_projects project JOIN stash_workspaces workspace ON workspace.id=project.workspace_id WHERE project.id=$1
      ${lock ? "FOR UPDATE OF project" : ""}`, [projectId, memberId]);
    const row = result.rows[0]; return !row ? "not_found" as const : row.member ? "member" as const : row.guest ? "forbidden" as const : "not_found" as const;
  }

  async loadWorkflow(client: PostgresQueryable, projectId: string): Promise<ProjectWorkflow> {
    const project = await client.query<{ workflow_revision: number }>("SELECT workflow_revision FROM stash_projects WHERE id=$1", [projectId]);
    const statuses = await client.query<WorkflowStatus>("SELECT id,name,category,position,archived FROM stash_workflow_statuses WHERE project_id=$1 ORDER BY position,id", [projectId]);
    return { schema: "stash.workflow.v1", projectId, revision: project.rows[0]!.workflow_revision, statuses: statuses.rows };
  }

  async ensureDefaultWorkflow(client: PostgresQueryable, projectId: string) {
    await this.hooks.prepare(client);
    const statuses = [[randomUUID(),projectId,"Backlog","unstarted",0],[randomUUID(),projectId,"Ready","unstarted",1],
      [randomUUID(),projectId,"In Progress","started",2],[randomUUID(),projectId,"In Review","started",3],[randomUUID(),projectId,"Done","completed",4]] as const;
    await client.query(`INSERT INTO stash_workflow_statuses (id,project_id,name,category,position) VALUES
      ${statuses.map((_, index) => `($${index*5+1},$${index*5+2},$${index*5+3},$${index*5+4},$${index*5+5})`).join(", ")} ON CONFLICT DO NOTHING`, statuses.flat());
    const initialized = await client.query("UPDATE stash_projects SET workflow_revision=1 WHERE id=$1 AND workflow_revision=0 RETURNING id", [projectId]);
    if (initialized.rowCount) await this.hooks.recordWorkflowProjection(client, await this.loadWorkflow(client, projectId));
  }

  async prepareBoards(client: PostgresQueryable) {
    await this.hooks.prepare(client);
    await client.query(`CREATE TABLE IF NOT EXISTS stash_boards (
      id UUID PRIMARY KEY, project_id UUID NOT NULL REFERENCES stash_projects(id) ON DELETE CASCADE,
      name TEXT NOT NULL CHECK (char_length(name) BETWEEN 1 AND 100), group_by TEXT NOT NULL CHECK (group_by IN ('status','priority')),
      created_at TIMESTAMPTZ NOT NULL, UNIQUE (project_id, name))`);
  }

  async prepareStructuredTaskEdits(client: PostgresQueryable) {
    await this.hooks.prepare(client);
    await client.query(`CREATE TABLE IF NOT EXISTS stash_task_edit_operations (
      task_id UUID NOT NULL REFERENCES stash_tasks(id) ON DELETE CASCADE, operation_id UUID NOT NULL,
      digest TEXT NOT NULL, outcome JSONB NOT NULL, PRIMARY KEY (task_id, operation_id))`);
    await client.query(`CREATE TABLE IF NOT EXISTS stash_task_edit_conflicts (
      id UUID PRIMARY KEY, task_id UUID NOT NULL REFERENCES stash_tasks(id) ON DELETE CASCADE,
      base_revision INTEGER NOT NULL, current_revision INTEGER NOT NULL, fields JSONB NOT NULL,
      contribution JSONB NOT NULL, created_by_account_id UUID NOT NULL REFERENCES stash_accounts(id),
      created_by_display_name TEXT NOT NULL, created_at TIMESTAMPTZ NOT NULL, resolved_at TIMESTAMPTZ,
      resolution TEXT CHECK (resolution IN ('keep_current','apply_contribution')), resolution_operation_id UUID)`);
    await client.query("ALTER TABLE stash_task_edit_conflicts ADD COLUMN IF NOT EXISTS resolution_operation_id UUID");
    await client.query("ALTER TABLE stash_task_edit_conflicts ADD COLUMN IF NOT EXISTS created_by_display_name TEXT");
    await client.query(`UPDATE stash_task_edit_conflicts conflict SET created_by_display_name=account.name
      FROM stash_accounts account WHERE conflict.created_by_account_id=account.id AND conflict.created_by_display_name IS NULL`);
    await client.query("ALTER TABLE stash_task_edit_conflicts ALTER COLUMN created_by_display_name SET NOT NULL");
  }

  async applyStructuredTaskEdit(memberId: string, projectId: string, taskKey: string, batch: TaskEditBatch) {
    return this.kernel.transaction(async (client) => {
      await this.prepareStructuredTaskEdits(client);
      const writable = await client.query<{ workspace_id: string }>(`SELECT workspace.id AS workspace_id FROM stash_projects project JOIN stash_workspaces workspace ON workspace.id = project.workspace_id
        WHERE project.id = $1 AND ((workspace.owner_type = 'personal' AND workspace.personal_owner_id = $2) OR
        (workspace.owner_type = 'organization' AND EXISTS (SELECT 1 FROM stash_organization_memberships membership
          WHERE membership.organization_id = workspace.organization_owner_id AND membership.account_id = $2))) FOR UPDATE OF project`, [projectId, memberId]);
      if (!writable.rowCount) return { status: "not_found" as const };
      if (batch.changes.dependencies !== undefined) await client.query("SELECT pg_advisory_xact_lock(hashtext('stash-task-dependencies'),hashtext($1))", [writable.rows[0]!.workspace_id]);
      const current = await client.query<any>(`${taskPlanningSelect} FOR UPDATE OF task`, [projectId, taskKey, memberId]);
      const row = current.rows[0]; if (!row) return { status: "not_found" as const };
      const beforeTask = readModel(row);
      if (batch.baseRevision > Number(row.revision)) return { status: "invalid_revision" as const };
      const digest = taskEditDigest(batch);
      const prior = await client.query<{ digest: string; outcome: any }>(
        "SELECT digest, outcome FROM stash_task_edit_operations WHERE task_id = $1 AND operation_id = $2", [row.id, batch.operationId]);
      if (prior.rows[0]) return prior.rows[0].digest === digest ? prior.rows[0].outcome : { status: "operation_identity_conflict" as const };
      const fields = Object.keys(batch.changes);
      const forcedConflicts = new Set<string>();
      if (batch.changes.statusId) {
        const status = await client.query<{ archived: boolean }>(
          "SELECT archived FROM stash_workflow_statuses WHERE id=$1 AND project_id=$2 FOR UPDATE", [batch.changes.statusId, projectId]);
        if (!status.rows[0]) return { status: "invalid_reference" as const };
        if (status.rows[0].archived) forcedConflicts.add("statusId");
      }
      const incompatible = fields.filter((field) => forcedConflicts.has(field) || Number(row.field_revisions?.[field] ?? 0) > batch.baseRevision);
      const compatible = Object.fromEntries(Object.entries(batch.changes).filter(([field]) => !incompatible.includes(field))) as TaskPlanningUpdate;
      if (Object.keys(compatible).length) {
        const applied = await this.applyStructuredTaskChanges(client, memberId, row, compatible);
        if (!applied) return { status: "invalid_reference" as const };
        row.revision += 1; row.field_revisions = { ...(row.field_revisions ?? {}) };
        for (const field of Object.keys(compatible)) row.field_revisions[field] = row.revision;
        await client.query("UPDATE stash_tasks SET revision = $2, field_revisions = $3::jsonb WHERE id = $1",
          [row.id, row.revision, JSON.stringify(row.field_revisions)]);
      }
      let outcome: any;
      if (incompatible.length) {
        const conflictId = randomUUID();
        const contribution = Object.fromEntries(incompatible.map((field) => [field, (batch.changes as Record<string, unknown>)[field]]));
        const conflict: TaskEditConflict = { id: conflictId, taskId: row.id, baseRevision: batch.baseRevision,
          currentRevision: row.revision, fields: incompatible, contribution, createdAt: batch.createdAt,
          createdBy: { displayName: batch.createdBy.displayName, attribution: "recorded" } };
        await client.query(`INSERT INTO stash_task_edit_conflicts
          (id,task_id,base_revision,current_revision,fields,contribution,created_by_account_id,created_by_display_name,created_at)
          VALUES ($1,$2,$3,$4,$5::jsonb,$6::jsonb,$7,$8,$9)`, [conflictId, row.id, batch.baseRevision, row.revision,
          JSON.stringify(incompatible), JSON.stringify(contribution), memberId, batch.createdBy.displayName, batch.createdAt]);
        outcome = { status: "conflict_preserved", conflict };
      } else {
        const saved = await client.query<any>(taskPlanningSelect, [projectId, taskKey, memberId]);
        const task = readModel(saved.rows[0]);
        await this.hooks.recordProjection(client, projection(saved.rows[0]));
        outcome = { status: "applied", task, revision: row.revision, appliedFields: fields };
      }
      if (Object.keys(compatible).length && incompatible.length) {
        const saved = await client.query<any>(taskPlanningSelect, [projectId, taskKey, memberId]);
        await this.hooks.recordProjection(client, projection(saved.rows[0]));
      }
      if (Object.keys(compatible).length) {
        const saved = await client.query<any>(taskPlanningSelectById, [row.id, memberId]);
        if (saved.rows[0]) {
          const afterTask = readModel(saved.rows[0]);
          const activity = await this.recordTaskActivity(client, memberId, row.workspace_id, row.id,
            "task_structured_edit_applied", beforeTask, afterTask, batch.cause);
          if (batch.cause?.kind === "agent") await this.hooks.recordStructuredAgentAudit(client, memberId, row.workspace_id, row.id, batch.cause);
          await this.recordAssignmentNotifications(client, projectId, activity, beforeTask, afterTask);
        }
      }
      await client.query("INSERT INTO stash_task_edit_operations (task_id,operation_id,digest,outcome) VALUES ($1,$2,$3,$4::jsonb)",
        [row.id, batch.operationId, digest, JSON.stringify(outcome)]);
      return outcome;
    });
  }

  async listStructuredTaskConflicts(memberId: string, projectId: string, taskKey: string) {
    return this.kernel.withSession(async (client) => {
      await this.prepareStructuredTaskEdits(client);
      const writable = await client.query(`SELECT 1 FROM stash_projects project JOIN stash_workspaces workspace ON workspace.id=project.workspace_id
        WHERE project.id=$1 AND ((workspace.owner_type='personal' AND workspace.personal_owner_id=$2) OR
        (workspace.owner_type='organization' AND EXISTS (SELECT 1 FROM stash_organization_memberships membership
          WHERE membership.organization_id=workspace.organization_owner_id AND membership.account_id=$2)))`, [projectId,memberId]);
      if (!writable.rowCount) return { status: "not_found" as const };
      const task = await client.query<any>(taskPlanningSelect, [projectId, taskKey, memberId]);
      if (!task.rows[0]) return { status: "not_found" as const };
      const rows = await client.query<any>(`SELECT conflict.* FROM stash_task_edit_conflicts conflict
        WHERE conflict.task_id = $1 AND conflict.resolved_at IS NULL ORDER BY conflict.created_at, conflict.id`, [task.rows[0].id]);
      return { status: "found" as const, revision: task.rows[0].revision, conflicts: rows.rows.map(taskConflictFromRow) };
    });
  }

  async resolveStructuredTaskConflict(memberId: string, projectId: string, taskKey: string, conflictId: string,
    resolution: "keep_current" | "apply_contribution", expectedRevision: number, operationId?: string) {
    return this.kernel.transaction(async (client) => {
      await this.prepareStructuredTaskEdits(client);
      const writable = await client.query<{ workspace_id: string }>(`SELECT workspace.id AS workspace_id FROM stash_projects project JOIN stash_workspaces workspace ON workspace.id = project.workspace_id
        WHERE project.id = $1 AND ((workspace.owner_type = 'personal' AND workspace.personal_owner_id = $2) OR
        (workspace.owner_type = 'organization' AND EXISTS (SELECT 1 FROM stash_organization_memberships membership
          WHERE membership.organization_id = workspace.organization_owner_id AND membership.account_id = $2))) FOR UPDATE OF project`, [projectId, memberId]);
      if (!writable.rowCount) return { status: "not_found" as const };
      await client.query("SELECT pg_advisory_xact_lock(hashtext('stash-task-dependencies'),hashtext($1))", [writable.rows[0]!.workspace_id]);
      const taskResult = await client.query<any>(`${taskPlanningSelect} FOR UPDATE OF task`, [projectId, taskKey, memberId]);
      const row = taskResult.rows[0]; if (!row) return { status: "not_found" as const };
      const found = await client.query<any>(`SELECT conflict.* FROM stash_task_edit_conflicts conflict
        WHERE conflict.id = $1 AND conflict.task_id = $2 FOR UPDATE OF conflict`, [conflictId, row.id]);
      const conflictRow = found.rows[0]; if (!conflictRow) return { status: "conflict_not_found" as const };
      if (conflictRow.resolved_at) {
        if (operationId && conflictRow.resolution_operation_id === operationId && conflictRow.resolution === resolution)
          return { status: "resolved" as const, task: readModel(row), revision: row.revision, activity: undefined };
        return { status: "already_resolved" as const };
      }
      if (row.revision !== expectedRevision) return { status: "conflict_changed" as const, conflict: { ...taskConflictFromRow(conflictRow), currentRevision: row.revision } };
      const before = projection(row);
      if (resolution === "apply_contribution") {
        if (!await this.applyStructuredTaskChanges(client, memberId, row, conflictRow.contribution)) return { status: "invalid_reference" as const };
        row.revision += 1; row.field_revisions = { ...(row.field_revisions ?? {}) };
        for (const field of conflictRow.fields) row.field_revisions[field] = row.revision;
        await client.query("UPDATE stash_tasks SET revision = $2, field_revisions = $3::jsonb WHERE id = $1",
          [row.id, row.revision, JSON.stringify(row.field_revisions)]);
      }
      const occurredAt = new Date().toISOString();
      await client.query("UPDATE stash_task_edit_conflicts SET resolved_at = $2, resolution = $3, resolution_operation_id = $4 WHERE id = $1", [conflictId, occurredAt, resolution, operationId ?? null]);
      const saved = await client.query<any>(taskPlanningSelect, [projectId, taskKey, memberId]); const task = readModel(saved.rows[0]);
      const actor = await client.query<{ name: string }>("SELECT name FROM stash_accounts WHERE id = $1", [memberId]);
      const activity = { schema: "stash.activity.v1" as const, id: randomUUID(), workspaceId: task.workspaceId,
        action: "task_edit_conflict_resolved", object: { kind: "Task" as const, id: task.id },
        actor: { localAccountId: memberId, displayName: actor.rows[0]!.name }, cause: { kind: "member" as const }, occurredAt,
        before: { task: before, conflictId }, after: { task: projection(saved.rows[0]), resolution } };
      await client.query(`INSERT INTO stash_workspace_activity
        (id,workspace_id,object_kind,object_id,action,actor_account_id,cause,occurred_at,before_state,after_state)
        VALUES ($1,$2,'Task',$3,$4,$5,'member',$6,$7::jsonb,$8::jsonb)`, [activity.id, activity.workspaceId, task.id,
        activity.action, memberId, occurredAt, JSON.stringify(activity.before), JSON.stringify(activity.after)]);
      await this.hooks.recordProjection(client, projection(saved.rows[0]));
      await this.hooks.recordActivityProjection(client, activity);
      await this.recordProjectActivityNotifications(client, activity);
      if (resolution === "apply_contribution") await this.recordAssignmentNotifications(client, projectId, activity, before as TaskPlanningReadModel, task);
      return { status: "resolved" as const, task, revision: row.revision, activity };
    });
  }

  private async applyStructuredTaskChanges(client: PostgresQueryable, memberId: string, row: any, update: TaskPlanningUpdate): Promise<boolean> {
    if (update.statusId) { const status = await client.query("SELECT 1 FROM stash_workflow_statuses WHERE id=$1 AND project_id=$2 AND archived=FALSE FOR UPDATE", [update.statusId, row.project_id]); if (!status.rowCount) return false; }
    if (update.assigneeIds) { const result = await client.query(`SELECT account.id FROM stash_accounts account JOIN stash_workspaces workspace ON workspace.id=$2
      WHERE account.id=ANY($1::uuid[]) AND ((workspace.owner_type='personal' AND workspace.personal_owner_id=account.id) OR
      (workspace.owner_type='organization' AND EXISTS (SELECT 1 FROM stash_organization_memberships membership WHERE membership.organization_id=workspace.organization_owner_id AND membership.account_id=account.id)))`, [update.assigneeIds,row.workspace_id]); if (result.rowCount !== new Set(update.assigneeIds).size) return false; }
    for (const noteId of update.linkedNoteIds ?? []) { const note = await client.query("SELECT 1 FROM stash_notes WHERE id=$1 AND workspace_id=$2", [noteId,row.workspace_id]); if (!note.rowCount) return false; }
    if (update.dependencies !== undefined) {
      const all = await client.query<{id:string}>("SELECT id FROM stash_tasks WHERE workspace_id=$1 ORDER BY id FOR UPDATE", [row.workspace_id]); const ids = new Set(all.rows.map(({id})=>id));
      if (update.dependencies.some(({taskId})=>taskId===row.id || !ids.has(taskId))) return false;
      const stored = await client.query<{dependent_task_id:string;prerequisite_task_id:string}>(`SELECT edge.dependent_task_id,edge.prerequisite_task_id FROM stash_task_dependencies edge JOIN stash_tasks task ON task.id=edge.dependent_task_id WHERE task.workspace_id=$1`,[row.workspace_id]);
      const previous=stored.rows.filter((edge)=>edge.dependent_task_id===row.id||edge.prerequisite_task_id===row.id);
      const retained=stored.rows.filter((edge)=>edge.dependent_task_id!==row.id&&edge.prerequisite_task_id!==row.id);
      const proposed=update.dependencies.map((d)=>d.type==="depends_on"?{dependent_task_id:row.id,prerequisite_task_id:d.taskId}:{dependent_task_id:d.taskId,prerequisite_task_id:row.id});
      if (hasCycle(ids,[...retained,...proposed])) return false;
      await client.query("DELETE FROM stash_task_dependencies WHERE dependent_task_id=$1 OR prerequisite_task_id=$1",[row.id]);
      for(const edge of proposed) await client.query("INSERT INTO stash_task_dependencies (dependent_task_id,prerequisite_task_id) VALUES ($1,$2) ON CONFLICT DO NOTHING",[edge.dependent_task_id,edge.prerequisite_task_id]);
      for (const affectedId of [...new Set([...previous,...proposed].flatMap((edge)=>[edge.dependent_task_id,edge.prerequisite_task_id]))].filter((id)=>id!==row.id)) {
        const beforeAffected=await client.query<any>(taskPlanningSelectById,[affectedId,memberId]);
        await client.query(`UPDATE stash_tasks SET revision=revision+1,
          field_revisions=jsonb_set(field_revisions,'{dependencies}',to_jsonb(revision+1),true) WHERE id=$1`,[affectedId]);
        const affected=await client.query<any>(taskPlanningSelectById,[affectedId,memberId]);
        if(affected.rows[0]) { const affectedProjection=projection(affected.rows[0]); await this.hooks.recordProjection(client,affectedProjection);
          if(beforeAffected.rows[0]) await this.recordTaskActivity(client,memberId,row.workspace_id,affectedId,
            "task_dependency_relationship_updated",readModel(beforeAffected.rows[0]),readModel(affected.rows[0])); }
      }
    }
    const current=projection(row); const next={...current,...update} as any;
    const nextAssigneeIds=[...new Set<string>(next.assigneeIds??[])];
    const nextFormerAssigneeIds=formerAssignmentsAfterUpdate(
      row.former_assignee_ids??[],nextAssigneeIds,update.assigneeIds!==undefined);
    await client.query(`UPDATE stash_tasks SET title=$2,workflow_status_id=$3,assignee_ids=$4::jsonb,priority=$5,label_names=$6::jsonb,
      due_date=$7,estimate=$8,linked_note_ids=$9::jsonb,development_links=$10::jsonb,
      former_assignee_ids=$11::jsonb WHERE id=$1`,[row.id,next.title,
      update.statusId??current.status.id,JSON.stringify(nextAssigneeIds),next.priority??"none",JSON.stringify(next.labelNames??[]),
      next.dueDate??null,next.estimate??null,JSON.stringify(next.linkedNoteIds??[]),JSON.stringify(next.developmentLinks??[]),
      JSON.stringify(nextFormerAssigneeIds)]);
    return true;
  }

  async moveTask(memberId: string, projectId: string, taskKey: string, destinationProjectId: string) {
    return this.kernel.transaction(async (client) => {
      await this.hooks.prepare(client);
      await client.query("SELECT id FROM stash_projects WHERE id=ANY($1::uuid[]) ORDER BY id FOR UPDATE", [[projectId, destinationProjectId]]);
      const current = await client.query<any>(`${taskPlanningSelect} FOR UPDATE OF task`, [projectId, taskKey, memberId]);
      const row = current.rows[0];
      if (!row) return { status: "not_found" as const };
      if (row.project_id === destinationProjectId) return { status: "same_project" as const };
      const destination = await client.query<{ project_key: string; task_number: number }>(`UPDATE stash_projects project
        SET next_task_number = next_task_number + 1 FROM stash_workspaces workspace
        WHERE project.id = $1 AND workspace.id = project.workspace_id AND project.workspace_id = $2
          AND ((workspace.owner_type = 'personal' AND workspace.personal_owner_id = $3)
            OR (workspace.owner_type = 'organization' AND EXISTS (SELECT 1 FROM stash_organization_memberships membership
              WHERE membership.organization_id = workspace.organization_owner_id AND membership.account_id = $3)))
        RETURNING project.project_key, project.next_task_number - 1 AS task_number`, [destinationProjectId, row.workspace_id, memberId]);
      if (!destination.rowCount) return { status: "destination_forbidden" as const };
      await this.ensureDefaultWorkflow(client, destinationProjectId);
      const destinationStatus = initialWorkflowStatus(await this.loadWorkflow(client, destinationProjectId));
      const nextKey = `${destination.rows[0]!.project_key}-${destination.rows[0]!.task_number}`;
      const before = { projectId: row.project_id, key: row.task_key,
        status: { id: row.workflow_status_id, name: row.status_name, category: row.status_category } };
      await client.query(`INSERT INTO stash_task_key_aliases (project_id, task_key, task_id, created_at)
        VALUES ($1,$2,$3,now())`, [row.project_id, row.task_key, row.id]);
      await client.query(`UPDATE stash_tasks SET project_id = $2, task_key = $3, workflow_status_id = $4, revision=revision+1,
        field_revisions=field_revisions || jsonb_build_object('projectId',revision+1,'key',revision+1,'statusId',revision+1) WHERE id = $1`,
        [row.id, destinationProjectId, nextKey, destinationStatus.id]);
      const saved = await client.query<any>(taskPlanningSelect, [destinationProjectId, nextKey, memberId]);
      const task = readModel(saved.rows[0]);
      await this.hooks.recordProjection(client, projection(saved.rows[0]));
      const actor = await client.query<{ name: string }>("SELECT name FROM stash_accounts WHERE id = $1", [memberId]);
      if (!actor.rows[0]) throw new Error("Task move actor identity is unavailable");
      const activity: TaskMoveActivity = { schema: "stash.activity.v1", id: randomUUID(), workspaceId: task.workspaceId,
        action: "task_moved", object: { kind: "Task", id: task.id },
        actor: { localAccountId: memberId, displayName: actor.rows[0].name }, cause: { kind: "member" },
        occurredAt: new Date().toISOString(), before,
        after: { projectId: task.projectId, key: task.key, status: task.status } };
      await client.query(`INSERT INTO stash_workspace_activity
        (id, workspace_id, object_kind, object_id, action, actor_account_id, cause, occurred_at, before_state, after_state)
        VALUES ($1,$2,'Task',$3,$4,$5,$6,$7,$8::jsonb,$9::jsonb)`, [activity.id, activity.workspaceId, task.id,
        activity.action, memberId, activity.cause.kind, activity.occurredAt, JSON.stringify(activity.before), JSON.stringify(activity.after)]);
      await this.hooks.recordActivityProjection(client, activity);
      await this.recordProjectActivityNotifications(client, activity);
      return { status: "moved" as const, task, activity };
    });
  }

  async createTask(client: PostgresQueryable, draft: TaskCreation): Promise<PortableTaskProjection> {
    await client.query("SELECT id FROM stash_projects WHERE id = $1 FOR UPDATE", [draft.projectId]);
    await this.ensureDefaultWorkflow(client, draft.projectId);
    const workflowStatus = initialWorkflowStatus(await this.loadWorkflow(client, draft.projectId));
    const allocation = await client.query<{ project_key: string; task_number: number }>(
      `UPDATE stash_projects SET next_task_number = next_task_number + 1 WHERE id = $1
       RETURNING project_key, next_task_number - 1 AS task_number`, [draft.projectId]);
    const key = allocation.rows[0];
    if (!key) throw new Error("task_project_unavailable");
    return { schema: "stash.task.v1", ...draft, key: `${key.project_key}-${key.task_number}`, status: workflowStatus };
  }

  async saveNotification(delivery: NotificationDelivery) {
    return this.kernel.withSession(async (client) => {
      await this.prepareNotifications(client);
      const result = await client.query<any>(`INSERT INTO stash_notifications
        (id,member_id,workspace_id,project_id,trigger,summary,activity,created_at,delivery)
        SELECT $1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9 FROM stash_projects project
        JOIN stash_workspaces workspace ON workspace.id=project.workspace_id
        WHERE project.id=$4 AND workspace.id=$3 AND (
          (workspace.owner_type='personal' AND workspace.personal_owner_id=$2) OR
          (workspace.owner_type='organization' AND EXISTS (SELECT 1 FROM stash_organization_memberships membership
            WHERE membership.organization_id=workspace.organization_owner_id AND membership.account_id=$2)))
        AND ((workspace.owner_type='personal' AND workspace.personal_owner_id=$10) OR
          (workspace.owner_type='organization' AND EXISTS (SELECT 1 FROM stash_organization_memberships actor_membership
            WHERE actor_membership.organization_id=workspace.organization_owner_id AND actor_membership.account_id=$10)))
        ON CONFLICT (member_id, activity_id, trigger) DO NOTHING RETURNING *`,
      [delivery.id, delivery.memberId, delivery.workspaceId, delivery.projectId, delivery.trigger, delivery.summary,
        JSON.stringify(delivery.activity), delivery.createdAt, delivery.delivery, delivery.activity.actor.localAccountId]);
      let row = result.rows[0];
      if (!row) row = (await client.query<any>(`SELECT * FROM stash_notifications
        WHERE member_id=$1 AND activity_id=$2 AND trigger=$3`, [delivery.memberId, delivery.activity.id, delivery.trigger])).rows[0];
      if (!row) throw new Error("notification_recipient_forbidden");
      return notificationFromRow(row);
    });
  }

  async listNotifications(memberId: string) {
    return this.kernel.withSession(async (client) => { await this.prepareNotifications(client);
      const result = await client.query<any>(`SELECT notification.* FROM stash_notifications notification
        JOIN stash_workspaces workspace ON workspace.id=notification.workspace_id
        WHERE notification.member_id=$1 AND (
          (workspace.owner_type='personal' AND workspace.personal_owner_id=$1) OR
          (workspace.owner_type='organization' AND EXISTS (SELECT 1 FROM stash_organization_memberships membership
            WHERE membership.organization_id=workspace.organization_owner_id AND membership.account_id=$1)))
        ORDER BY notification.created_at DESC, notification.id DESC`, [memberId]);
      return result.rows.map(notificationFromRow); });
  }

  async markNotificationRead(memberId: string, id: string, readAt: string) {
    return this.kernel.withSession(async (client) => { await this.prepareNotifications(client);
      const result = await client.query<any>(`UPDATE stash_notifications notification SET read_at=$3
        FROM stash_workspaces workspace WHERE notification.id=$1 AND notification.member_id=$2
        AND workspace.id=notification.workspace_id AND (
          (workspace.owner_type='personal' AND workspace.personal_owner_id=$2) OR
          (workspace.owner_type='organization' AND EXISTS (SELECT 1 FROM stash_organization_memberships membership
            WHERE membership.organization_id=workspace.organization_owner_id AND membership.account_id=$2))) RETURNING notification.*`,
      [id, memberId, readAt]);
      return result.rows[0] ? notificationFromRow(result.rows[0]) : undefined; });
  }

  async getNotificationPreferences(memberId: string, projectId: string) {
    return this.kernel.withSession(async (client) => { await this.prepareNotifications(client);
      const visibility = await client.query<any>(`SELECT settings.* FROM stash_projects project
        JOIN stash_workspaces workspace ON workspace.id=project.workspace_id
        LEFT JOIN stash_notification_preferences settings ON settings.project_id=project.id AND settings.member_id=$1
        WHERE project.id=$2 AND ((workspace.owner_type='personal' AND workspace.personal_owner_id=$1) OR
          (workspace.owner_type='organization' AND EXISTS (SELECT 1 FROM stash_organization_memberships membership
            WHERE membership.organization_id=workspace.organization_owner_id AND membership.account_id=$1)))`, [memberId, projectId]);
      const row = visibility.rows[0];
      if (!row) return undefined;
      if (!row.member_id) return { activity: "followed", digest: "off" } as NotificationPreferences;
      return { activity: row.activity, digest: row.digest,
        ...(row.quiet_start ? { quietHours: { start: row.quiet_start, end: row.quiet_end, timeZone: row.quiet_time_zone } } : {}) };
    });
  }

  async saveNotificationPreferences(memberId: string, projectId: string, preferences: NotificationPreferences) {
    return this.kernel.withSession(async (client) => { await this.prepareNotifications(client);
      const result = await client.query(`INSERT INTO stash_notification_preferences
        (member_id,project_id,activity,digest,quiet_start,quiet_end,quiet_time_zone)
        SELECT $1,$2,$3,$4,$5,$6,$7 FROM stash_projects project JOIN stash_workspaces workspace ON workspace.id=project.workspace_id
        WHERE project.id=$2 AND ((workspace.owner_type='personal' AND workspace.personal_owner_id=$1) OR
          (workspace.owner_type='organization' AND EXISTS (SELECT 1 FROM stash_organization_memberships membership
            WHERE membership.organization_id=workspace.organization_owner_id AND membership.account_id=$1)))
        ON CONFLICT (member_id,project_id) DO UPDATE SET activity=EXCLUDED.activity,digest=EXCLUDED.digest,
          quiet_start=EXCLUDED.quiet_start,quiet_end=EXCLUDED.quiet_end,quiet_time_zone=EXCLUDED.quiet_time_zone RETURNING 1`,
      [memberId, projectId, preferences.activity, preferences.digest, preferences.quietHours?.start ?? null,
        preferences.quietHours?.end ?? null, preferences.quietHours?.timeZone ?? null]);
      return result.rowCount ? preferences : undefined; });
  }

  async getProjectFollow(memberId: string, projectId: string) {
    return this.kernel.withSession(async (client) => { await this.prepareNotifications(client);
      const result = await client.query<{ followed: boolean }>(`SELECT EXISTS (
        SELECT 1 FROM stash_project_follows follow WHERE follow.member_id=$1 AND follow.project_id=project.id
      ) AS followed FROM stash_projects project JOIN stash_workspaces workspace ON workspace.id=project.workspace_id
        WHERE project.id=$2 AND ((workspace.owner_type='personal' AND workspace.personal_owner_id=$1) OR
          (workspace.owner_type='organization' AND EXISTS (SELECT 1 FROM stash_organization_memberships membership
            WHERE membership.organization_id=workspace.organization_owner_id AND membership.account_id=$1)))`, [memberId, projectId]);
      return result.rows[0]?.followed; });
  }

  async saveProjectFollow(memberId: string, projectId: string, followed: boolean) {
    return this.kernel.withSession(async (client) => { await this.prepareNotifications(client);
      const visible = await client.query(`SELECT 1 FROM stash_projects project JOIN stash_workspaces workspace ON workspace.id=project.workspace_id
        WHERE project.id=$2 AND ((workspace.owner_type='personal' AND workspace.personal_owner_id=$1) OR
          (workspace.owner_type='organization' AND EXISTS (SELECT 1 FROM stash_organization_memberships membership
            WHERE membership.organization_id=workspace.organization_owner_id AND membership.account_id=$1)))`, [memberId, projectId]);
      if (!visible.rowCount) return undefined;
      if (followed) await client.query(`INSERT INTO stash_project_follows(member_id,project_id,followed_at)
        VALUES($1,$2,CURRENT_TIMESTAMP) ON CONFLICT(member_id,project_id) DO NOTHING`, [memberId, projectId]);
      else await client.query("DELETE FROM stash_project_follows WHERE member_id=$1 AND project_id=$2", [memberId, projectId]);
      return followed; });
  }

  async listProjectNotificationAudience(projectId: string, actorId: string) {
    return this.kernel.withSession(async (client) => { await this.prepareNotifications(client);
      const result = await client.query<{ member_id: string; followed: boolean }>(`SELECT account.id AS member_id,
        (follow.member_id IS NOT NULL) AS followed FROM stash_projects project
        JOIN stash_workspaces workspace ON workspace.id=project.workspace_id
        JOIN stash_accounts account ON (workspace.owner_type='personal' AND account.id=workspace.personal_owner_id) OR
          (workspace.owner_type='organization' AND EXISTS (SELECT 1 FROM stash_organization_memberships membership
            WHERE membership.organization_id=workspace.organization_owner_id AND membership.account_id=account.id))
        LEFT JOIN stash_project_follows follow ON follow.project_id=project.id AND follow.member_id=account.id
        WHERE project.id=$1 AND account.id<>$2 ORDER BY account.id`, [projectId, actorId]);
      return result.rows.map((row) => ({ memberId: row.member_id, followed: row.followed })); });
  }

  async claimDigestNotifications(memberId: string, cadence: "daily" | "weekly", since: string, until: string, claimedAt: string) {
    return this.kernel.withSession(async (client) => { await this.prepareNotifications(client);
      const result = await client.query<any>(`UPDATE stash_notifications notification SET digested_at=$5
        FROM stash_notification_preferences preference, stash_projects project, stash_workspaces workspace
        WHERE notification.member_id=$1 AND notification.read_at IS NULL AND notification.digested_at IS NULL
          AND notification.created_at >= $3 AND notification.created_at <= $4
          AND preference.member_id=$1 AND preference.project_id=notification.project_id AND preference.digest=$2
          AND project.id=notification.project_id AND workspace.id=project.workspace_id
          AND ((workspace.owner_type='personal' AND workspace.personal_owner_id=$1) OR
            (workspace.owner_type='organization' AND EXISTS (SELECT 1 FROM stash_organization_memberships membership
              WHERE membership.organization_id=workspace.organization_owner_id AND membership.account_id=$1)))
        RETURNING notification.*`, [memberId, cadence, since, until, claimedAt]);
      return result.rows.map(notificationFromRow); });
  }

  async prepareAutomations(client: PostgresQueryable): Promise<void> {
    await this.hooks.prepareAutomationDependencies(client);
    await client.query(`
      CREATE TABLE IF NOT EXISTS stash_automation_recipes (
        id UUID PRIMARY KEY, project_id UUID NOT NULL REFERENCES stash_projects(id) ON DELETE CASCADE,
        trigger TEXT NOT NULL CHECK(trigger IN ('branch_created','pull_request_completed')),
        target_status_id UUID REFERENCES stash_workflow_statuses(id), enabled BOOLEAN NOT NULL DEFAULT TRUE,
        created_by_account_id UUID NOT NULL REFERENCES stash_accounts(id), created_at TIMESTAMPTZ NOT NULL,
        workspace_target_status_id UUID REFERENCES stash_workspace_workflow_statuses(id), UNIQUE(project_id,trigger)
      );
      CREATE TABLE IF NOT EXISTS stash_automation_transitions (
        id UUID PRIMARY KEY, automation_id UUID NOT NULL REFERENCES stash_automation_recipes(id) ON DELETE CASCADE,
        signal_id UUID NOT NULL REFERENCES stash_github_signals(id) ON DELETE CASCADE,
        task_id UUID NOT NULL REFERENCES stash_tasks(id) ON DELETE CASCADE, project_id UUID NOT NULL REFERENCES stash_projects(id) ON DELETE CASCADE,
        before_status_id UUID REFERENCES stash_workflow_statuses(id), after_status_id UUID REFERENCES stash_workflow_statuses(id),
        workspace_before_status_id UUID REFERENCES stash_workspace_workflow_statuses(id), workspace_after_status_id UUID REFERENCES stash_workspace_workflow_statuses(id),
        occurred_at TIMESTAMPTZ NOT NULL, reversed_at TIMESTAMPTZ, reversed_by_account_id UUID REFERENCES stash_accounts(id),
        UNIQUE(automation_id,signal_id,task_id)
      );
      CREATE TABLE IF NOT EXISTS stash_automation_failures (
        id UUID PRIMARY KEY, automation_id UUID NOT NULL REFERENCES stash_automation_recipes(id) ON DELETE CASCADE,
        signal_id UUID NOT NULL REFERENCES stash_github_signals(id) ON DELETE CASCADE,
        task_id UUID NOT NULL REFERENCES stash_tasks(id) ON DELETE CASCADE, project_id UUID NOT NULL REFERENCES stash_projects(id) ON DELETE CASCADE,
        occurred_at TIMESTAMPTZ NOT NULL, activity JSONB NOT NULL, recipient_member_id UUID NOT NULL REFERENCES stash_accounts(id),
        summary TEXT NOT NULL, UNIQUE(automation_id,signal_id,task_id)
      );
      ALTER TABLE stash_automation_recipes ALTER COLUMN target_status_id DROP NOT NULL;
      ALTER TABLE stash_automation_recipes ADD COLUMN IF NOT EXISTS workspace_target_status_id UUID REFERENCES stash_workspace_workflow_statuses(id);
      ALTER TABLE stash_automation_transitions ALTER COLUMN before_status_id DROP NOT NULL;
      ALTER TABLE stash_automation_transitions ALTER COLUMN after_status_id DROP NOT NULL;
      ALTER TABLE stash_automation_transitions ADD COLUMN IF NOT EXISTS workspace_before_status_id UUID REFERENCES stash_workspace_workflow_statuses(id);
      ALTER TABLE stash_automation_transitions ADD COLUMN IF NOT EXISTS workspace_after_status_id UUID REFERENCES stash_workspace_workflow_statuses(id);
    `);
  }

  async listAutomationState(memberId: string, projectId: string, taskKey: string): Promise<AutomationState | undefined> {
    return this.kernel.transaction(async (client) => { await this.prepareAutomations(client);
      const task = (await client.query<any>(taskPlanningSelect, [projectId, taskKey, memberId])).rows[0]; if (!task) return undefined;
      const recipes = await client.query<any>(`SELECT recipe.*,COALESCE(workspace_status.id,legacy_status.id) target_status_id,
        COALESCE(workspace_status.name,legacy_status.name) AS target_status_name FROM stash_automation_recipes recipe
        LEFT JOIN stash_workflow_statuses legacy_status ON legacy_status.id=recipe.target_status_id
        LEFT JOIN stash_workspace_workflow_statuses workspace_status ON workspace_status.id=recipe.workspace_target_status_id
        WHERE recipe.project_id=$1 ORDER BY recipe.created_at,recipe.id`, [projectId]);
      const transitions = await client.query<any>(`SELECT transition.*,
        COALESCE(workspace_before.id,legacy_before.id) before_status_id,COALESCE(workspace_after.id,legacy_after.id) after_status_id,
        COALESCE(workspace_before.name,legacy_before.name) before_status_name,COALESCE(workspace_after.name,legacy_after.name) after_status_name
        FROM stash_automation_transitions transition LEFT JOIN stash_workflow_statuses legacy_before ON legacy_before.id=transition.before_status_id
        LEFT JOIN stash_workflow_statuses legacy_after ON legacy_after.id=transition.after_status_id
        LEFT JOIN stash_workspace_workflow_statuses workspace_before ON workspace_before.id=transition.workspace_before_status_id
        LEFT JOIN stash_workspace_workflow_statuses workspace_after ON workspace_after.id=transition.workspace_after_status_id
        WHERE transition.task_id=$1 ORDER BY transition.occurred_at DESC`, [task.id]);
      const statuses = task.workspace_workflow_status_id
        ? await client.query<{ id: string; name: string }>("SELECT id,name FROM stash_workspace_workflow_statuses WHERE workspace_id=$1 ORDER BY position", [task.workspace_id])
        : await client.query<{ id: string; name: string }>("SELECT id,name FROM stash_workflow_statuses WHERE project_id=$1 AND archived=FALSE ORDER BY position", [projectId]);
      return { recipes: recipes.rows.map(automationRecipeFromRow), transitions: transitions.rows.map(automationTransitionFromRow), availableStatuses: statuses.rows };
    });
  }

  async enableAutomation(memberId: string, projectId: string, trigger: AutomationTrigger, targetStatusId: string) {
    return this.kernel.transaction(async (client) => { await this.prepareAutomations(client);
      const access = await this.projectWorkflowAccess(client, memberId, projectId, true); if (access !== "member") return access;
      const status = await client.query<{ name: string; canonical: boolean }>(`SELECT status.name,FALSE canonical FROM stash_workflow_statuses status
        WHERE status.id=$1 AND status.project_id=$2 AND status.archived=FALSE UNION ALL SELECT status.name,TRUE canonical
        FROM stash_workspace_workflow_statuses status JOIN stash_projects project ON project.workspace_id=status.workspace_id
        WHERE status.id=$1 AND project.id=$2`, [targetStatusId, projectId]);
      if (!status.rowCount) return "invalid_status" as const;
      const canonical = status.rows[0]!.canonical;
      const result = await client.query<any>(`INSERT INTO stash_automation_recipes(id,project_id,trigger,target_status_id,workspace_target_status_id,created_by_account_id,created_at)
        VALUES($1,$2,$3,$4,$5,$6,now()) ON CONFLICT(project_id,trigger) DO UPDATE SET target_status_id=EXCLUDED.target_status_id,
        workspace_target_status_id=EXCLUDED.workspace_target_status_id,enabled=TRUE,created_by_account_id=EXCLUDED.created_by_account_id,
        created_at=EXCLUDED.created_at RETURNING *`, [randomUUID(), projectId, trigger, canonical ? null : targetStatusId, canonical ? targetStatusId : null, memberId]);
      return { status: "enabled" as const, recipe: automationRecipeFromRow({ ...result.rows[0], target_status_id: targetStatusId, target_status_name: status.rows[0]!.name }) };
    });
  }

  async reverseAutomation(memberId: string, projectId: string, taskKey: string, transitionId: string) {
    return this.kernel.transaction(async (client) => { await this.prepareAutomations(client);
      const access = await this.projectWorkflowAccess(client, memberId, projectId, true); if (access !== "member") return access;
      const row = (await client.query<any>(`SELECT transition.*,
        COALESCE(workspace_before.id,legacy_before.id) before_status_id,COALESCE(workspace_after.id,legacy_after.id) after_status_id,
        COALESCE(workspace_before.name,legacy_before.name) before_status_name,COALESCE(workspace_after.name,legacy_after.name) after_status_name,
        task.workflow_status_id,task.workspace_workflow_status_id,task.workspace_id FROM stash_automation_transitions transition
        JOIN stash_tasks task ON task.id=transition.task_id LEFT JOIN stash_workflow_statuses legacy_before ON legacy_before.id=transition.before_status_id
        LEFT JOIN stash_workflow_statuses legacy_after ON legacy_after.id=transition.after_status_id
        LEFT JOIN stash_workspace_workflow_statuses workspace_before ON workspace_before.id=transition.workspace_before_status_id
        LEFT JOIN stash_workspace_workflow_statuses workspace_after ON workspace_after.id=transition.workspace_after_status_id
        WHERE transition.id=$1 AND transition.project_id=$2 AND (task.task_key=$3 OR EXISTS(SELECT 1 FROM stash_task_projects association
          WHERE association.task_id=task.id AND association.project_id=$2 AND association.task_key=$3) OR EXISTS(SELECT 1 FROM stash_task_key_aliases alias
          WHERE alias.task_id=task.id AND alias.project_id=$2 AND alias.task_key=$3)) FOR UPDATE OF transition,task`, [transitionId, projectId, taskKey])).rows[0];
      if (!row) return "not_found" as const;
      if (row.reversed_at) return { status: "reversed" as const, transition: automationTransitionFromRow(row) };
      const canonical = row.workspace_after_status_id !== null;
      if ((row.workspace_workflow_status_id ?? row.workflow_status_id) !== row.after_status_id) return "conflict" as const;
      const before = (await client.query<any>(taskPlanningSelectById, [row.task_id, memberId])).rows[0];
      await client.query(`UPDATE stash_tasks SET workflow_status_id=CASE WHEN $3 THEN workflow_status_id ELSE $2 END,
        workspace_workflow_status_id=CASE WHEN $3 THEN $2 ELSE workspace_workflow_status_id END,revision=revision+1,
        field_revisions=jsonb_set(field_revisions,'{statusId}',to_jsonb(revision+1),true) WHERE id=$1`, [row.task_id, row.before_status_id, canonical]);
      const reversedAt = new Date().toISOString();
      await client.query("UPDATE stash_automation_transitions SET reversed_at=$2,reversed_by_account_id=$3 WHERE id=$1", [transitionId, reversedAt, memberId]);
      const saved = (await client.query<any>(taskPlanningSelectById, [row.task_id, memberId])).rows[0]; const after = readModel(saved);
      await this.hooks.recordProjection(client, projection(saved));
      await this.recordTaskActivity(client, memberId, row.workspace_id, row.task_id, "automation_status_transition_reversed", readModel(before), after,
        { kind: "member", automationId: row.automation_id, signalId: row.signal_id });
      return { status: "reversed" as const, transition: automationTransitionFromRow({ ...row, reversed_at: reversedAt }) };
    });
  }

  async applySignalAutomations(signal: { id: string; trigger?: AutomationTrigger }, candidates: ReadonlyArray<AutomationCandidate>) {
    if (!signal.trigger) return { failed: false, notifications: [] };
    const notifications: AutomationFailureNotification[] = []; let failed = false;
    for (const candidate of candidates.filter(({ status }) => status === "confirmed")) {
      const existing = await this.existingSignalAutomationFailureNotifications(signal.id, candidate);
      if (existing.found) { failed = true; notifications.push(...existing.notifications); continue; }
      let failedRun: FailedAutomationRun | undefined;
      try {
        await this.kernel.transaction(async (client) => { await this.prepareAutomations(client);
          const row = (await client.query<any>(`SELECT recipe.id AS automation_id,
            COALESCE(recipe.workspace_target_status_id,recipe.target_status_id) target_status_id,
            recipe.workspace_target_status_id IS NOT NULL canonical_status,recipe.created_by_account_id,
            configurer.name AS created_by_name,task.*,COALESCE(current_workspace.name,current_legacy.name) status_name,
            COALESCE(current_workspace.category,current_legacy.category) status_category FROM stash_automation_recipes recipe
            JOIN stash_tasks task ON task.id=$1 AND (task.project_id=recipe.project_id OR EXISTS(SELECT 1 FROM stash_task_projects association
              WHERE association.task_id=task.id AND association.project_id=recipe.project_id))
            LEFT JOIN stash_workflow_statuses current_legacy ON current_legacy.id=task.workflow_status_id
            LEFT JOIN stash_workspace_workflow_statuses current_workspace ON current_workspace.id=task.workspace_workflow_status_id
            JOIN stash_accounts configurer ON configurer.id=recipe.created_by_account_id
            WHERE recipe.project_id=$2 AND recipe.trigger=$3 AND recipe.enabled=TRUE FOR UPDATE OF task,recipe`,
          [candidate.taskId, candidate.projectId, signal.trigger])).rows[0];
          const currentStatusId = row?.workspace_workflow_status_id ?? row?.workflow_status_id;
          if (!row || currentStatusId === row.target_status_id) return;
          failedRun = { automationId: row.automation_id, configuringMemberId: row.created_by_account_id,
            configuringMemberName: row.created_by_name, workspaceId: row.workspace_id, projectId: candidate.projectId,
            taskId: row.id, taskKey: candidate.taskKey ?? candidate.matchedKey ?? row.task_key ?? "Task", taskTitle: row.title };
          const inserted = await client.query(`INSERT INTO stash_automation_transitions(id,automation_id,signal_id,task_id,project_id,
            before_status_id,after_status_id,workspace_before_status_id,workspace_after_status_id,occurred_at)
            VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,now()) ON CONFLICT(automation_id,signal_id,task_id) DO NOTHING RETURNING id`,
          [randomUUID(), row.automation_id, signal.id, row.id, candidate.projectId, row.canonical_status ? null : currentStatusId,
            row.canonical_status ? null : row.target_status_id, row.canonical_status ? currentStatusId : null, row.canonical_status ? row.target_status_id : null]);
          if (!inserted.rowCount) return;
          const before = readModel(row);
          await client.query(`UPDATE stash_tasks SET workflow_status_id=CASE WHEN $3 THEN workflow_status_id ELSE $2 END,
            workspace_workflow_status_id=CASE WHEN $3 THEN $2 ELSE workspace_workflow_status_id END,revision=revision+1,
            field_revisions=jsonb_set(field_revisions,'{statusId}',to_jsonb(revision+1),true) WHERE id=$1`, [row.id, row.target_status_id, row.canonical_status]);
          const saved = (await client.query<any>(taskPlanningSelectById, [row.id, row.created_by_account_id])).rows[0]; const after = readModel(saved);
          await this.hooks.recordProjection(client, projection(saved));
          await this.recordTaskActivity(client, row.created_by_account_id, row.workspace_id, row.id, "task_status_automated", before, after,
            { kind: "automation", automationId: row.automation_id, signalId: signal.id });
        });
      } catch (error) {
        if (!failedRun) throw error;
        failed = true; const notification = await this.recordSignalAutomationFailure(signal.id, failedRun); if (notification) notifications.push(notification);
      }
    }
    return { failed, notifications };
  }

  private async recordSignalAutomationFailure(signalId: string, run: FailedAutomationRun) {
    return this.kernel.transaction(async (client) => { await this.prepareAutomations(client);
      const activity: ActivityRecord = { schema: "stash.activity.v1", id: randomUUID(), workspaceId: run.workspaceId,
        object: { kind: "Task", id: run.taskId }, action: "automation_execution_failed",
        actor: { localAccountId: run.configuringMemberId, displayName: run.configuringMemberName },
        cause: { kind: "automation", automationId: run.automationId, signalId }, occurredAt: new Date().toISOString(),
        before: { status: "running" }, after: { status: "failed" } };
      const summary = `Automation failed for ${run.taskKey}: ${run.taskTitle}`;
      const failure = (await client.query<{ activity: ActivityRecord; recipient_member_id: string; summary: string; created: boolean }>(`WITH attempted AS (
        INSERT INTO stash_automation_failures(id,automation_id,signal_id,task_id,project_id,occurred_at,activity,recipient_member_id,summary)
        VALUES($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9) ON CONFLICT(automation_id,signal_id,task_id) DO NOTHING
        RETURNING activity,recipient_member_id,summary,TRUE AS created) SELECT * FROM attempted UNION ALL
        SELECT failure.activity,failure.recipient_member_id,failure.summary,FALSE AS created FROM stash_automation_failures failure
        WHERE failure.automation_id=$2 AND failure.signal_id=$3 AND failure.task_id=$4 AND NOT EXISTS(SELECT 1 FROM attempted)`,
      [activity.id, run.automationId, signalId, run.taskId, run.projectId, activity.occurredAt, JSON.stringify(activity), run.configuringMemberId, summary])).rows[0]!;
      if (failure.created) await this.persistTaskActivity(client, failure.activity);
      return await this.canReceiveProjectNotification(client, failure.recipient_member_id, run.projectId, failure.activity.workspaceId)
        ? { activity: failure.activity, projectId: run.projectId, memberId: failure.recipient_member_id, summary: failure.summary } : undefined;
    });
  }

  private async existingSignalAutomationFailureNotifications(signalId: string, candidate: AutomationCandidate) {
    return this.kernel.transaction(async (client) => { await this.prepareAutomations(client);
      const stored = await client.query<{ activity: ActivityRecord; recipient_member_id: string; summary: string }>(`SELECT activity,recipient_member_id,summary
        FROM stash_automation_failures WHERE signal_id=$1 AND task_id=$2 AND project_id=$3`, [signalId, candidate.taskId, candidate.projectId]);
      const notifications: AutomationFailureNotification[] = [];
      for (const failure of stored.rows) if (await this.canReceiveProjectNotification(client, failure.recipient_member_id, candidate.projectId, failure.activity.workspaceId))
        notifications.push({ activity: failure.activity, projectId: candidate.projectId, memberId: failure.recipient_member_id, summary: failure.summary });
      return { found: Boolean(stored.rowCount), notifications };
    });
  }

  private async projectWorkflowAccess(client: PostgresQueryable, memberId: string, projectId: string, lock: boolean) {
    const project = await client.query<{ workspace_id: string }>(`SELECT project.workspace_id FROM stash_projects project WHERE project.id=$1${lock ? " FOR UPDATE" : ""}`, [projectId]);
    if (!project.rowCount) return "not_found" as const;
    const writable = await client.query(`SELECT 1 FROM stash_workspaces workspace WHERE workspace.id=$1 AND
      ((workspace.owner_type='personal' AND workspace.personal_owner_id=$2) OR (workspace.owner_type='organization' AND EXISTS
      (SELECT 1 FROM stash_organization_memberships membership WHERE membership.organization_id=workspace.organization_owner_id AND membership.account_id=$2)))`,
    [project.rows[0]!.workspace_id, memberId]);
    return writable.rowCount ? "member" as const : "forbidden" as const;
  }

  private async canReceiveProjectNotification(client: PostgresQueryable, memberId: string, projectId: string, workspaceId: string) {
    const access = await client.query(`SELECT 1 FROM stash_projects project JOIN stash_workspaces workspace ON workspace.id=project.workspace_id
      WHERE project.id=$1 AND workspace.id=$2 AND ((workspace.owner_type='personal' AND workspace.personal_owner_id=$3) OR
        (workspace.owner_type='organization' AND EXISTS (SELECT 1 FROM stash_organization_memberships membership
          WHERE membership.organization_id=workspace.organization_owner_id AND membership.account_id=$3)))`, [projectId, workspaceId, memberId]);
    return Boolean(access.rowCount);
  }
}

function automationRecipeFromRow(row: any): AutomationRecipe {
  return { id: row.id, trigger: row.trigger, targetStatus: { id: row.target_status_id, name: row.target_status_name }, enabled: row.enabled };
}
function automationTransitionFromRow(row: any): AutomationTransition {
  return { id: row.id, automationId: row.automation_id, signalId: row.signal_id,
    before: { id: row.before_status_id, name: row.before_status_name }, after: { id: row.after_status_id, name: row.after_status_name },
    occurredAt: new Date(row.occurred_at).toISOString(), ...(row.reversed_at ? { reversedAt: new Date(row.reversed_at).toISOString() } : {}) };
}

function notificationFromRow(row: any): NotificationDelivery {
  return { schema: "stash.notification.v1", id: row.id, memberId: row.member_id, workspaceId: row.workspace_id,
    ...(row.project_id ? { projectId: row.project_id } : {}), trigger: row.trigger, summary: row.summary,
    activity: row.activity, delivery: row.delivery, createdAt: new Date(row.created_at).toISOString(),
    ...(row.read_at ? { readAt: new Date(row.read_at).toISOString() } : {}),
    ...(row.digested_at ? { digestedAt: new Date(row.digested_at).toISOString() } : {}) };
}

function noteProjection(row: any, id: string): PortableNoteProjection {
  return { schema: "stash.note.v1", id, workspaceId: row.workspace_id, content: row.content, tags: row.tags,
    createdAt: new Date(row.created_at).toISOString(), createdBy: { localAccountId: row.created_by_account_id, displayName: row.created_by_name },
    ...(row.project_id ? { projectId: row.project_id } : {}),
    ...(row.reminder_at ? { reminder: { at: new Date(row.reminder_at).toISOString() } } : {}) };
}
