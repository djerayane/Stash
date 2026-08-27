import type { ActivityCause, ActivityRecord, NoteHistoryRevision } from "../activity.js";
import { noteOperationDigest, type NoteConflictResolution, type NoteEditBatch, type NoteEditConflict } from "../notes.js";
import { createHash, randomUUID } from "node:crypto";
import type { NoteRecord, NoteRepository, PortableExportTaskProjection, PortableNoteLinkProjection, PortableNoteStateProjection, NoteTriageChange, NoteTriageResult, PortableNoteProjection, PortableTaskProjection, TaskCreation } from "../notes.js";
import { markdownToRichText, paragraphDocument, richTextToMarkdown } from "../rich-text.js";
import { initialWorkflowStatus, type ProjectWorkflow, type WorkflowStatus } from "../project-workflows.js";
import type { CreateDiscussionWorkDraft, DiscussionDraft, DiscussionMessage, DiscussionRecord, DiscussionTarget, DiscussionWorkActivity, DiscussionWorkOutcome, PortableDiscussionProjection, PortableDiscussionTarget, PortableDiscussionWorkLinkProjection } from "../discussions.js";
import type { PortableIdentity, PortableWorkspaceProjection } from "../workspaces-projects.js";
import type { Board } from "../boards.js";
import type { ImportTransformation, PortableWorkspaceImportBundle, PortableWorkspaceImportReport } from "../portable-workspace-import.js";
import type { PortableWorkspaceExportSnapshot } from "../portable-workspace-export.js";
import { effectiveNoteReadSql } from "./postgres-note-access.js";
import type { AttachmentRecord, PortableAttachmentProjection } from "../attachments.js";
import type { NoteLinkRecord, NoteLocationRecord, PortableNoteLinkStateProjection, PortableNoteLocationProjection } from "../note-links.js";
import * as Y from "yjs";
import { InvalidCollaborationUpdate, type CollaborationSnapshot } from "../note-collaboration.js";
import { collaborativeDocumentFromRichText, validatedRichTextFromCollaborativeDocument } from "./collaborative-document.js";
import type { WorkspaceSearchFacet, WorkspaceSearchKind, WorkspaceSearchQuery, WorkspaceSearchResult } from "../workspace-search.js";
import type { PostgresKernel, PostgresQueryable } from "../instance-operations/storage/postgres-kernel.js";
import { directMentionMemberIds, directMentionNotificationInputs, notificationDeliveryMode,
  type NotificationPreferences } from "../notifications.js";
import type { PostgresWorkPlanningRepositories } from "../work-planning/postgres-work-planning-repositories.js";
import { workspaceMemberSql } from "./postgres-note-access.js";

interface PostgresKnowledgeAuthoringHooks {
  prepare(client: PostgresQueryable): Promise<void>;
  prepareInvitations(client: PostgresQueryable): Promise<void>;
  prepareAttachments(client: PostgresQueryable): Promise<void>;
  backfillLegacyNoteHistory(client: PostgresQueryable): Promise<void>;
  parseActivityCause(value: string): ActivityCause;
  prepareBootstrap(client: PostgresQueryable): Promise<void>;
  prepareImports(client: PostgresQueryable): Promise<void>;
  prepareInstanceSetup(client: PostgresQueryable): Promise<void>;
  prepareBoards(client: PostgresQueryable): Promise<void>;
  encryptSecret(value: string): string;
  applyImportedLocations(client: PostgresQueryable, locations: any): Promise<void>;
  applyImportedRelationships(client: PostgresQueryable, links: any): Promise<void>;
  importContributedPortableObjects(client: PostgresQueryable, objects: any, workspaceId: string): Promise<void>;
  prepareContributedPortableObjects(client: PostgresQueryable): Promise<void>;
  readContributedPortableObjects(client: PostgresQueryable, context: any): Promise<any[]>;
  prepareHistory(client: PostgresQueryable): Promise<void>;
  prepareWorkspaceProjects(client: PostgresQueryable): Promise<void>;
  recordProjection(client: PostgresQueryable, kind: any, id: string, schema: any, projection: any): Promise<void>;
  recordInitialNoteLocation(client: PostgresQueryable, noteId: string, workspaceId: string): Promise<void>;
  recordAgentAudit(
    client: PostgresQueryable,
    memberId: string,
    note: NoteRecord,
    cause: Extract<ActivityCause, { kind: "agent" }>,
  ): Promise<void>;
}

type CreateNoteResult = Awaited<ReturnType<NoteRepository["createNote"]>>;

function noteFromRow(row: any): NoteRecord {
  return { id: row.id, workspaceId: row.workspace_id, content: row.content, document: row.document,
    revision: Number(row.revision), tags: row.tags ?? [], createdByMemberId: row.created_by_account_id,
    createdAt: new Date(row.created_at).toISOString(), ...(row.project_id ? { projectId: row.project_id } : {}),
    ...(row.reminder_at ? { reminder: { at: new Date(row.reminder_at).toISOString() } } : {}),
    ...(row.archived_at ? { archivedAt: new Date(row.archived_at).toISOString() } : {}) };
}

function triageObjectKind(result: NoteTriageResult): "Task" | "NoteLink" | "Note" {
  if (result.kind === "task_created") return "Task";
  if (result.kind === "linked") return "NoteLink";
  return "Note";
}

function triageObjectId(result: NoteTriageResult, noteId: string): string {
  if (result.kind === "task_created") return result.task.id;
  if (result.kind === "linked") return result.link.id;
  return noteId;
}
function portableExportNoteProjection(payload: PortableNoteProjection | PortableNoteStateProjection): PortableNoteProjection {
  if (payload.schema === "stash.note.v1") return payload;
  const { id, workspaceId, content, tags, createdAt, projectId, reminder } = payload.note;
  return { schema: "stash.note.v1", id, workspaceId, content, tags, createdAt, createdBy: payload.createdBy,
    ...(projectId ? { projectId } : {}), ...(reminder ? { reminder } : {}) };
}


/** PostgreSQL implementation of the Knowledge Authoring persistence seam. */
export class PostgresKnowledgeAuthoringRepositories {
  constructor(private readonly kernel: PostgresKernel, private readonly hooks: PostgresKnowledgeAuthoringHooks,
    private readonly activityNotifications: Pick<PostgresWorkPlanningRepositories,
      "prepareNotifications" | "recordProjectActivityNotifications">) {}

  async authorizeNote(client: PostgresQueryable, memberId: string, noteId: string): Promise<"edit" | "read" | "none"> {
    const result = await client.query<{ can_edit: boolean; can_read: boolean }>(`SELECT
      ${workspaceMemberSql("workspace", "$2")} AS can_edit,
      ${effectiveNoteReadSql("note", "workspace", "$2")} AS can_read
      FROM stash_notes note JOIN stash_workspaces workspace ON workspace.id=note.workspace_id WHERE note.id=$1`, [noteId, memberId]);
    return result.rows[0]?.can_edit ? "edit" : result.rows[0]?.can_read ? "read" : "none";
  }

  async recordNoteRevisionAndActivity(client: PostgresQueryable, memberId: string, before: NoteRecord | undefined,
    note: NoteRecord, action: string, cause: ActivityCause): Promise<ActivityRecord> {
    await this.hooks.prepareHistory(client);
    if (before) await client.query(`INSERT INTO stash_note_history
      (note_id,workspace_id,revision,content,document,actor_account_id,cause,recorded_at)
      VALUES ($1,$2,$3,$4,$5::jsonb,$6,$7,$8) ON CONFLICT (note_id,revision) DO NOTHING`, [before.id,
      before.workspaceId,before.revision,before.content,JSON.stringify(before.document),before.createdByMemberId,
      JSON.stringify({ kind: "migration", source: "existing_note" }),before.createdAt]);
    const actor = await client.query<{ name: string }>("SELECT name FROM stash_accounts WHERE id=$1", [memberId]);
    if (!actor.rows[0]) throw new Error("member_identity_unavailable");
    const occurredAt = new Date().toISOString();
    const activity: ActivityRecord = { schema: "stash.activity.v1", id: randomUUID(), workspaceId: note.workspaceId,
      object: { kind: "Note", id: note.id }, action,
      actor: { localAccountId: memberId, displayName: actor.rows[0].name }, cause, occurredAt,
      before: before ? { revision: before.revision, content: before.content } : {},
      after: { revision: note.revision, content: note.content } };
    await client.query(`INSERT INTO stash_note_history
      (note_id,workspace_id,revision,content,document,actor_account_id,cause,recorded_at)
      VALUES ($1,$2,$3,$4,$5::jsonb,$6,$7,$8) ON CONFLICT (note_id,revision) DO NOTHING`,
      [note.id, note.workspaceId, note.revision, note.content, JSON.stringify(note.document), memberId, JSON.stringify(cause), occurredAt]);
    await client.query(`INSERT INTO stash_workspace_activity
      (id,workspace_id,object_kind,object_id,action,actor_account_id,cause,occurred_at,before_state,after_state)
      VALUES ($1,$2,'Note',$3,$4,$5,$6,$7,$8::jsonb,$9::jsonb)`, [activity.id, note.workspaceId, note.id, action,
      memberId, JSON.stringify(cause), occurredAt, JSON.stringify(activity.before), JSON.stringify(activity.after)]);
    await this.hooks.recordProjection(client, "Activity", activity.id, activity.schema, activity);
    if (JSON.stringify(activity.before) !== JSON.stringify(activity.after))
      await this.activityNotifications.recordProjectActivityNotifications(client, activity);
    return activity;
  }

  async recordDomainActivity(client: PostgresQueryable, memberId: string, workspaceId: string,
    kind: ActivityRecord["object"]["kind"], objectId: string, action: string, before: object, after: object): Promise<void> {
    const actor=await client.query<{name:string}>("SELECT name FROM stash_accounts WHERE id=$1",[memberId]);
    if(!actor.rows[0]) throw new Error("member_identity_unavailable");
    const activity:ActivityRecord={schema:"stash.activity.v1",id:randomUUID(),workspaceId,object:{kind,id:objectId},action,
      actor:{localAccountId:memberId,displayName:actor.rows[0].name},cause:{kind:"member"},occurredAt:new Date().toISOString(),
      before:{...before},after:{...after}};
    await client.query(`INSERT INTO stash_workspace_activity
      (id,workspace_id,object_kind,object_id,action,actor_account_id,cause,occurred_at,before_state,after_state)
      VALUES($1,$2,$3,$4,$5,$6,'member',$7,$8::jsonb,$9::jsonb)`,[activity.id,workspaceId,kind,objectId,action,memberId,
      activity.occurredAt,JSON.stringify(activity.before),JSON.stringify(activity.after)]);
    await this.hooks.recordProjection(client,"Activity",activity.id,activity.schema,activity);
    if (JSON.stringify(activity.before) !== JSON.stringify(activity.after))
      await this.activityNotifications.recordProjectActivityNotifications(client, activity);
  }

  async recordDiscussionMentionNotifications(client: PostgresQueryable, memberId: string, discussion: DiscussionRecord,
    message: DiscussionMessage): Promise<void> {
    const requestedMemberIds = directMentionMemberIds(message.content).filter((id) => id !== memberId);
    if (!requestedMemberIds.length) return;
    const scope = await client.query<{ project_id: string | null }>(`SELECT COALESCE(task.project_id,note.project_id) AS project_id
      FROM stash_discussions discussion LEFT JOIN stash_tasks task ON task.id=discussion.task_id
      LEFT JOIN stash_notes note ON note.id=discussion.note_id WHERE discussion.id=$1`, [discussion.id]);
    if (!scope.rows[0]) return;
    const projectId = scope.rows[0].project_id;
    const recipients = await client.query<{ id: string }>(`SELECT account.id FROM stash_accounts account
      JOIN stash_workspaces workspace ON workspace.id=$2
      WHERE account.id=ANY($1::uuid[]) AND account.id<>$3 AND (
        (workspace.owner_type='personal' AND workspace.personal_owner_id=account.id) OR
        (workspace.owner_type='organization' AND EXISTS (SELECT 1 FROM stash_organization_memberships membership
          WHERE membership.organization_id=workspace.organization_owner_id AND membership.account_id=account.id)))
      AND ($4::uuid IS NULL OR EXISTS (SELECT 1 FROM stash_projects project WHERE project.id=$4 AND project.workspace_id=workspace.id))
      ORDER BY account.id`, [requestedMemberIds, discussion.workspaceId, memberId, projectId]);
    if (!recipients.rowCount) return;
    const activity: ActivityRecord = { schema: "stash.activity.v1", id: message.id, workspaceId: discussion.workspaceId,
      object: { kind: "Discussion", id: discussion.id }, action: "discussion_message_mentioned_members", actor: message.author,
      cause: { kind: "member" }, occurredAt: message.createdAt, before: {},
      after: { messageId: message.id, mentionedMemberIds: recipients.rows.map(({ id }) => id) } };
    await client.query(`INSERT INTO stash_workspace_activity
      (id,workspace_id,object_kind,object_id,action,actor_account_id,cause,occurred_at,before_state,after_state)
      VALUES($1,$2,'Discussion',$3,$4,$5,'member',$6,$7::jsonb,$8::jsonb) ON CONFLICT (id) DO NOTHING`,
      [activity.id, activity.workspaceId, discussion.id, activity.action, memberId, activity.occurredAt,
        JSON.stringify(activity.before), JSON.stringify(activity.after)]);
    await this.hooks.recordProjection(client, "Activity", activity.id, activity.schema, activity);
    if (projectId) await this.activityNotifications.recordProjectActivityNotifications(client, activity);
    await this.activityNotifications.prepareNotifications(client);
    const inputs = projectId ? directMentionNotificationInputs(activity, projectId, recipients.rows.map(({ id }) => id))
      : recipients.rows.map(({ id }) => ({ memberId: id, trigger: "direct_mention" as const,
        summary: `${activity.actor.displayName} mentioned you in a Discussion`, activity }));
    for (const input of inputs) {
      if (projectId) await client.query("DELETE FROM stash_notifications WHERE member_id=$1 AND activity_id=$2 AND trigger='followed_change'",
        [input.memberId, activity.id]);
      const settings = projectId ? await client.query<any>(`SELECT preference.* FROM stash_notification_preferences preference
        WHERE preference.project_id=$2 AND preference.member_id=$1`, [input.memberId, projectId]) : { rows: [] };
      const row = settings.rows[0];
      const preferences: NotificationPreferences = row ? { activity: row.activity, digest: row.digest,
        ...(row.quiet_start ? { quietHours: { start: row.quiet_start, end: row.quiet_end, timeZone: row.quiet_time_zone } } : {}) }
        : { activity: "followed", digest: "off" };
      await client.query(`INSERT INTO stash_notifications
        (id,member_id,workspace_id,project_id,trigger,summary,activity,created_at,delivery)
        VALUES($1,$2,$3,$4,'direct_mention',$5,$6::jsonb,$7,$8)
        ON CONFLICT (member_id,activity_id,trigger) DO NOTHING`, [randomUUID(), input.memberId, activity.workspaceId,
        projectId, input.summary, JSON.stringify(activity), activity.occurredAt,
        notificationDeliveryMode(new Date(activity.occurredAt), preferences)]);
    }
  }

  private async recordCreatedNote(client: PostgresQueryable, memberId: string, note: NoteRecord,
    projection: PortableNoteProjection, cause: ActivityCause): Promise<void> {
    await this.hooks.recordInitialNoteLocation(client, note.id, note.workspaceId);
    await this.hooks.recordProjection(client, "Note", note.id, "stash.note.v1", projection);
    await this.recordNoteRevisionAndActivity(client, memberId, undefined, note, "note_created", cause);
  }

  async triageNote(memberId: string, workspaceId: string, noteId: string, change: NoteTriageChange) {
    return this.kernel.transaction(async (client) => {
      await this.hooks.prepare(client);
      const source = await client.query(`SELECT 1 FROM stash_notes note JOIN stash_workspaces workspace ON workspace.id = note.workspace_id
        WHERE note.id = $1 AND note.workspace_id = $2 AND note.project_id IS NULL AND note.archived_at IS NULL
        AND ((workspace.owner_type = 'personal' AND workspace.personal_owner_id = $3)
        OR (workspace.owner_type = 'organization' AND EXISTS (SELECT 1 FROM stash_organization_memberships membership
          WHERE membership.organization_id = workspace.organization_owner_id AND membership.account_id = $3))) FOR UPDATE`, [noteId, workspaceId, memberId]);
      if (!source.rowCount) return { status: "note_not_found" as const };
      const applied = await this.applyTriageChange(client, memberId, workspaceId, noteId, change);
      if ("status" in applied) return applied;
      for (const projection of applied.result.projections) await this.hooks.recordProjection(client,
        triageObjectKind(applied.result), triageObjectId(applied.result, noteId), projection.schema, projection);
      return { status: "updated" as const, result: applied.result };
    });
  }

  private async applyTriageChange(client: PostgresQueryable, memberId: string, workspaceId: string, noteId: string,
    change: NoteTriageChange): Promise<{ result: NoteTriageResult } | { status: "project_forbidden" | "target_note_not_found" }> {
    switch (change.kind) {
      case "organized": return this.organizeInboxNote(client, memberId, workspaceId, noteId, change);
      case "archived": return this.archiveInboxNote(client, memberId, workspaceId, noteId, change);
      case "linked": return this.linkInboxNote(client, memberId, workspaceId, noteId, change);
      case "task_created": return this.createTaskFromInbox(client, memberId, workspaceId, noteId, change);
    }
  }

  private async organizeInboxNote(client: PostgresQueryable, memberId: string, workspaceId: string, noteId: string,
    change: Extract<NoteTriageChange, { kind: "organized" }>) {
    if (!(await client.query("SELECT 1 FROM stash_projects WHERE id=$1 AND workspace_id=$2", [change.note.projectId, workspaceId])).rowCount)
      return { status: "project_forbidden" as const };
    const before = await client.query<any>("SELECT project_id,tags FROM stash_notes WHERE id=$1", [noteId]);
    await client.query("UPDATE stash_notes SET project_id=$2,tags=$3::jsonb WHERE id=$1", [noteId, change.note.projectId, JSON.stringify(change.note.tags)]);
    await this.recordDomainActivity(client, memberId, workspaceId, "Note", noteId, "note_organized",
      { projectId: before.rows[0]?.project_id ?? null, tags: before.rows[0]?.tags ?? [] }, { projectId: change.note.projectId, tags: change.note.tags });
    return { result: change };
  }

  private async archiveInboxNote(client: PostgresQueryable, memberId: string, workspaceId: string, noteId: string,
    change: Extract<NoteTriageChange, { kind: "archived" }>) {
    await client.query("UPDATE stash_notes SET archived_at=$2 WHERE id=$1", [noteId, change.note.archivedAt]);
    await this.recordDomainActivity(client, memberId, workspaceId, "Note", noteId, "note_archived", { archivedAt: null }, { archivedAt: change.note.archivedAt });
    return { result: change };
  }

  private async linkInboxNote(client: PostgresQueryable, memberId: string, workspaceId: string, noteId: string,
    change: Extract<NoteTriageChange, { kind: "linked" }>) {
    if (!(await client.query("SELECT 1 FROM stash_notes WHERE id=$1 AND workspace_id=$2", [change.link.targetNoteId, workspaceId])).rowCount)
      return { status: "target_note_not_found" as const };
    await client.query("INSERT INTO stash_note_links (id,workspace_id,source_note_id,target_note_id) VALUES ($1,$2,$3,$4)",
      [change.link.id, workspaceId, noteId, change.link.targetNoteId]);
    await this.recordDomainActivity(client, memberId, workspaceId, "NoteLink", change.link.id, "note_link_created", {}, change.link);
    return { result: change };
  }

  private async createTaskFromInbox(client: PostgresQueryable, memberId: string, workspaceId: string, noteId: string,
    change: Extract<NoteTriageChange, { kind: "task_created" }>) {
    if (!(await client.query("SELECT 1 FROM stash_projects WHERE id=$1 AND workspace_id=$2", [change.task.projectId, workspaceId])).rowCount)
      return { status: "project_forbidden" as const };
    const task = await this.createTask(client, change.task);
    await client.query("INSERT INTO stash_tasks (id,workspace_id,project_id,task_key,workflow_status_id,title,created_by_account_id,created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)",
      [task.id, workspaceId, task.projectId, task.key, task.status.id, task.title, memberId, task.createdAt]);
    await client.query("INSERT INTO stash_task_note_sources (task_id,note_id) VALUES ($1,$2)", [change.task.id, noteId]);
    await this.recordDomainActivity(client, memberId, workspaceId, "Task", task.id, "task_created_from_inbox", {}, task);
    return { result: { kind: "task_created" as const, task, projections: [task] as [PortableTaskProjection] } };
  }

  private async createTask(client: PostgresQueryable, draft: TaskCreation): Promise<PortableTaskProjection> {
    await client.query("SELECT id FROM stash_projects WHERE id=$1 FOR UPDATE", [draft.projectId]);
    await this.ensureDefaultWorkflow(client, draft.projectId);
    const status = initialWorkflowStatus(await this.loadWorkflow(client, draft.projectId));
    const allocation = await client.query<{ project_key: string; task_number: number }>(
      "UPDATE stash_projects SET next_task_number=next_task_number+1 WHERE id=$1 RETURNING project_key,next_task_number-1 AS task_number", [draft.projectId]);
    const key = allocation.rows[0]; if (!key) throw new Error("task_project_unavailable");
    return { schema: "stash.task.v1", ...draft, key: `${key.project_key}-${key.task_number}`, status };
  }

  private async ensureDefaultWorkflow(client: PostgresQueryable, projectId: string): Promise<void> {
    const statuses = [[randomUUID(), projectId, "Backlog", "unstarted", 0], [randomUUID(), projectId, "Ready", "unstarted", 1],
      [randomUUID(), projectId, "In Progress", "started", 2], [randomUUID(), projectId, "In Review", "started", 3],
      [randomUUID(), projectId, "Done", "completed", 4]] as const;
    await client.query(`INSERT INTO stash_workflow_statuses (id,project_id,name,category,position) VALUES
      ${statuses.map((_, index) => `($${index * 5 + 1},$${index * 5 + 2},$${index * 5 + 3},$${index * 5 + 4},$${index * 5 + 5})`).join(",")}
      ON CONFLICT DO NOTHING`, statuses.flat());
    if ((await client.query("UPDATE stash_projects SET workflow_revision=1 WHERE id=$1 AND workflow_revision=0 RETURNING id", [projectId])).rowCount) {
      const workflow = await this.loadWorkflow(client, projectId);
      await this.hooks.recordProjection(client, "Workflow", projectId, workflow.schema, workflow);
    }
  }

  private async loadWorkflow(client: PostgresQueryable, projectId: string): Promise<ProjectWorkflow> {
    const project = await client.query<{ workflow_revision: number }>("SELECT workflow_revision FROM stash_projects WHERE id=$1", [projectId]);
    const statuses = await client.query<{ id:string; name:string; category:WorkflowStatus["category"]; position:number; archived:boolean }>(
      "SELECT id,name,category,position,archived FROM stash_workflow_statuses WHERE project_id=$1 ORDER BY position,id", [projectId]);
    return { schema: "stash.workflow.v1", projectId, revision: project.rows[0]!.workflow_revision, statuses: statuses.rows };
  }

  async createNote(
    memberId: string,
    note: NoteRecord,
    projection: PortableNoteProjection,
    cause: ActivityCause = { kind: "member" },
    operation?: { id: string; digest: string },
  ): Promise<CreateNoteResult> {
    return this.kernel.transaction(async (client) => {
      await this.hooks.prepare(client);
      if (operation) await client.query("SELECT pg_advisory_xact_lock(hashtext($1), hashtext($2))", [memberId, operation.id]);
      const access = await client.query<{ allowed: boolean }>(
        `SELECT (
           (owner_type = 'personal' AND personal_owner_id = $2)
           OR (owner_type = 'organization' AND EXISTS (
             SELECT 1 FROM stash_organization_memberships membership
             WHERE membership.organization_id = stash_workspaces.organization_owner_id
               AND membership.account_id = $2
           ))
         ) AS allowed
         FROM stash_workspaces WHERE id = $1`,
        [note.workspaceId, memberId],
      );
      if (!access.rows[0]?.allowed) return "workspace_forbidden";
      if (operation) {
        const receipt = await client.query<any>(`SELECT receipt.payload_digest,note.* FROM stash_note_capture_operation_receipts receipt
          JOIN stash_notes note ON note.id=receipt.note_id WHERE receipt.account_id=$1 AND receipt.operation_id=$2 AND receipt.workspace_id=$3`,
        [memberId, operation.id, note.workspaceId]);
        if (receipt.rows[0]) {
          if (receipt.rows[0].payload_digest !== operation.digest) throw new Error("note_capture_operation_conflict");
          return { status: "duplicate", note: noteFromRow(receipt.rows[0]) };
        }
      }
      if (note.projectId) {
        const project = await client.query("SELECT 1 FROM stash_projects WHERE id = $1 AND workspace_id = $2", [note.projectId, note.workspaceId]);
        if (!project.rowCount) return "project_forbidden";
      }
      await client.query(
        `INSERT INTO stash_notes
          (id, workspace_id, project_id, content, document, revision, tags, reminder_at, created_by_account_id, created_at)
         VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7::jsonb, $8, $9, $10)`,
        [note.id, note.workspaceId, note.projectId ?? null, note.content, JSON.stringify(note.document), note.revision,
          JSON.stringify(note.tags), note.reminder?.at ?? null, note.createdByMemberId, note.createdAt],
      );
      await this.recordCreatedNote(client, memberId, note, projection, cause);
      if (cause.kind === "agent") await this.hooks.recordAgentAudit(client, memberId, note, cause);
      if (operation) await client.query(`INSERT INTO stash_note_capture_operation_receipts
        (account_id,operation_id,workspace_id,payload_digest,note_id) VALUES ($1,$2,$3,$4,$5)`,
      [memberId, operation.id, note.workspaceId, operation.digest, note.id]);
      return "created";
    });
  }

  async createMobileCapture(memberId: string, clientCaptureId: string, payloadDigest: string, note: NoteRecord,
    projection: PortableNoteProjection): Promise<{ status: "created" | "duplicate"; noteId: string }
      | { status: "workspace_forbidden" | "project_forbidden" | "conflict" }> {
    return this.kernel.transaction(async (client) => {
      await this.hooks.prepare(client);
      await client.query("SELECT pg_advisory_xact_lock(hashtext($1), hashtext($2))", [memberId, clientCaptureId]);
      const receipt = await client.query<{ note_id: string; payload_digest: string | null }>(
        "SELECT note_id, payload_digest FROM stash_mobile_capture_receipts WHERE account_id = $1 AND client_capture_id = $2",
        [memberId, clientCaptureId]);
      if (receipt.rows[0]) return receipt.rows[0].payload_digest === payloadDigest
        ? { status: "duplicate", noteId: receipt.rows[0].note_id } : { status: "conflict" };
      const access = await client.query<{ allowed: boolean }>(`SELECT ((owner_type = 'personal' AND personal_owner_id = $2) OR
        (owner_type = 'organization' AND EXISTS (SELECT 1 FROM stash_organization_memberships membership
          WHERE membership.organization_id = stash_workspaces.organization_owner_id AND membership.account_id = $2))) AS allowed
        FROM stash_workspaces WHERE id = $1`, [note.workspaceId, memberId]);
      if (!access.rows[0]?.allowed) return { status: "workspace_forbidden" };
      if (note.projectId && !(await client.query("SELECT 1 FROM stash_projects WHERE id = $1 AND workspace_id = $2",
        [note.projectId, note.workspaceId])).rowCount) return { status: "project_forbidden" };
      await client.query(`INSERT INTO stash_notes
        (id, workspace_id, project_id, content, document, revision, tags, reminder_at, created_by_account_id, created_at)
        VALUES ($1,$2,$3,$4,$5::jsonb,$6,$7::jsonb,$8,$9,$10)`, [note.id, note.workspaceId, note.projectId ?? null,
        note.content, JSON.stringify(note.document), note.revision, JSON.stringify(note.tags), note.reminder?.at ?? null, memberId, note.createdAt]);
      await this.recordCreatedNote(client, memberId, note, projection, { kind: "member" });
      await client.query("INSERT INTO stash_mobile_capture_receipts (account_id, client_capture_id, note_id, payload_digest) VALUES ($1,$2,$3,$4)",
        [memberId, clientCaptureId, note.id, payloadDigest]);
      return { status: "created", noteId: note.id };
    });
  }

  async listMobileCaptureOptions(memberId: string, workspaceId: string) {
    return this.kernel.withSession(async (client) => {
      await this.hooks.prepare(client); await this.hooks.prepareInvitations(client);
      if (!(await client.query(`SELECT 1 FROM stash_workspaces workspace WHERE workspace.id=$1 AND
        ((workspace.owner_type='personal' AND workspace.personal_owner_id=$2) OR (workspace.owner_type='organization' AND EXISTS
        (SELECT 1 FROM stash_organization_memberships membership WHERE membership.organization_id=workspace.organization_owner_id AND membership.account_id=$2)))`,
      [workspaceId, memberId])).rowCount) return { status: "workspace_forbidden" as const };
      const [projects, tags] = await Promise.all([
        client.query<{ id: string; name: string }>("SELECT id,name FROM stash_projects WHERE workspace_id=$1 ORDER BY name,id", [workspaceId]),
        client.query<{ tag: string }>("SELECT DISTINCT jsonb_array_elements_text(tags) AS tag FROM stash_notes WHERE workspace_id=$1 ORDER BY tag", [workspaceId]),
      ]);
      return { status: "found" as const, projects: projects.rows, tags: tags.rows.map(({ tag }) => tag) };
    });
  }

  private async listVisibleNotes(memberId: string, workspaceId: string, tag?: string, inbox = false) {
    return this.kernel.withSession(async (client) => {
      await this.hooks.prepare(client);
      const workspace = await client.query(`SELECT 1 FROM stash_workspaces workspace WHERE workspace.id=$1 AND
        ((workspace.owner_type='personal' AND workspace.personal_owner_id=$2) OR
        (workspace.owner_type='organization' AND EXISTS (SELECT 1 FROM stash_organization_memberships membership
          WHERE membership.organization_id=workspace.organization_owner_id AND membership.account_id=$2)) OR
        EXISTS (SELECT 1 FROM stash_projects project JOIN stash_project_guests guest ON guest.project_id=project.id
          WHERE project.workspace_id=workspace.id AND guest.account_id=$2))`, [workspaceId, memberId]);
      if (!workspace.rowCount) return { status: "workspace_forbidden" as const };
      const result = await client.query<any>(`SELECT note.* FROM stash_notes note JOIN stash_workspaces workspace ON workspace.id=note.workspace_id
        WHERE note.workspace_id=$1 AND note.archived_at IS NULL
        ${inbox ? "AND note.project_id IS NULL" : "AND ((workspace.owner_type='personal' AND workspace.personal_owner_id=$2) OR (workspace.owner_type='organization' AND EXISTS (SELECT 1 FROM stash_organization_memberships membership WHERE membership.organization_id=workspace.organization_owner_id AND membership.account_id=$2)) OR (note.project_id IS NOT NULL AND EXISTS (SELECT 1 FROM stash_project_guests guest WHERE guest.project_id=note.project_id AND guest.account_id=$2)))"}
        ${tag === undefined ? "" : "AND note.tags @> $3::jsonb"} ORDER BY note.created_at,note.id`,
      inbox ? [workspaceId] : tag === undefined ? [workspaceId, memberId] : [workspaceId, memberId, JSON.stringify([tag])]);
      return { status: "found" as const, notes: result.rows.map(noteFromRow) };
    });
  }

  listInboxNotes(memberId: string, workspaceId: string) { return this.listVisibleNotes(memberId, workspaceId, undefined, true); }
  listNotes(memberId: string, workspaceId: string) { return this.listVisibleNotes(memberId, workspaceId); }
  listNotesByTag(memberId: string, workspaceId: string, tag: string) { return this.listVisibleNotes(memberId, workspaceId, tag); }

  async findAttachmentReceipt(memberId: string, workspaceId: string, operationKey: string) {
    return this.kernel.withSession(async (client) => {
      await this.hooks.prepareAttachments(client);
      const result = await client.query<any>(`SELECT receipt.payload_digest,receipt.projection,attachment.*
        FROM stash_attachment_operation_receipts receipt JOIN stash_attachments attachment ON attachment.id=receipt.attachment_id
        JOIN stash_workspaces workspace ON workspace.id=receipt.workspace_id WHERE receipt.operation_key=$1 AND receipt.workspace_id=$2
        AND receipt.created_by_account_id=$3 AND ((workspace.owner_type='personal' AND workspace.personal_owner_id=$3) OR EXISTS
        (SELECT 1 FROM stash_organization_memberships membership WHERE membership.organization_id=workspace.organization_owner_id AND membership.account_id=$3))`,
      [operationKey, workspaceId, memberId]);
      const row = result.rows[0]; return row ? { digest: row.payload_digest, record: attachmentRecord(row), projection: row.projection } : undefined;
    });
  }

  async createAttachment(memberId: string, record: AttachmentRecord, projection: PortableAttachmentProjection,
    operation?: { key: string; digest: string }) {
    return this.kernel.transaction(async (client) => {
      await this.hooks.prepareAttachments(client);
      if (!(await client.query(`SELECT 1 FROM stash_workspaces workspace WHERE workspace.id=$1 AND
        ((workspace.owner_type='personal' AND workspace.personal_owner_id=$2) OR EXISTS (SELECT 1 FROM stash_organization_memberships membership
          WHERE membership.organization_id=workspace.organization_owner_id AND membership.account_id=$2))`, [record.workspaceId, memberId])).rowCount)
        return { status: "workspace_forbidden" as const };
      if (operation) {
        await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`${record.workspaceId}:${memberId}:${operation.key}`]);
        const receipt = await client.query<any>(`SELECT receipt.payload_digest,receipt.projection,attachment.* FROM stash_attachment_operation_receipts receipt
          JOIN stash_attachments attachment ON attachment.id=receipt.attachment_id WHERE receipt.operation_key=$1 AND receipt.workspace_id=$2 AND receipt.created_by_account_id=$3`,
        [operation.key, record.workspaceId, memberId]);
        if (receipt.rows[0]) return receipt.rows[0].payload_digest === operation.digest
          ? { status: "duplicate" as const, digest: receipt.rows[0].payload_digest, record: attachmentRecord(receipt.rows[0]), projection: receipt.rows[0].projection }
          : { status: "conflict" as const };
      }
      await client.query(`INSERT INTO stash_attachments (id,workspace_id,filename,content_type,byte_size,relative_path,storage_key,source,created_by_account_id,created_at)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`, [record.id, record.workspaceId, record.filename, record.contentType, record.size,
        record.relativePath, record.storageKey, record.source, memberId, record.createdAt]);
      await this.hooks.recordProjection(client, "Attachment", record.id, projection.schema, projection);
      if (operation) await client.query(`INSERT INTO stash_attachment_operation_receipts
        (operation_key,workspace_id,created_by_account_id,payload_digest,attachment_id,projection) VALUES ($1,$2,$3,$4,$5,$6::jsonb)`,
      [operation.key, record.workspaceId, memberId, operation.digest, record.id, JSON.stringify(projection)]);
      return { status: "created" as const };
    });
  }

  async canCreateAttachment(memberId: string, workspaceId: string): Promise<boolean> {
    return this.kernel.withSession(async (client) => { await this.hooks.prepareWorkspaceProjects(client);
      return (await client.query(`SELECT 1 FROM stash_workspaces workspace WHERE workspace.id=$1 AND
        ((workspace.owner_type='personal' AND workspace.personal_owner_id=$2) OR EXISTS (SELECT 1 FROM stash_organization_memberships membership
          WHERE membership.organization_id=workspace.organization_owner_id AND membership.account_id=$2))`, [workspaceId, memberId])).rowCount === 1; });
  }

  async findAttachmentForMember(memberId: string, attachmentId: string): Promise<AttachmentRecord | undefined> {
    return this.kernel.withSession(async (client) => { await this.hooks.prepareAttachments(client);
      const result = await client.query<any>(`SELECT attachment.* FROM stash_attachments attachment JOIN stash_workspaces workspace ON workspace.id=attachment.workspace_id
        WHERE attachment.id=$1 AND ((workspace.owner_type='personal' AND workspace.personal_owner_id=$2) OR EXISTS
        (SELECT 1 FROM stash_organization_memberships membership WHERE membership.organization_id=workspace.organization_owner_id AND membership.account_id=$2))`, [attachmentId, memberId]);
      return result.rows[0] ? attachmentRecord(result.rows[0]) : undefined; });
  }

async findNoteForMember(memberId: string, noteId: string): Promise<NoteRecord | undefined> {
    await this.hooks.prepare(this.kernel);
    if (await this.authorizeNote(this.kernel, memberId, noteId) === "none") return undefined;
    const result = await this.kernel.query<{
      id: string; workspace_id: string; project_id: string | null; content: string; document: NoteRecord["document"];
      revision: number; tags: string[]; reminder_at: Date | null; created_by_account_id: string; created_at: Date;
    }>("SELECT * FROM stash_notes WHERE id=$1", [noteId]);
    const row = result.rows[0];
    return row ? {
      id: row.id, workspaceId: row.workspace_id, content: row.content, document: row.document, revision: row.revision,
      tags: row.tags, createdByMemberId: row.created_by_account_id, createdAt: row.created_at.toISOString(),
      ...(row.project_id ? { projectId: row.project_id } : {}),
      ...(row.reminder_at ? { reminder: { at: row.reminder_at.toISOString() } } : {}),
    } : undefined;
  }

async moveNote(memberId: string, noteId: string, expectedRevision: number, path: string, _projection: PortableNoteLocationProjection) {
    return this.kernel.transaction(async (client) => {
      await this.hooks.prepare(client);
      const found = await client.query<any>(`SELECT note.id, note.workspace_id, note.portable_path, note.location_revision,
        ARRAY(SELECT alias.path FROM stash_note_path_aliases alias WHERE alias.note_id=note.id ORDER BY alias.created_at, alias.path) aliases
        FROM stash_notes note JOIN stash_workspaces workspace ON workspace.id=note.workspace_id WHERE note.id=$1 AND
        ((workspace.owner_type='personal' AND workspace.personal_owner_id=$2) OR EXISTS
          (SELECT 1 FROM stash_organization_memberships membership WHERE membership.organization_id=workspace.organization_owner_id AND membership.account_id=$2))
        FOR UPDATE OF note`, [noteId, memberId]);
      const row = found.rows[0]; if (!row) return { status: "not_found" as const };
      const current: NoteLocationRecord = { noteId: row.id, workspaceId: row.workspace_id, path: row.portable_path,
        aliases: row.aliases ?? [], revision: row.location_revision };
      if (current.revision !== expectedRevision) return { status: "changed" as const, location: current };
      if (path === current.path) return { status: "unchanged" as const, location: current };
      await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`note-path:${current.workspaceId}`]);
      const conflict = await client.query(`SELECT 1 FROM stash_notes WHERE workspace_id=$1 AND id<>$2 AND portable_path=$3
        UNION ALL SELECT 1 FROM stash_note_path_aliases WHERE workspace_id=$1 AND note_id<>$2 AND path=$3 LIMIT 1`, [current.workspaceId, noteId, path]);
      if (conflict.rowCount) return { status: "path_conflict" as const };
      if (path !== current.path) await client.query(`INSERT INTO stash_note_path_aliases(workspace_id,note_id,path) VALUES($1,$2,$3)
        ON CONFLICT(workspace_id,path) DO NOTHING`, [current.workspaceId, noteId, current.path]);
      await client.query("DELETE FROM stash_note_path_aliases WHERE workspace_id=$1 AND note_id=$2 AND path=$3", [current.workspaceId, noteId, path]);
      await client.query("UPDATE stash_notes SET portable_path=$2,location_revision=location_revision+1 WHERE id=$1", [noteId, path]);
      const location: NoteLocationRecord = { ...current, path,
        aliases: [...new Set([...current.aliases.filter((alias) => alias !== path), current.path])], revision: current.revision + 1 };
      const projection: PortableNoteLocationProjection = { schema: "stash.note-location.v1", ...location };
      await this.hooks.recordProjection(client, "NoteLocation", noteId, projection.schema, projection);
      await this.recordDomainActivity(client,memberId,current.workspaceId,"NoteLocation",noteId,"note_moved",current,location);
      return { status: "moved" as const, location };
    });
  }

async createNoteLink(memberId: string, link: NoteLinkRecord, _projection: PortableNoteLinkStateProjection) {
    return this.kernel.transaction(async (client) => {
      await this.hooks.prepare(client);
      const notes = await client.query<any>(`SELECT note.id,note.workspace_id,note.portable_path,
        ((workspace.owner_type='personal' AND workspace.personal_owner_id=$3) OR EXISTS
          (SELECT 1 FROM stash_organization_memberships membership WHERE membership.organization_id=workspace.organization_owner_id AND membership.account_id=$3)) accessible
        FROM stash_notes note JOIN stash_workspaces workspace ON workspace.id=note.workspace_id WHERE note.id IN($1,$2)`,
      [link.sourceNoteId, link.targetNoteId, memberId]);
      const source = notes.rows.find((row) => row.id === link.sourceNoteId && row.accessible);
      if (!source) return { status: "source_not_found" as const };
      const target = notes.rows.find((row) => row.id === link.targetNoteId && row.accessible && row.workspace_id === source.workspace_id);
      if (!target) return { status: "target_not_found" as const };
      const saved = { ...link, workspaceId: source.workspace_id };
      const inserted = await client.query(`INSERT INTO stash_note_links(id,workspace_id,source_note_id,target_note_id,target_path,label,revision)
        VALUES($1,$2,$3,$4,$5,$6,1) ON CONFLICT(source_note_id,target_note_id) DO NOTHING RETURNING id`,
      [saved.id, saved.workspaceId, saved.sourceNoteId, saved.targetNoteId, target.portable_path, saved.label]);
      if (!inserted.rowCount) return { status: "already_linked" as const };
      const projection: PortableNoteLinkStateProjection = { schema: "stash.note-link.v2", ...saved };
      await this.hooks.recordProjection(client, "NoteLink", saved.id, projection.schema, projection);
      await this.recordDomainActivity(client,memberId,saved.workspaceId,"NoteLink",saved.id,"note_link_created",{},saved);
      return { status: "created" as const, link: saved };
    });
  }

async createImportedNoteLink(memberId: string, link: NoteLinkRecord, _projection: PortableNoteLinkStateProjection) {
    return this.kernel.transaction(async (client) => {
      await this.hooks.prepare(client);
      const source = await client.query<any>(`SELECT note.workspace_id FROM stash_notes note JOIN stash_workspaces workspace ON workspace.id=note.workspace_id
        WHERE note.id=$1 AND ((workspace.owner_type='personal' AND workspace.personal_owner_id=$2) OR EXISTS
          (SELECT 1 FROM stash_organization_memberships membership WHERE membership.organization_id=workspace.organization_owner_id AND membership.account_id=$2))`,
      [link.sourceNoteId, memberId]);
      if (!source.rows[0]) return { status: "source_not_found" as const };
      const candidateIds = link.candidateNoteIds ?? [];
      const candidates = candidateIds.length ? await client.query<{ id: string }>(
        "SELECT id FROM stash_notes WHERE workspace_id=$1 AND id=ANY($2::uuid[]) ORDER BY id", [source.rows[0].workspace_id, candidateIds]) : { rows: [] };
      if (candidates.rows.length !== candidateIds.length) return { status: "candidate_not_found" as const };
      const saved: NoteLinkRecord = { ...link, workspaceId: source.rows[0].workspace_id };
      await client.query(`INSERT INTO stash_note_links(id,workspace_id,source_note_id,target_note_id,target_path,candidate_note_ids,label,revision)
        VALUES($1,$2,$3,NULL,$4,$5::uuid[],$6,1)`,
      [saved.id, saved.workspaceId, saved.sourceNoteId, saved.targetPath, candidateIds, saved.label]);
      const projection: PortableNoteLinkStateProjection = { schema: "stash.note-link.v2", ...saved };
      await this.hooks.recordProjection(client, "NoteLink", saved.id, projection.schema, projection);
      await this.recordDomainActivity(client,memberId,saved.workspaceId,"NoteLink",saved.id,"note_link_imported",{},saved);
      return { status: "created" as const, link: saved };
    });
  }

async listNoteLinks(memberId: string, sourceNoteId: string) {
    return this.kernel.withSession(async (client) => {
      await this.hooks.prepare(client);
      const source = await client.query<any>(`SELECT note.workspace_id,note.portable_path,note.location_revision,
        ARRAY(SELECT alias.path FROM stash_note_path_aliases alias WHERE alias.note_id=note.id ORDER BY alias.created_at,alias.path) aliases
        FROM stash_notes note JOIN stash_workspaces workspace ON workspace.id=note.workspace_id
        WHERE note.id=$1 AND ((workspace.owner_type='personal' AND workspace.personal_owner_id=$2) OR EXISTS
          (SELECT 1 FROM stash_organization_memberships membership WHERE membership.organization_id=workspace.organization_owner_id AND membership.account_id=$2))`, [sourceNoteId, memberId]);
      if (!source.rows[0]) return { status: "not_found" as const };
      const rows = await client.query<any>(`SELECT link.*,target.portable_path,target.location_revision,
        ARRAY(SELECT alias.path FROM stash_note_path_aliases alias WHERE alias.note_id=target.id ORDER BY alias.created_at,alias.path) aliases
        FROM stash_note_links link LEFT JOIN stash_notes target ON target.id=link.target_note_id WHERE link.source_note_id=$1 ORDER BY link.id`, [sourceNoteId]);
      const links: any[] = [];
      for (const row of rows.rows) {
        const link: NoteLinkRecord = { id: row.id, workspaceId: row.workspace_id, sourceNoteId: row.source_note_id,
          ...(row.target_note_id ? { targetNoteId: row.target_note_id } : {}), ...(row.target_path ? { targetPath: row.target_path } : {}),
          ...(row.candidate_note_ids?.length ? { candidateNoteIds: row.candidate_note_ids } : {}), label: row.label,
          ...(row.relationship_type ? { relationshipType: row.relationship_type } : {}), revision: row.revision };
        if (row.target_note_id && row.portable_path) { links.push({ link, state: "resolved", target: { noteId: row.target_note_id,
          workspaceId: row.workspace_id, path: row.portable_path, aliases: row.aliases ?? [], revision: row.location_revision } }); continue; }
        const candidates = await client.query<any>(`SELECT DISTINCT note.id,note.workspace_id,note.portable_path,note.location_revision FROM stash_notes note
          WHERE note.workspace_id=$1 AND note.id=ANY($2::uuid[])
          AND ((EXISTS(SELECT 1 FROM stash_workspaces workspace WHERE workspace.id=note.workspace_id AND workspace.owner_type='personal' AND workspace.personal_owner_id=$3))
            OR EXISTS(SELECT 1 FROM stash_workspaces workspace JOIN stash_organization_memberships membership ON membership.organization_id=workspace.organization_owner_id
              WHERE workspace.id=note.workspace_id AND membership.account_id=$3))`, [row.workspace_id, row.candidate_note_ids ?? [], memberId]);
        const visible = candidates.rows.map((candidate) => ({ noteId: candidate.id, workspaceId: candidate.workspace_id,
          path: candidate.portable_path, aliases: [], revision: candidate.location_revision }));
        links.push(visible.length ? { link, state: "ambiguous", candidates: visible } : { link, state: "broken" });
      }
      return { status: "found" as const, source: { noteId: sourceNoteId, workspaceId: source.rows[0].workspace_id,
        path: source.rows[0].portable_path, aliases: source.rows[0].aliases ?? [], revision: source.rows[0].location_revision }, links };
    });
  }

async repairNoteLink(memberId: string, sourceNoteId: string, linkId: string, targetNoteId: string, expectedRevision: number,
    _projection: PortableNoteLinkStateProjection) {
    return this.kernel.transaction(async (client) => {
      await this.hooks.prepare(client);
      const found = await client.query<any>(`SELECT link.* FROM stash_note_links link JOIN stash_notes source ON source.id=link.source_note_id
        JOIN stash_workspaces workspace ON workspace.id=source.workspace_id WHERE link.id=$1 AND link.source_note_id=$2 AND
        ((workspace.owner_type='personal' AND workspace.personal_owner_id=$3) OR EXISTS
          (SELECT 1 FROM stash_organization_memberships membership WHERE membership.organization_id=workspace.organization_owner_id AND membership.account_id=$3))
        FOR UPDATE OF link`, [linkId, sourceNoteId, memberId]);
      const row = found.rows[0]; if (!row) return { status: "not_found" as const };
      const current: NoteLinkRecord = { id: row.id, workspaceId: row.workspace_id, sourceNoteId: row.source_note_id,
        ...(row.target_note_id ? { targetNoteId: row.target_note_id } : {}), ...(row.target_path ? { targetPath: row.target_path } : {}),
        ...(row.candidate_note_ids?.length ? { candidateNoteIds: row.candidate_note_ids } : {}), label: row.label, revision: row.revision };
      if (current.revision !== expectedRevision) return { status: "changed" as const, link: current };
      const target = await client.query<any>(`SELECT portable_path FROM stash_notes WHERE id=$1 AND workspace_id=$2`, [targetNoteId, current.workspaceId]);
      if (!target.rowCount) return { status: "target_not_found" as const };
      const { targetPath: _, candidateNoteIds: __, ...stable } = current;
      const repaired = { ...stable, targetNoteId, revision: current.revision + 1 };
      await client.query("UPDATE stash_note_links SET target_note_id=$2,target_path=$3,candidate_note_ids='{}'::uuid[],revision=revision+1 WHERE id=$1", [linkId, targetNoteId, target.rows[0].portable_path]);
      const projection: PortableNoteLinkStateProjection = { schema: "stash.note-link.v2", ...repaired };
      await this.hooks.recordProjection(client, "NoteLink", linkId, projection.schema, projection);
      await this.recordDomainActivity(client,memberId,current.workspaceId,"NoteLink",linkId,"note_link_repaired",current,repaired);
      return { status: "repaired" as const, link: repaired };
    });
  }


  async applyNoteOperations(memberId: string, noteId: string, batch: NoteEditBatch) {
    return this.kernel.transaction(async (client) => {
      await this.hooks.prepare(client);
      const access = await client.query<any>(`SELECT note.*, creator.name AS creator_name FROM stash_notes note JOIN stash_workspaces workspace ON workspace.id = note.workspace_id
        JOIN stash_accounts creator ON creator.id = note.created_by_account_id
        WHERE note.id = $1 AND ((workspace.owner_type = 'personal' AND workspace.personal_owner_id = $2)
        OR (workspace.owner_type = 'organization' AND EXISTS (SELECT 1 FROM stash_organization_memberships membership
        WHERE membership.organization_id = workspace.organization_owner_id AND membership.account_id = $2))) FOR UPDATE OF note`, [noteId, memberId]);
      const row = access.rows[0];
      if (!row) return { status: "not_found" as const };
      const createdBy = { localAccountId: row.created_by_account_id, displayName: row.creator_name };
      const existing = await client.query<{ operation_id: string; operation_digest: string | null }>("SELECT operation_id, operation_digest FROM stash_note_operations WHERE note_id = $1 AND operation_id = ANY($2::uuid[])", [noteId, batch.operations.map(({ id }) => id)]);
      const knownDigests = new Map(existing.rows.map(({ operation_id, operation_digest }) => [operation_id, operation_digest]));
      const acknowledged = await client.query<{ operation_id: string; operation_digest: string }>("SELECT operation_id, operation_digest FROM stash_note_acknowledged_operations WHERE note_id = $1 AND operation_id = ANY($2::uuid[])", [noteId, batch.operations.map(({ id }) => id)]);
      for (const { operation_id, operation_digest } of acknowledged.rows) if (!knownDigests.has(operation_id)) knownDigests.set(operation_id, operation_digest);
      const reused = batch.operations.find((operation) => knownDigests.has(operation.id) && knownDigests.get(operation.id) !== noteOperationDigest(operation));
      if (reused) {
        await client.query("INSERT INTO stash_note_edit_conflicts (id,note_id,base_revision,document,markdown,operations,created_by_account_id,kind) VALUES ($1,$2,$3,$4::jsonb,$5,$6::jsonb,$7,'invalid_operation_id')", [randomUUID(),noteId,batch.baseRevision,JSON.stringify(row.document),row.content,JSON.stringify([reused]),memberId]);
        return { status: "invalid_reference" as const };
      }
      const applied = new Set([...existing.rows, ...acknowledged.rows].map(({ operation_id }) => operation_id));
      const conflicted = await client.query<{ operation_id: string; operation_digest: string | null; conflict_id: string }>("SELECT operation_id, operation_digest, conflict_id FROM stash_note_conflict_operations WHERE note_id = $1 AND operation_id = ANY($2::uuid[])", [noteId, batch.operations.map(({ id }) => id)]);
      const conflictDigests = new Map(conflicted.rows.map(({ operation_id, operation_digest }) => [operation_id, operation_digest]));
      const reusedConflict = batch.operations.find((operation) => conflictDigests.has(operation.id) && conflictDigests.get(operation.id) !== noteOperationDigest(operation));
      if (reusedConflict) {
        await client.query("INSERT INTO stash_note_edit_conflicts (id,note_id,base_revision,document,markdown,operations,created_by_account_id,kind) VALUES ($1,$2,$3,$4::jsonb,$5,$6::jsonb,$7,'invalid_operation_id')", [randomUUID(),noteId,batch.baseRevision,JSON.stringify(row.document),row.content,JSON.stringify([reusedConflict]),memberId]);
        return { status: "invalid_reference" as const };
      }
      const conflictIds = new Set(conflicted.rows.map(({ operation_id }) => operation_id));
      const pending = batch.operations.filter(({ id }) => !applied.has(id) && !conflictIds.has(id));
      const current: NoteRecord = { id: row.id, workspaceId: row.workspace_id, content: row.content, document: row.document,
        revision: row.revision, tags: row.tags, createdByMemberId: row.created_by_account_id, createdAt: new Date(row.created_at).toISOString(),
        ...(row.project_id ? { projectId: row.project_id } : {}), ...(row.reminder_at ? { reminder: { at: new Date(row.reminder_at).toISOString() } } : {}),
        ...(row.archived_at ? { archivedAt: new Date(row.archived_at).toISOString() } : {}) };
      const projectionFor = (note: NoteRecord): PortableNoteProjection => ({ schema: "stash.note.v1", id: note.id,
        workspaceId: note.workspaceId, content: note.content, tags: note.tags, createdAt: note.createdAt, createdBy,
        ...(note.projectId ? { projectId: note.projectId } : {}), ...(note.reminder ? { reminder: note.reminder } : {}) });
      if (!pending.length) return conflictIds.size ? { status: "conflict_preserved" as const, conflictId: conflicted.rows[0]!.conflict_id }
        : { status: "duplicate" as const, note: current, projection: projectionFor(current) };
      const changed = await client.query<{ block_key: string }>("SELECT block_key FROM stash_note_operations WHERE note_id = $1 AND applied_revision > $2", [noteId, batch.baseRevision]);
      const changedKeys = new Set(changed.rows.map(({ block_key }) => block_key));
      if (pending.some((operation) => changedKeys.has(operation.blockKey)
        || (operation.type === "insert_block" && operation.afterBlockKey !== null && changedKeys.has(operation.afterBlockKey)))) {
        const conflictId = randomUUID();
        await client.query("INSERT INTO stash_note_edit_conflicts (id, note_id, base_revision, document, markdown, operations, created_by_account_id) VALUES ($1,$2,$3,$4::jsonb,$5,$6::jsonb,$7)",
          [conflictId, noteId, batch.baseRevision, JSON.stringify(current.document), current.content, JSON.stringify(pending), memberId]);
        for (const operation of pending) await client.query("INSERT INTO stash_note_conflict_operations (note_id,operation_id,conflict_id,operation_digest) VALUES ($1,$2,$3,$4)", [noteId, operation.id, conflictId, noteOperationDigest(operation)]);
        return { status: "conflict_preserved" as const, conflictId };
      }
      const blocks = [...current.document.blocks];
      for (const operation of pending) {
        const index = blocks.findIndex(({ blockKey }) => blockKey === operation.blockKey);
        if (operation.type === "insert_block") {
          if (index >= 0 || operation.block.id) return { status: "invalid_reference" as const };
          const after = operation.afterBlockKey === null ? -1 : blocks.findIndex(({ blockKey }) => blockKey === operation.afterBlockKey);
          if (operation.afterBlockKey !== null && after < 0) return { status: "invalid_reference" as const };
          blocks.splice(after + 1, 0, operation.block);
        } else if (operation.type === "delete_block") {
          if (index < 0 || blocks[index]!.id) return { status: "invalid_reference" as const };
          blocks.splice(index, 1);
        } else {
          if (index < 0 || blocks[index]!.id !== operation.block.id) return { status: "invalid_reference" as const };
          blocks[index] = operation.block;
        }
      }
      if (!blocks.length) return { status: "invalid_reference" as const };
      const document = { type: "doc" as const, blocks };
      const note = { ...current, document, content: richTextToMarkdown(document), revision: current.revision + 1 };
      const projection = projectionFor(note);
      await client.query("UPDATE stash_notes SET content=$2, document=$3::jsonb, revision=$4 WHERE id=$1", [noteId, note.content, JSON.stringify(document), note.revision]);
      for (const operation of pending) await client.query("INSERT INTO stash_note_operations (note_id,operation_id,base_revision,applied_revision,block_key,operation_digest) VALUES ($1,$2,$3,$4,$5,$6)", [noteId, operation.id, batch.baseRevision, note.revision, operation.blockKey, noteOperationDigest(operation)]);
      await this.hooks.recordProjection(client, "Note", note.id, "stash.note.v1", projection);
      await this.recordNoteRevisionAndActivity(client, memberId, current, note, "note_edited", { kind: "member" });
      return { status: "updated" as const, note, projection };
    });
  }


  async listNoteEditConflicts(memberId: string, noteId: string) {
    await this.hooks.prepare(this.kernel);
    const result = await this.kernel.query<{
      id: string; note_id: string; base_revision: number; document: NoteRecord["document"]; markdown: string;
      operations: NoteEditBatch["operations"] | null; created_at: Date; resolved_at: Date | null; resolution: NoteConflictResolution | null;
      kind: "concurrent_edit" | "invalid_operation_id"; current_revision: number; creator_name: string;
    }>(`SELECT conflict.id, conflict.note_id, conflict.base_revision, conflict.document, conflict.markdown,
        conflict.operations, conflict.created_at, conflict.resolved_at, conflict.resolution, conflict.kind,
        note.revision AS current_revision, creator.name AS creator_name
      FROM stash_note_edit_conflicts conflict
      JOIN stash_notes note ON note.id = conflict.note_id
      JOIN stash_workspaces workspace ON workspace.id = note.workspace_id
      JOIN stash_accounts creator ON creator.id = conflict.created_by_account_id
      WHERE conflict.note_id = $1 AND conflict.resolved_at IS NULL
        AND ((workspace.owner_type = 'personal' AND workspace.personal_owner_id = $2)
          OR (workspace.owner_type = 'organization' AND EXISTS (SELECT 1 FROM stash_organization_memberships membership
            WHERE membership.organization_id = workspace.organization_owner_id AND membership.account_id = $2)))
      ORDER BY conflict.created_at, conflict.id`, [noteId, memberId]);
    if (!result.rowCount) {
      const note = await this.findNoteForMember(memberId, noteId);
      if (!note) return { status: "not_found" as const };
    }
    const conflicts: NoteEditConflict[] = result.rows.map((row) => ({ id: row.id, noteId: row.note_id,
      baseRevision: row.base_revision, preservedDocument: row.document, preservedMarkdown: row.markdown,
      operations: row.operations ?? [], kind: row.kind, currentRevision: row.current_revision,
      createdBy: { displayName: row.creator_name, attribution: "recorded" }, createdAt: row.created_at.toISOString(),
      ...(row.resolved_at ? { resolvedAt: row.resolved_at.toISOString() } : {}), ...(row.resolution ? { resolution: row.resolution } : {}) }));
    return { status: "found" as const, conflicts };
  }


  async resolveNoteEditConflict(memberId: string, noteId: string, conflictId: string, resolution: NoteConflictResolution, expectedRevision: number) {
    return this.kernel.transaction(async (client) => {
      await this.hooks.prepare(client);
      const access = await client.query<any>(`SELECT note.*, creator.name AS creator_name
        FROM stash_notes note JOIN stash_workspaces workspace ON workspace.id = note.workspace_id
        JOIN stash_accounts creator ON creator.id = note.created_by_account_id
        WHERE note.id = $1 AND ((workspace.owner_type = 'personal' AND workspace.personal_owner_id = $2)
          OR (workspace.owner_type = 'organization' AND EXISTS (SELECT 1 FROM stash_organization_memberships membership
            WHERE membership.organization_id = workspace.organization_owner_id AND membership.account_id = $2)))
        FOR UPDATE OF note`, [noteId, memberId]);
      const row = access.rows[0];
      if (!row) return { status: "not_found" as const };
      const found = await client.query<{ operations: NoteEditBatch["operations"] | null; resolved_at: Date | null; base_revision: number;
        document: NoteRecord["document"]; markdown: string; created_at: Date; resolution: NoteConflictResolution | null;
        kind: "concurrent_edit" | "invalid_operation_id"; creator_name: string }>(`SELECT conflict.operations, conflict.resolved_at,
          conflict.base_revision, conflict.document, conflict.markdown, conflict.created_at, conflict.resolution, conflict.kind,
          creator.name AS creator_name FROM stash_note_edit_conflicts conflict JOIN stash_accounts creator
          ON creator.id = conflict.created_by_account_id WHERE conflict.id = $1 AND conflict.note_id = $2 FOR UPDATE OF conflict`, [conflictId, noteId]);
      const conflict = found.rows[0];
      if (!conflict) return { status: "conflict_not_found" as const };
      if (conflict.resolved_at) return { status: "already_resolved" as const };
      if (row.revision !== expectedRevision) return { status: "conflict_changed" as const, conflict: {
        id: conflictId, noteId, baseRevision: conflict.base_revision, preservedDocument: conflict.document,
        preservedMarkdown: conflict.markdown, operations: conflict.operations ?? [], kind: conflict.kind,
        currentRevision: row.revision, createdBy: { displayName: conflict.creator_name, attribution: "recorded" as const },
        createdAt: conflict.created_at.toISOString(), ...(conflict.resolution ? { resolution: conflict.resolution } : {}) } };
      if (resolution === "apply_contribution" && conflict.kind === "invalid_operation_id") return { status: "invalid_operation_identity" as const };
      const current: NoteRecord = { id: row.id, workspaceId: row.workspace_id, content: row.content, document: row.document,
        revision: row.revision, tags: row.tags, createdByMemberId: row.created_by_account_id, createdAt: new Date(row.created_at).toISOString(),
        ...(row.project_id ? { projectId: row.project_id } : {}), ...(row.reminder_at ? { reminder: { at: new Date(row.reminder_at).toISOString() } } : {}),
        ...(row.archived_at ? { archivedAt: new Date(row.archived_at).toISOString() } : {}) };
      const projectionFor = (note: NoteRecord): PortableNoteProjection => ({ schema: "stash.note.v1", id: note.id,
        workspaceId: note.workspaceId, content: note.content, tags: note.tags, createdAt: note.createdAt,
        createdBy: { localAccountId: row.created_by_account_id, displayName: row.creator_name },
        ...(note.projectId ? { projectId: note.projectId } : {}), ...(note.reminder ? { reminder: note.reminder } : {}) });
      let note = current;
      if (resolution === "apply_contribution") {
        const operations = conflict.operations ?? [];
        const blocks = [...current.document.blocks];
        for (const operation of operations) {
          const index = blocks.findIndex(({ blockKey }) => blockKey === operation.blockKey);
          if (operation.type === "insert_block") {
            if (index >= 0 || operation.block.id) return { status: "invalid_reference" as const };
            const after = operation.afterBlockKey === null ? -1 : blocks.findIndex(({ blockKey }) => blockKey === operation.afterBlockKey);
            if (operation.afterBlockKey !== null && after < 0) return { status: "invalid_reference" as const };
            blocks.splice(after + 1, 0, operation.block);
          } else if (operation.type === "delete_block") {
            if (index < 0 || blocks[index]!.id) return { status: "invalid_reference" as const };
            blocks.splice(index, 1);
          } else {
            if (index < 0 || blocks[index]!.id !== operation.block.id) return { status: "invalid_reference" as const };
            blocks[index] = operation.block;
          }
        }
        if (!blocks.length) return { status: "invalid_reference" as const };
        const document = { type: "doc" as const, blocks };
        note = { ...current, document, content: richTextToMarkdown(document), revision: current.revision + 1 };
        await client.query("UPDATE stash_notes SET content=$2, document=$3::jsonb, revision=$4 WHERE id=$1", [noteId, note.content, JSON.stringify(document), note.revision]);
        for (const operation of operations) await client.query(`INSERT INTO stash_note_operations
          (note_id,operation_id,base_revision,applied_revision,block_key,operation_digest) VALUES ($1,$2,$3,$4,$5,$6)
          ON CONFLICT (note_id, operation_id) DO NOTHING`, [noteId, operation.id, conflict.base_revision, note.revision, operation.blockKey, noteOperationDigest(operation)]);
        await client.query("DELETE FROM stash_note_conflict_operations WHERE conflict_id = $1 AND note_id = $2", [conflictId, noteId]);
        await this.hooks.recordProjection(client, "Note", note.id, "stash.note.v1", projectionFor(note));
      } else {
        for (const operation of conflict.operations ?? []) await client.query(`INSERT INTO stash_note_acknowledged_operations
          (note_id,operation_id,operation_digest) VALUES ($1,$2,$3) ON CONFLICT (note_id, operation_id) DO NOTHING`,
          [noteId, operation.id, noteOperationDigest(operation)]);
        await client.query("DELETE FROM stash_note_conflict_operations WHERE conflict_id = $1 AND note_id = $2", [conflictId, noteId]);
      }
      await client.query(`UPDATE stash_note_edit_conflicts SET resolved_at = CURRENT_TIMESTAMP, resolution = $3,
        resolved_by_account_id = $4 WHERE id = $1 AND note_id = $2`, [conflictId, noteId, resolution, memberId]);
      await this.recordNoteRevisionAndActivity(client, memberId, current, note,
        resolution === "apply_contribution" ? "note_conflict_contribution_applied" : "note_conflict_kept_current", { kind: "member" });
      return { status: "resolved" as const, note, projection: projectionFor(note) };
    });
  }


  async loadNoteCollaboration(memberId: string, noteId: string): Promise<CollaborationSnapshot | undefined> {
    return this.kernel.transaction(async (client) => {
      await this.ensureCollaborationSchema(client);
      const access = await this.authorizeNote(client, memberId, noteId);
      if (access === "none") return undefined;
      let row = (await client.query<any>(`SELECT note_id,sequence,update,updated_at,updated_by_account_id
        FROM stash_note_collaboration WHERE note_id=$1`, [noteId])).rows[0];
      if (!row) row = await this.seedNoteCollaboration(client, noteId);
      return { noteId: row.note_id, sequence: Number(row.sequence), update: new Uint8Array(row.update),
        updatedAt: new Date(row.updated_at).toISOString(), updatedByMemberId: row.updated_by_account_id, access };
    });
  }


  async appendNoteCollaboration(memberId: string, noteId: string, update: Uint8Array): Promise<CollaborationSnapshot | undefined> {
    return this.kernel.transaction(async (client) => {
      await this.ensureCollaborationSchema(client); await this.hooks.prepareHistory(client);
      if (await this.authorizeNote(client, memberId, noteId) !== "edit") return undefined;
      await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`note-collaboration:${noteId}`]);
      const noteRow = (await client.query<any>(`SELECT note.*, creator.name AS creator_name FROM stash_notes note
        JOIN stash_accounts creator ON creator.id=note.created_by_account_id WHERE note.id=$1 FOR UPDATE OF note`, [noteId])).rows[0];
      if (!noteRow) return undefined;
      const before = noteFromRow(noteRow);
      let current = (await client.query<any>(`SELECT note_id,sequence,update,updated_at,updated_by_account_id
        FROM stash_note_collaboration WHERE note_id=$1 FOR UPDATE`, [noteId])).rows[0];
      if (!current) current = await this.seedNoteCollaboration(client, noteId);
      const document = new Y.Doc();
      if (current) Y.applyUpdate(document, new Uint8Array(current.update));
      const beforeUpdate = Y.encodeStateAsUpdate(document);
      Y.applyUpdate(document, update);
      const merged = Y.encodeStateAsUpdate(document);
      if (Buffer.from(beforeUpdate).equals(Buffer.from(merged))) {
        document.destroy();
        return { noteId: current.note_id, sequence: Number(current.sequence), update: new Uint8Array(current.update),
          updatedAt: new Date(current.updated_at).toISOString(), updatedByMemberId: current.updated_by_account_id, access: "edit" };
      }
      let canonicalDocument: import("../rich-text.js").RichTextDocument;
      try { canonicalDocument = validatedRichTextFromCollaborativeDocument(document); }
      finally { document.destroy(); }
      const note: NoteRecord = { ...before, document: canonicalDocument, content: richTextToMarkdown(canonicalDocument), revision: before.revision + 1 };
      await client.query("UPDATE stash_notes SET content=$2,document=$3::jsonb,revision=$4 WHERE id=$1",
        [noteId, note.content, JSON.stringify(note.document), note.revision]);
      const row = (await client.query<any>(`INSERT INTO stash_note_collaboration(note_id,sequence,update,updated_by_account_id)
        VALUES($1,$2,$3,$4) ON CONFLICT(note_id) DO UPDATE SET sequence=EXCLUDED.sequence,update=EXCLUDED.update,
        updated_by_account_id=EXCLUDED.updated_by_account_id,updated_at=now()
        RETURNING note_id,sequence,update,updated_at,updated_by_account_id`,
      [noteId, Number(current?.sequence ?? 0) + 1, Buffer.from(merged), memberId])).rows[0];
      await client.query(`INSERT INTO stash_note_collaboration_activity(note_id,sequence,actor_account_id,update_bytes)
        VALUES($1,$2,$3,$4)`, [noteId, row.sequence, memberId, update.byteLength]);
      const projection: PortableNoteProjection = { schema: "stash.note.v1", id: note.id, workspaceId: note.workspaceId,
        content: note.content, tags: note.tags, createdAt: note.createdAt,
        createdBy: { localAccountId: before.createdByMemberId, displayName: noteRow.creator_name },
        ...(note.projectId ? { projectId: note.projectId } : {}), ...(note.reminder ? { reminder: note.reminder } : {}) };
      await this.hooks.recordProjection(client, "Note", note.id, projection.schema, projection);
      await this.recordNoteRevisionAndActivity(client, memberId, before, note, "note_edited", { kind: "member" });
      return { noteId: row.note_id, sequence: Number(row.sequence), update: new Uint8Array(row.update),
        updatedAt: new Date(row.updated_at).toISOString(), updatedByMemberId: row.updated_by_account_id, access: "edit" };
    });
  }


  private async seedNoteCollaboration(client: PostgresQueryable, noteId: string): Promise<any> {
    const note = (await client.query<any>("SELECT document,created_by_account_id,created_at FROM stash_notes WHERE id=$1", [noteId])).rows[0];
    if (!note) throw new Error("note_not_found");
    const document = collaborativeDocumentFromRichText(note.document);
    const update = Y.encodeStateAsUpdate(document); document.destroy();
    return (await client.query<any>(`INSERT INTO stash_note_collaboration(note_id,sequence,update,updated_by_account_id,updated_at)
      VALUES($1,0,$2,$3,$4) ON CONFLICT(note_id) DO UPDATE SET note_id=EXCLUDED.note_id
      RETURNING note_id,sequence,update,updated_at,updated_by_account_id`,
    [noteId, Buffer.from(update), note.created_by_account_id, note.created_at])).rows[0];
  }


  private async ensureCollaborationSchema(client: PostgresQueryable): Promise<void> {
    await this.hooks.prepare(client);
    await client.query(`CREATE TABLE IF NOT EXISTS stash_note_collaboration(
      note_id uuid PRIMARY KEY REFERENCES stash_notes(id) ON DELETE CASCADE,sequence bigint NOT NULL CHECK(sequence>=0),
      update bytea NOT NULL,updated_by_account_id uuid NOT NULL REFERENCES stash_accounts(id),updated_at timestamptz NOT NULL DEFAULT now())`);
    await client.query(`CREATE TABLE IF NOT EXISTS stash_note_collaboration_activity(
      note_id uuid NOT NULL REFERENCES stash_notes(id) ON DELETE CASCADE,sequence bigint NOT NULL,
      actor_account_id uuid NOT NULL REFERENCES stash_accounts(id),update_bytes integer NOT NULL CHECK(update_bytes>0),
      occurred_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(note_id,sequence))`);
  }

  async prepareCollaboration(client: PostgresQueryable): Promise<void> {
    await this.ensureCollaborationSchema(client);
  }


  async createDiscussion(memberId: string, draft: DiscussionDraft) {
    return this.kernel.transaction(async (client) => {
      await this.ensureDiscussionSchema(client);
      let workspaceId: string;
      let target: DiscussionTarget;
      if (draft.target.kind === "task") {
        const task = await client.query<{ workspace_id: string; can_write: boolean; guest_can_read: boolean }>(`SELECT task.workspace_id,
          ((workspace.owner_type = 'personal' AND workspace.personal_owner_id = $2) OR EXISTS (
            SELECT 1 FROM stash_organization_memberships membership WHERE membership.organization_id = workspace.organization_owner_id
              AND membership.account_id = $2)) AS can_write,
          EXISTS (SELECT 1 FROM stash_project_guests guest WHERE guest.project_id = task.project_id AND guest.account_id = $2) AS guest_can_read
          FROM stash_tasks task JOIN stash_workspaces workspace ON workspace.id = task.workspace_id
          WHERE task.id = $1 FOR UPDATE OF task`, [draft.target.taskId, memberId]);
        const taskRow = task.rows[0];
        if (!taskRow) return { status: "target_not_found" as const };
        if (!taskRow.can_write) return { status: taskRow.guest_can_read ? "forbidden" as const : "target_not_found" as const };
        workspaceId = taskRow.workspace_id;
        target = draft.target;
      } else {
        const noteAccess = await this.authorizeNote(client, memberId, draft.target.noteId);
        if (noteAccess === "none") return { status: "target_not_found" as const };
        if (noteAccess === "read") return { status: "forbidden" as const };
        const note = await client.query<any>(`SELECT note.*, creator.name AS created_by_name
          FROM stash_notes note
          JOIN stash_accounts creator ON creator.id = note.created_by_account_id
          WHERE note.id = $1 FOR UPDATE OF note`, [draft.target.noteId]);
        const row = note.rows[0];
        if (!row) return { status: "target_not_found" as const };
        workspaceId = row.workspace_id;
        if (draft.target.kind === "note") target = draft.target;
        else {
          const blockTarget = draft.target;
          const blocks = Array.isArray(row.document?.blocks) ? row.document.blocks as Array<{ blockKey?: string; id?: string }> : [];
          const matches = blocks.filter((block) => block.blockKey === blockTarget.blockKey);
          if (matches.length !== 1) return { status: "target_not_found" as const };
          const block = matches[0]!;
          const blockId = block.id ?? randomUUID();
          if (block.id && blocks.filter((candidate) => candidate.id === blockId).length !== 1)
            return { status: "ambiguous_block" as const };
          if (!block.id) {
            const before = noteFromRow(row);
            block.id = blockId;
            const content = richTextToMarkdown(row.document);
            await client.query("UPDATE stash_notes SET document = $2::jsonb, content = $3, revision = revision + 1 WHERE id = $1",
              [draft.target.noteId, JSON.stringify(row.document), content]);
            const noteProjection = { schema: "stash.note.v1" as const, id: draft.target.noteId, workspaceId,
              content, tags: row.tags, createdAt: new Date(row.created_at).toISOString(),
              createdBy: { localAccountId: row.created_by_account_id, displayName: row.created_by_name },
              ...(row.project_id ? { projectId: row.project_id } : {}),
              ...(row.reminder_at ? { reminder: { at: new Date(row.reminder_at).toISOString() } } : {}) };
            await this.hooks.recordProjection(client, "Note", draft.target.noteId, "stash.note.v1", noteProjection);
            row.content = content; row.revision = Number(row.revision) + 1;
            await this.recordNoteRevisionAndActivity(client, memberId, before, noteFromRow(row),
              "note_block_identified", { kind: "member" });
          }
          target = { kind: "block", noteId: draft.target.noteId, blockId };
        }
      }
      const discussion: DiscussionRecord = { ...draft, workspaceId, target };
      await client.query(`INSERT INTO stash_discussions
        (id, workspace_id, target_kind, note_id, block_id, task_id, created_at)
        VALUES ($1,$2,$3,$4,$5,$6,$7)`, [discussion.id, workspaceId, target.kind,
        target.kind === "note" || target.kind === "block" ? target.noteId : null,
        target.kind === "block" ? target.blockId : null, target.kind === "task" ? target.taskId : null, discussion.createdAt]);
      const first = discussion.messages[0]!;
      await client.query(`INSERT INTO stash_discussion_messages (id, discussion_id, content, author_account_id, created_at)
        VALUES ($1,$2,$3,$4,$5)`, [first.id, discussion.id, first.content, first.author.localAccountId, first.createdAt]);
      const projection = this.portableDiscussion(discussion);
      await this.hooks.recordProjection(client, "Discussion", discussion.id, projection.schema, projection);
      await this.recordDiscussionMentionNotifications(client, memberId, discussion, first);
      return { status: "created" as const, discussion, projection };
    });
  }


  async findDiscussion(memberId: string, discussionId: string) {
    return this.kernel.withSession(async (client) => {
      await this.ensureDiscussionSchema(client);
      const discussion = await this.readDiscussion(client, memberId, discussionId, false);
      return discussion ? { status: "found" as const, discussion } : { status: "not_found" as const };
    });
  }


  async listNoteDiscussions(memberId: string, noteId: string) {
    return this.kernel.withSession(async (client) => {
      await this.ensureDiscussionSchema(client);
      const access = await this.authorizeNote(client, memberId, noteId);
      if (access === "none") return { status: "not_found" as const };
      const ids = await client.query<{ id: string }>("SELECT id FROM stash_discussions WHERE note_id = $1 ORDER BY created_at, id", [noteId]);
      const discussions: DiscussionRecord[] = [];
      for (const { id } of ids.rows) {
        const discussion = await this.readDiscussion(client, memberId, id, false);
        if (discussion) discussions.push(discussion);
      }
      return { status: "found" as const, access, discussions };
    });
  }


  async listTaskDiscussions(memberId: string, taskId: string) {
    return this.kernel.withSession(async (client) => {
      await this.ensureDiscussionSchema(client);
      const access = await client.query<{ can_write: boolean }>(`SELECT ((workspace.owner_type = 'personal' AND workspace.personal_owner_id = $2) OR EXISTS (
          SELECT 1 FROM stash_organization_memberships membership WHERE membership.organization_id = workspace.organization_owner_id
            AND membership.account_id = $2)) AS can_write FROM stash_tasks task JOIN stash_workspaces workspace ON workspace.id = task.workspace_id
        WHERE task.id = $1 AND (((workspace.owner_type = 'personal' AND workspace.personal_owner_id = $2) OR EXISTS (
          SELECT 1 FROM stash_organization_memberships membership WHERE membership.organization_id = workspace.organization_owner_id
            AND membership.account_id = $2)) OR EXISTS (
          SELECT 1 FROM stash_project_guests guest WHERE guest.project_id = task.project_id AND guest.account_id = $2))`, [taskId, memberId]);
      if (!access.rowCount) return { status: "not_found" as const };
      const ids = await client.query<{ id: string }>("SELECT id FROM stash_discussions WHERE task_id = $1 ORDER BY created_at, id", [taskId]);
      const discussions: DiscussionRecord[] = [];
      for (const { id } of ids.rows) {
        const discussion = await this.readDiscussion(client, memberId, id, false);
        if (discussion) discussions.push(discussion);
      }
      return { status: "found" as const, access: access.rows[0]!.can_write ? "edit" as const : "read" as const, discussions };
    });
  }


  async listBlockDiscussions(memberId: string, noteId: string, blockKey: string) {
    return this.kernel.withSession(async (client) => {
      await this.ensureDiscussionSchema(client);
      const access = await this.authorizeNote(client, memberId, noteId);
      if (access === "none") return { status: "not_found" as const };
      const note = await client.query<any>("SELECT document FROM stash_notes WHERE id = $1", [noteId]);
      if (!note.rowCount) return { status: "not_found" as const };
      const blocks = Array.isArray(note.rows[0].document?.blocks) ? note.rows[0].document.blocks as Array<{ blockKey?: string; id?: string }> : [];
      const matches = blocks.filter((block) => block.blockKey === blockKey);
      if (matches.length !== 1 || typeof matches[0]!.id !== "string"
        || blocks.filter((block) => block.id === matches[0]!.id).length !== 1) return { status: "not_found" as const };
      const ids = await client.query<{ id: string }>(`SELECT id FROM stash_discussions
        WHERE target_kind = 'block' AND note_id = $1 AND block_id = $2 ORDER BY created_at, id`, [noteId, matches[0]!.id]);
      const discussions: DiscussionRecord[] = [];
      for (const { id } of ids.rows) {
        const discussion = await this.readDiscussion(client, memberId, id, false);
        if (discussion?.target.kind === "block") discussions.push(discussion);
      }
      return { status: "found" as const, access, discussions };
    });
  }


  async addMessage(memberId: string, discussionId: string, message: DiscussionMessage) {
    return this.kernel.transaction(async (client) => {
      await this.ensureDiscussionSchema(client);
      const discussion = await this.readDiscussion(client, memberId, discussionId, true);
      if (!discussion) return { status: "not_found" as const };
      if (!await this.canWriteDiscussion(client, memberId, discussion.workspaceId)) return { status: "forbidden" as const };
      if (discussion.resolvedAt) return { status: "resolved" as const };
      await client.query(`INSERT INTO stash_discussion_messages (id, discussion_id, content, author_account_id, created_at)
        VALUES ($1,$2,$3,$4,$5)`, [message.id, discussionId, message.content, message.author.localAccountId, message.createdAt]);
      discussion.messages.push(message);
      const projection = this.portableDiscussion(discussion);
      await this.hooks.recordProjection(client, "Discussion", discussionId, projection.schema, projection);
      await this.recordDiscussionMentionNotifications(client, memberId, discussion, message);
      return { status: "updated" as const, discussion, projection };
    });
  }


  async resolveDiscussion(memberId: string, discussionId: string, resolvedAt: string) {
    return this.kernel.transaction(async (client) => {
      await this.ensureDiscussionSchema(client);
      const discussion = await this.readDiscussion(client, memberId, discussionId, true);
      if (!discussion) return { status: "not_found" as const };
      if (!await this.canWriteDiscussion(client, memberId, discussion.workspaceId)) return { status: "forbidden" as const };
      if (discussion.resolvedAt) return { status: "already_resolved" as const, discussion };
      await client.query("UPDATE stash_discussions SET resolved_at = $2 WHERE id = $1", [discussionId, resolvedAt]);
      discussion.resolvedAt = resolvedAt;
      const projection = this.portableDiscussion(discussion);
      await this.hooks.recordProjection(client, "Discussion", discussionId, projection.schema, projection);
      return { status: "resolved" as const, discussion, projection };
    });
  }


  async createWorkFromMessages(memberId: string, discussionId: string, draft: CreateDiscussionWorkDraft): Promise<DiscussionWorkOutcome> {
    return this.kernel.transaction(async (client) => {
      await this.ensureDiscussionSchema(client);
      const discussion = await this.readDiscussion(client, memberId, discussionId, true);
      if (!discussion) return { status: "not_found" as const };
      if (!await this.canWriteDiscussion(client, memberId, discussion.workspaceId)) return { status: "forbidden" as const };
      await client.query("SELECT pg_advisory_xact_lock(hashtext($1), hashtext($2))", [memberId, draft.idempotencyKey]);
      const fingerprint = createHash("sha256").update(JSON.stringify({ discussionId, kind: draft.kind,
        messageIds: draft.messageIds, ...(draft.kind === "task" ? { projectId: draft.projectId, title: draft.title } : {}) })).digest("hex");
      const receipt = await client.query<{ fingerprint: string; outcome: DiscussionWorkOutcome }>(
        "SELECT fingerprint, outcome FROM stash_discussion_work_receipts WHERE account_id = $1 AND idempotency_key = $2 FOR UPDATE",
        [memberId, draft.idempotencyKey],
      );
      if (receipt.rows[0]) return receipt.rows[0].fingerprint === fingerprint
        ? { ...(receipt.rows[0].outcome as Extract<DiscussionWorkOutcome, { status: "created" }>), status: "duplicate" as const }
        : { status: "idempotency_conflict" as const };
      const selectedIds = new Set(draft.messageIds);
      const selectedMessages = discussion.messages.filter(({ id }) => selectedIds.has(id));
      if (selectedMessages.length !== draft.messageIds.length) return { status: "message_not_found" as const };

      let work: Extract<DiscussionWorkOutcome, { status: "created" }>["work"];
      let workProjection: { schema: "stash.note.v1" | "stash.task.v1" };
      if (draft.kind === "note") {
        const content = selectedMessages.map(({ content }) => content).join("\n\n");
        const document = paragraphDocument(content, randomUUID());
        await client.query(`INSERT INTO stash_notes
          (id, workspace_id, project_id, content, document, revision, tags, reminder_at, created_by_account_id, created_at)
          VALUES ($1,$2,NULL,$3,$4::jsonb,1,'[]'::jsonb,NULL,$5,$6)`,
        [draft.workId, discussion.workspaceId, content, JSON.stringify(document), memberId, draft.createdAt]);
        await this.hooks.recordInitialNoteLocation(client, draft.workId, discussion.workspaceId);
        const projection = { schema: "stash.note.v1" as const, id: draft.workId, workspaceId: discussion.workspaceId,
          content, tags: [], createdAt: draft.createdAt, createdBy: draft.createdBy };
        await this.hooks.recordProjection(client, "Note", draft.workId, projection.schema, projection);
        await this.recordNoteRevisionAndActivity(client, memberId, undefined, { id: draft.workId, workspaceId: discussion.workspaceId,
          content, document, revision: 1, tags: [], createdByMemberId: memberId,
          createdAt: draft.createdAt }, "note_created", { kind: "member" });
        work = { kind: "note", id: draft.workId, workspaceId: discussion.workspaceId, content,
          source: { discussionId, messageIds: selectedMessages.map(({ id }) => id) } };
        workProjection = { schema: projection.schema };
      } else {
        const project = await client.query("SELECT 1 FROM stash_projects WHERE id = $1 AND workspace_id = $2", [draft.projectId, discussion.workspaceId]);
        if (!project.rowCount) return { status: "project_forbidden" as const };
        const projection = await this.createTask(client, { id: draft.workId, workspaceId: discussion.workspaceId,
          projectId: draft.projectId, title: draft.title, sourceNoteIds: [], createdAt: draft.createdAt, createdBy: draft.createdBy });
        await client.query("INSERT INTO stash_tasks (id, workspace_id, project_id, task_key, workflow_status_id, title, created_by_account_id, created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)",
          [projection.id, projection.workspaceId, projection.projectId, projection.key, projection.status.id, projection.title, memberId, projection.createdAt]);
        await this.hooks.recordProjection(client, "Task", projection.id, projection.schema, projection);
        work = { kind: "task", id: projection.id, workspaceId: projection.workspaceId, projectId: projection.projectId,
          title: projection.title, key: projection.key, source: { discussionId, messageIds: selectedMessages.map(({ id }) => id) } };
        workProjection = { schema: projection.schema };
      }
      const link: PortableDiscussionWorkLinkProjection = { schema: "stash.discussion-work-link.v1", id: draft.linkId,
        workspaceId: discussion.workspaceId, discussionId, work: { kind: work.kind, id: work.id },
        selectedMessages, createdAt: draft.createdAt, createdBy: draft.createdBy };
      await client.query(`INSERT INTO stash_discussion_work_links
        (id, discussion_id, work_kind, note_id, task_id, selected_message_ids, created_by_account_id, created_at)
        VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7,$8)`, [draft.linkId, discussionId, work.kind,
        work.kind === "note" ? work.id : null, work.kind === "task" ? work.id : null,
        JSON.stringify(link.selectedMessages.map(({ id }) => id)), memberId, draft.createdAt]);
      await this.hooks.recordProjection(client, "DiscussionWorkLink", link.id, link.schema, link);
      const activity: DiscussionWorkActivity = { schema: "stash.activity.v1", id: randomUUID(), workspaceId: discussion.workspaceId,
        action: "discussion_work_created", object: { kind: work.kind === "note" ? "Note" : "Task", id: work.id },
        actor: draft.createdBy, cause: { kind: "member" }, occurredAt: draft.createdAt,
        before: { discussionId, selectedMessageIds: selectedMessages.map(({ id }) => id) }, after: work };
      await client.query(`INSERT INTO stash_workspace_activity
        (id, workspace_id, object_kind, object_id, action, actor_account_id, cause, occurred_at, before_state, after_state)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10::jsonb)`, [activity.id, activity.workspaceId,
        activity.object.kind, activity.object.id, activity.action, memberId, activity.cause.kind, activity.occurredAt,
        JSON.stringify(activity.before), JSON.stringify(activity.after)]);
      await this.hooks.recordProjection(client, "Activity", activity.id, activity.schema, activity);
      await this.activityNotifications.recordProjectActivityNotifications(client, activity);
      const outcome = { status: "created" as const, work, activity, projections: [workProjection, link, activity] };
      await client.query("INSERT INTO stash_discussion_work_receipts (account_id,idempotency_key,fingerprint,outcome) VALUES ($1,$2,$3,$4::jsonb)",
        [memberId, draft.idempotencyKey, fingerprint, JSON.stringify(outcome)]);
      return outcome;
    });
  }


  private async ensureDiscussionSchema(client: PostgresQueryable): Promise<void> {
    await this.hooks.prepare(client);
    await client.query(`CREATE TABLE IF NOT EXISTS stash_discussions (
      id UUID PRIMARY KEY, workspace_id UUID NOT NULL REFERENCES stash_workspaces(id),
      target_kind TEXT NOT NULL CHECK (target_kind IN ('note','block','task')),
      note_id UUID REFERENCES stash_notes(id), block_id UUID, task_id UUID REFERENCES stash_tasks(id),
      created_at TIMESTAMPTZ NOT NULL, resolved_at TIMESTAMPTZ,
      CHECK ((target_kind = 'note' AND note_id IS NOT NULL AND block_id IS NULL AND task_id IS NULL)
        OR (target_kind = 'block' AND note_id IS NOT NULL AND block_id IS NOT NULL AND task_id IS NULL)
        OR (target_kind = 'task' AND note_id IS NULL AND block_id IS NULL AND task_id IS NOT NULL))
    )`);
    await client.query(`CREATE TABLE IF NOT EXISTS stash_discussion_messages (
      id UUID PRIMARY KEY, discussion_id UUID NOT NULL REFERENCES stash_discussions(id) ON DELETE CASCADE,
      content TEXT NOT NULL CHECK (char_length(content) BETWEEN 1 AND 20000),
      author_account_id UUID NOT NULL REFERENCES stash_accounts(id), created_at TIMESTAMPTZ NOT NULL
    )`);
    await client.query(`CREATE TABLE IF NOT EXISTS stash_discussion_work_links (
      id UUID PRIMARY KEY, discussion_id UUID NOT NULL REFERENCES stash_discussions(id) ON DELETE RESTRICT,
      work_kind TEXT NOT NULL CHECK (work_kind IN ('note','task')),
      note_id UUID REFERENCES stash_notes(id) ON DELETE RESTRICT, task_id UUID REFERENCES stash_tasks(id) ON DELETE RESTRICT,
      selected_message_ids JSONB NOT NULL, created_by_account_id UUID NOT NULL REFERENCES stash_accounts(id), created_at TIMESTAMPTZ NOT NULL,
      CHECK ((work_kind = 'note' AND note_id IS NOT NULL AND task_id IS NULL)
        OR (work_kind = 'task' AND note_id IS NULL AND task_id IS NOT NULL))
    )`);
    await client.query(`CREATE TABLE IF NOT EXISTS stash_discussion_work_receipts (
      account_id UUID NOT NULL REFERENCES stash_accounts(id), idempotency_key UUID NOT NULL,
      fingerprint TEXT NOT NULL, outcome JSONB NOT NULL, PRIMARY KEY (account_id, idempotency_key)
    )`);
  }

  async prepareDiscussions(client: PostgresQueryable): Promise<void> {
    await this.ensureDiscussionSchema(client);
  }


  private async readDiscussion(client: PostgresQueryable, memberId: string, discussionId: string, lock: boolean): Promise<DiscussionRecord | undefined> {
    const result = await client.query<any>(`SELECT discussion.*, note.document FROM stash_discussions discussion
      LEFT JOIN stash_notes note ON note.id = discussion.note_id
      WHERE discussion.id = $1${lock ? " FOR UPDATE OF discussion" : ""}`, [discussionId]);
    const row = result.rows[0];
    if (!row) return undefined;
    if (row.target_kind === "note" || row.target_kind === "block") {
      if (await this.authorizeNote(client, memberId, row.note_id) === "none") return undefined;
    } else {
      const taskAccess = await client.query(`SELECT 1 FROM stash_tasks task JOIN stash_workspaces workspace ON workspace.id=task.workspace_id
        WHERE task.id=$1 AND ((workspace.owner_type='personal' AND workspace.personal_owner_id=$2) OR EXISTS (
          SELECT 1 FROM stash_organization_memberships membership WHERE membership.organization_id=workspace.organization_owner_id
            AND membership.account_id=$2) OR EXISTS (
          SELECT 1 FROM stash_project_guests guest WHERE guest.project_id=task.project_id AND guest.account_id=$2))`, [row.task_id, memberId]);
      if (!taskAccess.rowCount) return undefined;
    }
    const messages = await client.query<any>(`SELECT message.id, message.content, message.created_at,
      account.id AS author_id, account.name AS author_name FROM stash_discussion_messages message
      JOIN stash_accounts account ON account.id = message.author_account_id
      WHERE message.discussion_id = $1 ORDER BY message.created_at, message.id`, [discussionId]);
    let target: DiscussionTarget;
    if (row.target_kind === "task") target = { kind: "task", taskId: row.task_id };
    else if (row.target_kind === "note") target = { kind: "note", noteId: row.note_id };
    else {
      const matches = Array.isArray(row.document?.blocks)
        ? row.document.blocks.filter((block: { id?: string }) => block.id === row.block_id).length : 0;
      target = { kind: "block", noteId: row.note_id, blockId: row.block_id,
        state: matches === 1 ? "attached" : matches > 1 ? "ambiguous" : "block_missing" };
    }
    return { id: row.id, workspaceId: row.workspace_id, target,
      messages: messages.rows.map((message: any) => ({ id: message.id, content: message.content,
        author: { localAccountId: message.author_id, displayName: message.author_name },
        createdAt: new Date(message.created_at).toISOString() })),
      createdAt: new Date(row.created_at).toISOString(), ...(row.resolved_at ? { resolvedAt: new Date(row.resolved_at).toISOString() } : {}) };
  }


  private async canWriteDiscussion(client: PostgresQueryable, memberId: string, workspaceId: string): Promise<boolean> {
    const result = await client.query(`SELECT 1 FROM stash_workspaces workspace WHERE workspace.id = $1
      AND ((workspace.owner_type = 'personal' AND workspace.personal_owner_id = $2) OR
        (workspace.owner_type = 'organization' AND EXISTS (SELECT 1 FROM stash_organization_memberships membership
          WHERE membership.organization_id = workspace.organization_owner_id AND membership.account_id = $2)))`,
    [workspaceId, memberId]);
    return result.rowCount === 1;
  }


  private portableDiscussion(discussion: DiscussionRecord): PortableDiscussionProjection {
    const target: PortableDiscussionTarget = discussion.target.kind === "block"
      ? { kind: "block", noteId: discussion.target.noteId, blockId: discussion.target.blockId }
      : discussion.target;
    return { schema: "stash.discussion.v1", id: discussion.id, workspaceId: discussion.workspaceId,
      target, messages: discussion.messages, createdAt: discussion.createdAt,
      ...(discussion.resolvedAt ? { resolvedAt: discussion.resolvedAt } : {}) };
  }


  async searchWorkspace(memberId: string, workspaceId: string, query: WorkspaceSearchQuery) {
    return this.kernel.withSession(async (client) => {
      await this.prepareDiscussions(client);
      await this.hooks.prepareAttachments(client);
      await this.hooks.prepareInvitations(client);
      const access = await client.query<{ full_member: boolean; requested_project_visible: boolean }>(`SELECT
        ((workspace.owner_type='personal' AND workspace.personal_owner_id=$2) OR
         (workspace.owner_type='organization' AND EXISTS (SELECT 1 FROM stash_organization_memberships membership
           WHERE membership.organization_id=workspace.organization_owner_id AND membership.account_id=$2))) AS full_member,
        ($3::uuid IS NULL OR EXISTS (SELECT 1 FROM stash_projects requested_project
          WHERE requested_project.id=$3 AND requested_project.workspace_id=workspace.id AND
            (((workspace.owner_type='personal' AND workspace.personal_owner_id=$2) OR
              (workspace.owner_type='organization' AND EXISTS (SELECT 1 FROM stash_organization_memberships membership
                WHERE membership.organization_id=workspace.organization_owner_id AND membership.account_id=$2)))
             OR EXISTS (SELECT 1 FROM stash_project_guests guest
                WHERE guest.project_id=requested_project.id AND guest.account_id=$2)))) AS requested_project_visible
        FROM stash_workspaces workspace WHERE workspace.id=$1 AND (((workspace.owner_type='personal' AND workspace.personal_owner_id=$2) OR
         (workspace.owner_type='organization' AND EXISTS (SELECT 1 FROM stash_organization_memberships membership
           WHERE membership.organization_id=workspace.organization_owner_id AND membership.account_id=$2))) OR EXISTS (
             SELECT 1 FROM stash_projects project JOIN stash_project_guests guest ON guest.project_id=project.id
             WHERE project.workspace_id=workspace.id AND guest.account_id=$2))`, [workspaceId, memberId, query.projectId ?? null]);
      if (!access.rowCount || !access.rows[0]!.requested_project_visible) return { status: "forbidden" as const };
      const values = [workspaceId, memberId, query.q, query.projectId ?? null, query.object ?? null, query.author ?? null,
        query.assignee ?? null, query.status ?? null, query.from ?? null, query.to ?? null, access.rows[0]!.full_member];
      const rows = await client.query<any>(`WITH visible_projects AS (
          SELECT project.id FROM stash_projects project JOIN stash_workspaces workspace ON workspace.id=project.workspace_id
          WHERE project.workspace_id=$1 AND ($11::boolean OR EXISTS (SELECT 1 FROM stash_project_guests guest
            WHERE guest.project_id=project.id AND guest.account_id=$2))
        ), candidates AS (
          SELECT note.id::text, 'note'::text AS kind, split_part(note.content,E'\\n',1) AS title,
            left(note.content,240) AS excerpt, '/app/notes/'||note.id AS href, note.project_id,
            author.name AS author, NULL::text AS assignee, CASE WHEN note.archived_at IS NULL THEN 'active' ELSE 'archived' END AS status,
            note.created_at AS occurred_at, note.content AS searchable
          FROM stash_notes note JOIN stash_accounts author ON author.id=note.created_by_account_id
          WHERE note.workspace_id=$1 AND (($11 AND note.project_id IS NULL) OR note.project_id IN (SELECT id FROM visible_projects))
          UNION ALL
          SELECT task.id::text,'task',CASE WHEN association.task_key IS NULL THEN task.title ELSE association.task_key||' · '||task.title END,
            task.title,'/app/tasks/'||task.id,association.project_id,
            author.name, (SELECT string_agg(account.name,', ' ORDER BY account.name) FROM stash_accounts account
              WHERE task.assignee_ids ? account.id::text), COALESCE(workspace_status.name,status.name), task.created_at,
            concat_ws(' ',association.task_key,task.task_key,task.title,task.label_names::text,task.development_links::text,
              (SELECT string_agg(visible_key,' ') FROM (
                SELECT active.task_key visible_key FROM stash_task_projects active
                  WHERE active.task_id=task.id AND active.project_id IN(SELECT id FROM visible_projects)
                UNION SELECT alias.task_key FROM stash_task_key_aliases alias
                  WHERE alias.task_id=task.id AND alias.project_id IN(SELECT id FROM visible_projects)
              ) visible_keys))
          FROM stash_tasks task JOIN stash_accounts author ON author.id=task.created_by_account_id
          LEFT JOIN stash_workflow_statuses status ON status.id=task.workflow_status_id
          LEFT JOIN stash_workspace_workflow_statuses workspace_status ON workspace_status.id=task.workspace_workflow_status_id
          LEFT JOIN LATERAL (SELECT link.project_id,link.task_key FROM stash_task_projects link
            WHERE link.task_id=task.id AND link.project_id IN(SELECT id FROM visible_projects)
              AND ($4::uuid IS NULL OR link.project_id=$4) ORDER BY link.project_id LIMIT 1) association ON TRUE
          WHERE task.workspace_id=$1 AND ($11 OR association.project_id IS NOT NULL)
          UNION ALL
          SELECT discussion.id::text,'discussion',left(message.content,120),left(message.content,240),
            CASE discussion.target_kind WHEN 'task' THEN '/app/tasks/'||discussion.task_id||'/discussions' ELSE '/app/notes/'||discussion.note_id||'/discussions' END,
            COALESCE(note.project_id,task.project_id),author.name,NULL,CASE WHEN discussion.resolved_at IS NULL THEN 'open' ELSE 'resolved' END,
            message.created_at,message.content
          FROM stash_discussions discussion JOIN stash_discussion_messages message ON message.discussion_id=discussion.id
          JOIN stash_accounts author ON author.id=message.author_account_id LEFT JOIN stash_notes note ON note.id=discussion.note_id
          LEFT JOIN stash_tasks task ON task.id=discussion.task_id WHERE discussion.workspace_id=$1
            AND ($11 OR COALESCE(note.project_id,task.project_id) IN (SELECT id FROM visible_projects))
          UNION ALL
          SELECT attachment.id::text,'file',attachment.filename,attachment.content_type,attachment.relative_path,NULL,
            author.name,NULL,NULL,attachment.created_at,attachment.filename||' '||attachment.content_type
          FROM stash_attachments attachment JOIN stash_accounts author ON author.id=attachment.created_by_account_id
          WHERE attachment.workspace_id=$1 AND $11
          UNION ALL
          SELECT task.id::text||':'||label.value,'label',label.value,NULL,'/app/projects/'||task.project_id||'/tasks/'||task.task_key,task.project_id,
            NULL,NULL,status.name,task.created_at,label.value
          FROM stash_tasks task CROSS JOIN LATERAL jsonb_array_elements_text(task.label_names) label(value)
          JOIN stash_workflow_statuses status ON status.id=task.workflow_status_id
          WHERE task.workspace_id=$1 AND task.project_id IN (SELECT id FROM visible_projects)
          UNION ALL
          SELECT account.id::text,'member',account.name,account.email,NULL,NULL,account.name,NULL,NULL,NULL,
            account.name||' '||account.email FROM stash_accounts account JOIN stash_organization_memberships membership ON membership.account_id=account.id
          JOIN stash_workspaces workspace ON workspace.organization_owner_id=membership.organization_id WHERE workspace.id=$1 AND $11
          UNION ALL
          SELECT task.id::text||':'||development.ordinality,'development',COALESCE(development.value->>'label',development.value->>'url'),
            development.value->>'url',development.value->>'url',task.project_id,author.name,NULL,status.name,task.created_at,development.value::text
          FROM stash_tasks task CROSS JOIN LATERAL jsonb_array_elements(task.development_links) WITH ORDINALITY development(value,ordinality)
          JOIN stash_accounts author ON author.id=task.created_by_account_id JOIN stash_workflow_statuses status ON status.id=task.workflow_status_id
          WHERE task.workspace_id=$1 AND task.project_id IN (SELECT id FROM visible_projects)
        ), filtered AS (
          SELECT id,kind,title,excerpt,href,project_id,author,assignee,status,occurred_at FROM candidates
          WHERE searchable ILIKE '%'||$3||'%' AND ($4::uuid IS NULL OR project_id=$4) AND ($5::text IS NULL OR kind=$5)
            AND ($6::text IS NULL OR author ILIKE '%'||$6||'%') AND ($7::text IS NULL OR assignee ILIKE '%'||$7||'%')
            AND ($8::text IS NULL OR status ILIKE $8) AND ($9::timestamptz IS NULL OR occurred_at >= $9)
            AND ($10::timestamptz IS NULL OR occurred_at <= $10)
        ), page AS (
          SELECT * FROM filtered ORDER BY occurred_at DESC NULLS LAST, kind, title LIMIT 100
        ) SELECT
          COALESCE((SELECT jsonb_agg(to_jsonb(page) ORDER BY occurred_at DESC NULLS LAST,kind,title) FROM page),'[]'::jsonb) AS results,
          (SELECT count(*)::integer FROM filtered) AS total,
          COALESCE((SELECT jsonb_agg(jsonb_build_object('value',kind,'count',count) ORDER BY kind)
            FROM (SELECT kind,count(*)::integer AS count FROM filtered GROUP BY kind) facet),'[]'::jsonb) AS kind_facets,
          COALESCE((SELECT jsonb_agg(jsonb_build_object('value',project_id,'count',count) ORDER BY project_id)
            FROM (SELECT project_id,count(*)::integer AS count FROM filtered WHERE project_id IS NOT NULL GROUP BY project_id) facet),'[]'::jsonb) AS project_facets,
          COALESCE((SELECT jsonb_agg(jsonb_build_object('value',status,'count',count) ORDER BY status)
            FROM (SELECT status,count(*)::integer AS count FROM filtered WHERE status IS NOT NULL GROUP BY status) facet),'[]'::jsonb) AS status_facets`, values);
      const envelope = rows.rows[0]!;
      return { status: "found" as const, results: envelope.results.map((row: any): WorkspaceSearchResult => ({ id: row.id, kind: row.kind,
        title: row.title, ...(row.excerpt ? { excerpt: row.excerpt } : {}), ...(row.href ? { href: row.href } : {}),
        ...(row.project_id ? { projectId: row.project_id } : {}), ...(row.author ? { author: row.author } : {}),
        ...(row.assignee ? { assignee: row.assignee } : {}), ...(row.status ? { status: row.status } : {}),
        ...(row.occurred_at ? { occurredAt: new Date(row.occurred_at).toISOString() } : {}) })), total: envelope.total,
        facets: { kinds: envelope.kind_facets as WorkspaceSearchFacet<WorkspaceSearchKind>[],
          projects: envelope.project_facets as WorkspaceSearchFacet[], statuses: envelope.status_facets as WorkspaceSearchFacet[] } };
    });
  }


  async listWorkspaceActivity(memberId: string, workspaceId: string) {
    return this.kernel.withSession(async (client) => {
      await this.hooks.prepareHistory(client);
      await this.hooks.backfillLegacyNoteHistory(client);
      const permitted = await client.query(`SELECT 1 FROM stash_workspaces workspace WHERE workspace.id=$1 AND
        ((workspace.owner_type='personal' AND workspace.personal_owner_id=$2) OR
         (workspace.owner_type='organization' AND EXISTS (SELECT 1 FROM stash_organization_memberships membership
           WHERE membership.organization_id=workspace.organization_owner_id AND membership.account_id=$2)))`, [workspaceId, memberId]);
      if (!permitted.rowCount) return { status: "forbidden" as const };
      const rows = await client.query<any>(`SELECT activity.*, actor.name AS actor_name FROM stash_workspace_activity activity
        JOIN stash_accounts actor ON actor.id=activity.actor_account_id WHERE activity.workspace_id=$1
        ORDER BY activity.occurred_at DESC, activity.id DESC`, [workspaceId]);
      return { status: "found" as const, activities: rows.rows.map((row): ActivityRecord => ({ schema: "stash.activity.v1",
        id: row.id, workspaceId: row.workspace_id, object: { kind: row.object_kind, id: row.object_id }, action: row.action,
        actor: { localAccountId: row.actor_account_id, displayName: row.actor_name }, cause: this.hooks.parseActivityCause(row.cause),
        occurredAt: new Date(row.occurred_at).toISOString(), before: row.before_state, after: row.after_state })) };
    });
  }


  async listNoteHistory(memberId: string, noteId: string) {
    return this.kernel.withSession(async (client) => {
      await this.hooks.prepareHistory(client);
      await this.hooks.backfillLegacyNoteHistory(client);
      const access = await this.authorizeNote(client, memberId, noteId);
      if (access === "none") return { status: "not_found" as const };
      const rows = await client.query<any>(`SELECT history.*, actor.name AS actor_name FROM stash_note_history history
        JOIN stash_accounts actor ON actor.id=history.actor_account_id
        WHERE history.note_id=$1 ORDER BY history.revision`, [noteId]);
      return { status: "found" as const, access, revisions: rows.rows.map((row): NoteHistoryRevision => ({ noteId: row.note_id,
        workspaceId: row.workspace_id, revision: Number(row.revision), content: row.content, document: row.document,
        recordedAt: new Date(row.recorded_at).toISOString(), actor: { localAccountId: row.actor_account_id, displayName: row.actor_name },
        cause: this.hooks.parseActivityCause(row.cause) })) };
    });
  }


  async restoreNote(memberId: string, noteId: string, targetRevision: number, expectedRevision: number, idempotencyKey: string) {
    return this.kernel.transaction(async (client) => {
      await this.hooks.prepareHistory(client);
      await this.hooks.backfillLegacyNoteHistory(client);
      if (await this.authorizeNote(client, memberId, noteId) !== "edit") return { status: "not_found" as const };
      await client.query("SELECT pg_advisory_xact_lock(hashtext($1), hashtext($2))", [noteId, idempotencyKey]);
      const found = await client.query<any>(`SELECT note.*, creator.name AS creator_name FROM stash_notes note
        JOIN stash_accounts creator ON creator.id=note.created_by_account_id
        WHERE note.id=$1 FOR UPDATE OF note`, [noteId]);
      const row = found.rows[0];
      if (!row) return { status: "not_found" as const };
      const receipt = await client.query<any>(`SELECT receipt.target_revision, receipt.activity_id, receipt.restore_result, activity.*, actor.name AS actor_name
        FROM stash_note_restore_receipts receipt JOIN stash_workspace_activity activity ON activity.id=receipt.activity_id
        JOIN stash_accounts actor ON actor.id=activity.actor_account_id WHERE receipt.note_id=$1 AND receipt.idempotency_key=$2`, [noteId, idempotencyKey]);
      if (receipt.rows[0]) {
        if (Number(receipt.rows[0].target_revision) !== targetRevision) return { status: "idempotency_conflict" as const };
        const row = receipt.rows[0];
        return { status: "duplicate" as const, note: row.restore_result,
          activity: { schema: "stash.activity.v1", id: row.activity_id, workspaceId: row.workspace_id,
            object: { kind: row.object_kind, id: row.object_id }, action: row.action,
            actor: { localAccountId: row.actor_account_id, displayName: row.actor_name }, cause: this.hooks.parseActivityCause(row.cause),
            occurredAt: new Date(row.occurred_at).toISOString(), before: row.before_state, after: row.after_state } as ActivityRecord };
      }
      if (Number(row.revision) !== expectedRevision) return { status: "revision_conflict" as const, currentRevision: Number(row.revision) };
      const target = await client.query<any>("SELECT content,document FROM stash_note_history WHERE note_id=$1 AND revision=$2", [noteId, targetRevision]);
      if (!target.rows[0]) return { status: "revision_not_found" as const };
      const before: NoteRecord = { id: row.id, workspaceId: row.workspace_id, content: row.content, document: row.document,
        revision: Number(row.revision), tags: row.tags, createdByMemberId: row.created_by_account_id,
        createdAt: new Date(row.created_at).toISOString(), ...(row.project_id ? { projectId: row.project_id } : {}),
        ...(row.reminder_at ? { reminder: { at: new Date(row.reminder_at).toISOString() } } : {}),
        ...(row.archived_at ? { archivedAt: new Date(row.archived_at).toISOString() } : {}) };
      const note = { ...before, revision: before.revision + 1, content: target.rows[0].content, document: target.rows[0].document };
      await client.query("UPDATE stash_notes SET content=$2,document=$3::jsonb,revision=$4 WHERE id=$1", [noteId, note.content, JSON.stringify(note.document), note.revision]);
      const projection = { schema: "stash.note.v2" as const, note: (({ createdByMemberId: _, ...publicNote }) => publicNote)(note),
        createdBy: { localAccountId: row.created_by_account_id, displayName: row.creator_name } };
      await this.hooks.recordProjection(client, "Note", noteId, "stash.note.v2", projection);
      const activity = await this.recordNoteRevisionAndActivity(client, memberId, before, note, "note_restored",
        { kind: "member", restorationOfRevision: targetRevision });
      const restoreResult = { revision: note.revision, content: note.content, document: note.document };
      await client.query("INSERT INTO stash_note_restore_receipts (note_id,idempotency_key,target_revision,activity_id,restore_result) VALUES ($1,$2,$3,$4,$5::jsonb)",
        [noteId, idempotencyKey, targetRevision, activity.id, JSON.stringify(restoreResult)]);
      return { status: "restored" as const, note: restoreResult, activity };
    });
  }


  async findPortableMemberIdentity(memberId: string): Promise<PortableIdentity | undefined> {
    return this.kernel.withSession(async (client) => {
      await this.hooks.prepareBootstrap(client);
      const result = await client.query<{ id: string; name: string }>(
        "SELECT id, name FROM stash_accounts WHERE id = $1",
        [memberId],
      );
      const member = result.rows[0];
      return member
        ? { localAccountId: member.id, displayName: member.name }
        : undefined;
    });
  }


  async findWorkspaceImport(importId: string) {
    return this.kernel.withSession(async (client) => {
      await this.hooks.prepareImports(client);
      const found = await client.query<{ archive_sha256: string; report: PortableWorkspaceImportReport }>(
        "SELECT archive_sha256,report FROM stash_workspace_imports WHERE import_id=$1", [importId]);
      return found.rows[0] ? { archiveSha256: found.rows[0].archive_sha256, report: found.rows[0].report } : undefined;
    });
  }


  async importWorkspace(importId: string, bundle: PortableWorkspaceImportBundle) {
    return this.kernel.transaction(async (client) => {
      await this.hooks.prepareImports(client);
      await this.hooks.prepareInstanceSetup(client);
      await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`workspace-import:${importId}`]);
      const receipt = await client.query<{ archive_sha256: string; report: PortableWorkspaceImportReport }>(
        "SELECT archive_sha256,report FROM stash_workspace_imports WHERE import_id=$1", [importId]);
      if (receipt.rows[0]) return receipt.rows[0].archive_sha256 === bundle.archiveSha256
        ? { status: "duplicate" as const, report: receipt.rows[0].report } : { status: "workspace_conflict" as const };
      const owner = await client.query<{name:string}>("SELECT name FROM stash_accounts WHERE id=$1", [bundle.destinationOwnerAccountId]);
      if (!owner.rowCount) return { status: "forbidden" as const };
      const state = bundle.state;
      if ((await client.query("SELECT 1 FROM stash_workspaces WHERE id=$1", [state.workspace.id])).rowCount)
        return { status: "workspace_conflict" as const };
      const identityAccounts = new Map<string, string>();
      for (const identity of bundle.identityStubs) {
        const existing = await client.query<{ account_id: string; mapped_to_account_id: string | null }>(
          "SELECT account_id,mapped_to_account_id FROM stash_identity_stubs WHERE source_account_id=$1", [identity.sourceAccountId]);
        const accountId = existing.rows[0]?.account_id ?? randomUUID();
        if (!existing.rows[0]) {
          await client.query("INSERT INTO stash_accounts(id,name,email,password_hash) VALUES($1,$2,$3,$4)", [accountId, identity.displayName,
            `identity-stub+${accountId}@invalid`, this.hooks.encryptSecret(randomUUID())]);
          await client.query("INSERT INTO stash_identity_stubs(source_account_id,account_id,display_name) VALUES($1,$2,$3)",
            [identity.sourceAccountId, accountId, identity.displayName]);
        }
        // A mapping is an explicit Instance-level decision and therefore also
        // applies to later imports carrying the same portable source identity.
        identityAccounts.set(identity.sourceAccountId, existing.rows[0]?.mapped_to_account_id ?? accountId);
      }
      const accountFor = (identity: { localAccountId: string }) => identityAccounts.get(identity.localAccountId)!;
      await client.query(`INSERT INTO stash_workspaces(id,name,owner_type,personal_owner_id,created_by_account_id)
        VALUES($1,$2,'personal',$3,$4)`, [state.workspace.id, state.workspace.name, bundle.destinationOwnerAccountId, accountFor(state.workspace.createdBy)]);
      const importedWorkspace: PortableWorkspaceProjection = {...state.workspace,owner:{type:"personal",identity:{localAccountId:bundle.destinationOwnerAccountId,displayName:owner.rows[0]!.name}}};
      await this.hooks.recordProjection(client, "Workspace", state.workspace.id, importedWorkspace.schema, importedWorkspace);
      const durable = state.durableObjects.map((item) => ({ ...item, payload: item.payload as any }));
      for (const item of durable.filter(({ kind }) => kind === "Project")) {
        const project = item.payload;
        await client.query("INSERT INTO stash_projects(id,workspace_id,name,project_key,created_by_account_id,workflow_revision) VALUES($1,$2,$3,$4,$5,$6)",
          [project.id, state.workspace.id, project.name, project.key, accountFor(project.createdBy), 0]);
        await this.hooks.recordProjection(client, "Project", item.id, item.schema as any, project);
      }
      for (const item of durable.filter(({ kind }) => kind === "Project")) if (item.payload.parentProjectId)
        await client.query("UPDATE stash_projects SET parent_project_id=$2 WHERE id=$1", [item.id,item.payload.parentProjectId]);
      for (const item of durable.filter(({ kind }) => kind === "Workflow")) {
        const workflow = item.payload as ProjectWorkflow;
        await client.query("UPDATE stash_projects SET workflow_revision=$2 WHERE id=$1", [workflow.projectId, workflow.revision]);
        for (const status of workflow.statuses) await client.query(`INSERT INTO stash_workflow_statuses
          (id,project_id,name,category,position,archived) VALUES($1,$2,$3,$4,$5,$6)`,
        [status.id, workflow.projectId, status.name, status.category, status.position, status.archived]);
        await this.hooks.recordProjection(client, "Workflow", item.id, item.schema as any, workflow);
      }
      for (const item of durable.filter(({ kind }) => kind === "WorkspaceWorkflow")) {
        const workflow = item.payload;
        for (const status of workflow.statuses) await client.query(`INSERT INTO stash_workspace_workflow_statuses
          (id,workspace_id,name,category,position) VALUES($1,$2,$3,$4,$5)`,
        [status.id, state.workspace.id, status.name, status.category, status.position]);
        await this.hooks.recordProjection(client, "WorkspaceWorkflow", item.id, item.schema as any, workflow);
      }
      for (const note of state.notes) {
        const history = state.noteHistory.filter((revision) => revision.noteId === note.id).sort((a,b) => a.revision-b.revision);
        const latest = history.at(-1); const location = state.noteLocations.find(({ noteId }) => noteId === note.id)!;
        const document = structuredClone(latest?.document ?? markdownToRichText(note.content));
        const view = durable.find(({ kind, payload }) => kind === "ViewBlock" && payload.ownerNoteId === note.id)?.payload;
        if (view && !document.blocks.some(({ id }: any) => id === view.blockId)) document.blocks.push({ type: "paragraph",
          blockKey: randomUUID(), id: view.blockId, content: [{ text: `View: ${view.title}` }] });
        await client.query(`INSERT INTO stash_notes(id,workspace_id,project_id,content,document,revision,tags,reminder_at,
          created_by_account_id,created_at,portable_path,location_revision) VALUES($1,$2,$3,$4,$5::jsonb,$6,$7::jsonb,$8,$9,$10,$11,$12)`,
        [note.id,state.workspace.id,note.projectId ?? null,note.content,JSON.stringify(document),
          latest?.revision ?? 1,JSON.stringify(note.tags),note.reminder?.at ?? null,accountFor(note.createdBy),note.createdAt,location.path,location.revision]);
        for (const alias of location.aliases) await client.query("INSERT INTO stash_note_path_aliases(workspace_id,note_id,path) VALUES($1,$2,$3)",
          [state.workspace.id,note.id,alias]);
        await this.hooks.recordProjection(client,"Note",note.id,note.schema,note);
        await this.hooks.recordProjection(client,"NoteLocation",note.id,location.schema,location);
      }
      await this.hooks.applyImportedLocations(client, state.noteLocations);
      for (const item of durable.filter(({ kind }) => kind === "Collection")) {
        const collection=item.payload; await client.query("INSERT INTO stash_collections(id,workspace_id,owner_note_id,title) VALUES($1,$2,$3,$4)",
          [collection.id,state.workspace.id,collection.ownerNoteId,collection.title]);
        for(const property of collection.properties) { const configuration=property.type==="single_select"||property.type==="multi_select"?{options:property.options}
          :property.type==="relation"?{target:property.target}:{};
          await client.query("INSERT INTO stash_collection_properties(id,collection_id,name,property_type,configuration,position) VALUES($1,$2,$3,$4,$5::jsonb,$6)",
            [property.id,collection.id,property.name,property.type,JSON.stringify(configuration),property.position]); }
        for(const record of collection.records){await client.query("INSERT INTO stash_collection_records(id,collection_id,position) VALUES($1,$2,$3)",[record.id,collection.id,record.position]);
          for(const [propertyId,value] of Object.entries(record.values))await client.query("INSERT INTO stash_collection_record_values(record_id,property_id,value) VALUES($1,$2,$3::jsonb)",[record.id,propertyId,JSON.stringify(value)]);}
        await this.hooks.recordProjection(client,"Collection",item.id,item.schema as any,collection);
      }
      for (const item of durable.filter(({ kind }) => kind === "ViewBlock")) {
        const view=item.payload; await client.query(`INSERT INTO stash_view_blocks(id,workspace_id,owner_note_id,block_id,title,source_kind,source_workspace_id,
          source_collection_id,source_project_scope,query,layout,definition) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,NULL,$10,$11::jsonb)`,
        [view.id,state.workspace.id,view.ownerNoteId,view.blockId,view.title,view.definition.source.kind,
          view.definition.source.kind==="tasks"?view.definition.source.workspaceId:null,
          view.definition.source.kind==="collection"?view.definition.source.collectionId:null,
          view.definition.source.kind==="tasks"?"none":null,view.definition.presentation,JSON.stringify(view.definition)]);
        await this.hooks.recordProjection(client,"ViewBlock",item.id,item.schema as any,view);
      }
      await this.hooks.importContributedPortableObjects(client, durable, state.workspace.id);
      for (const task of state.tasks) {
        await client.query(`INSERT INTO stash_tasks(id,workspace_id,project_id,task_key,workflow_status_id,workspace_workflow_status_id,title,description,parent_task_id,created_by_account_id,created_at,
          assignee_ids,former_assignee_ids,priority,label_names,due_date,estimate,linked_note_ids,development_links)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8,NULL,$9,$10,$11::jsonb,$12::jsonb,$13,$14::jsonb,$15,$16,$17::jsonb,$18::jsonb)`,
        [task.id,state.workspace.id,task.projectId??null,task.key??null,task.projectId?task.status.id:null,task.projectId?null:task.status.id,task.title,(task as any).description??"",accountFor(task.createdBy),task.createdAt,
          JSON.stringify(task.assigneeIds ?? []),JSON.stringify(task.formerAssigneeIds ?? []),task.priority ?? "none",
          JSON.stringify(task.labelNames ?? []),task.dueDate ?? null,task.estimate ?? null,
          JSON.stringify(task.linkedNoteIds ?? []),JSON.stringify(task.developmentLinks ?? [])]);
        for (const noteId of task.sourceNoteIds) await client.query("INSERT INTO stash_task_note_sources(task_id,note_id) VALUES($1,$2)",[task.id,noteId]);
        for (const source of task.sourceBlocks ?? []) await client.query("INSERT INTO stash_task_block_sources(task_id,note_id,block_id) VALUES($1,$2,$3)",[task.id,source.noteId,source.blockId]);
        for (const alias of task.keyAliases ?? []) await client.query("INSERT INTO stash_task_key_aliases(project_id,task_key,task_id) VALUES($1,$2,$3)",[alias.projectId,alias.key,task.id]);
        for (const association of (task as any).projectKeys ?? []) await client.query(
          "INSERT INTO stash_task_projects(task_id,project_id,task_key) VALUES($1,$2,$3) ON CONFLICT DO NOTHING",
          [task.id,association.projectId,association.key]);
        await this.hooks.recordProjection(client,"Task",task.id,task.schema,task);
      }
      for (const task of state.tasks) if ((task as any).parentTaskId) await client.query(
        "UPDATE stash_tasks SET parent_task_id=$2 WHERE id=$1", [task.id,(task as any).parentTaskId]);
      for (const task of state.tasks) for (const edge of task.dependencies ?? []) if (edge.type === "depends_on")
        await client.query("INSERT INTO stash_task_dependencies(dependent_task_id,prerequisite_task_id) VALUES($1,$2) ON CONFLICT DO NOTHING",[task.id,edge.taskId]);
      for (const project of durable.filter(({ kind }) => kind === "Project").map(({ id }) => id)) {
        const numbers = state.tasks.flatMap((task) => [
          ...(task.projectId === project && task.key ? [task.key] : []),
          ...(((task as any).projectKeys ?? []).filter((entry: any) => entry.projectId === project).map((entry: any) => entry.key)),
          ...((task.keyAliases ?? []).filter((entry) => entry.projectId === project).map((entry) => entry.key)),
        ]).map((key) => Number(key.slice(key.lastIndexOf("-") + 1)))
          .filter(Number.isSafeInteger);
        await client.query("UPDATE stash_projects SET next_task_number=$2 WHERE id=$1",[project,Math.max(0,...numbers)+1]);
      }
      for (const board of state.boards) { await client.query("INSERT INTO stash_boards(id,project_id,name,group_by,created_at) VALUES($1,$2,$3,$4,$5)",
        [board.id,board.projectId,board.name,board.groupBy,board.createdAt]); await this.hooks.recordProjection(client,"Board",board.id,board.schema,board); }
      for (const attachment of state.attachments) {
        await client.query(`INSERT INTO stash_attachments(id,workspace_id,filename,content_type,byte_size,relative_path,storage_key,source,created_by_account_id,created_at)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,[attachment.id,state.workspace.id,attachment.filename,attachment.contentType,attachment.size,
          attachment.relativePath,bundle.attachmentStorageKeys.get(attachment.id),attachment.source,accountFor(attachment.createdBy),attachment.createdAt]);
        await this.hooks.recordProjection(client,"Attachment",attachment.id,attachment.schema,attachment);
      }
      for (const link of state.noteLinks) { await client.query(`INSERT INTO stash_note_links(id,workspace_id,source_note_id,target_note_id,target_path,candidate_note_ids,label,revision)
        VALUES($1,$2,$3,$4,$5,$6::uuid[],$7,$8)`,[link.id,state.workspace.id,link.sourceNoteId,link.targetNoteId ?? null,
        "targetPath" in link ? link.targetPath : null,"candidateNoteIds" in link ? link.candidateNoteIds : [],"label" in link ? link.label : "Note",
        "revision" in link ? link.revision : 1]);
        await this.hooks.recordProjection(client,"NoteLink",link.id,link.schema,link); }
      await this.hooks.applyImportedRelationships(client, state.noteLinks);
      for (const revision of state.noteHistory) await client.query(`INSERT INTO stash_note_history(note_id,workspace_id,revision,content,document,actor_account_id,cause,recorded_at)
        VALUES($1,$2,$3,$4,$5::jsonb,$6,$7,$8)`,[revision.noteId,state.workspace.id,revision.revision,revision.content,JSON.stringify(revision.document),
        accountFor(revision.actor),JSON.stringify(revision.cause),revision.recordedAt]);
      for (const activity of state.activities) { await client.query(`INSERT INTO stash_workspace_activity(id,workspace_id,object_kind,object_id,action,actor_account_id,cause,occurred_at,before_state,after_state)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10::jsonb)`,[activity.id,state.workspace.id,activity.object.kind,activity.object.id,activity.action,
        accountFor(activity.actor),JSON.stringify(activity.cause),activity.occurredAt,JSON.stringify(activity.before),JSON.stringify(activity.after)]);
        await this.hooks.recordProjection(client,"Activity",activity.id,activity.schema,activity); }
      for (const item of durable.filter(({ kind }) => kind === "Discussion")) {
        const discussion = item.payload as PortableDiscussionProjection; const target = discussion.target;
        await client.query(`INSERT INTO stash_discussions(id,workspace_id,target_kind,note_id,block_id,task_id,created_at,resolved_at)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8)`,[discussion.id,state.workspace.id,target.kind,
          target.kind === "note" || target.kind === "block" ? target.noteId : null,target.kind === "block" ? target.blockId : null,
          target.kind === "task" ? target.taskId : null,discussion.createdAt,discussion.resolvedAt ?? null]);
        for (const message of discussion.messages) await client.query(`INSERT INTO stash_discussion_messages(id,discussion_id,content,author_account_id,created_at)
          VALUES($1,$2,$3,$4,$5)`,[message.id,discussion.id,message.content,accountFor(message.author),message.createdAt]);
      }
      for (const item of durable.filter(({ kind }) => kind === "DiscussionWorkLink")) {
        const link = item.payload as PortableDiscussionWorkLinkProjection;
        await client.query(`INSERT INTO stash_discussion_work_links(id,discussion_id,work_kind,note_id,task_id,selected_message_ids,created_by_account_id,created_at)
          VALUES($1,$2,$3,$4,$5,$6::jsonb,$7,$8)`,[link.id,link.discussionId,link.work.kind,link.work.kind === "note" ? link.work.id : null,
          link.work.kind === "task" ? link.work.id : null,JSON.stringify(link.selectedMessages.map(({ id }) => id)),accountFor(link.createdBy),link.createdAt]);
      }
      for (const item of durable.filter(({ kind }) => kind === "GuestProjectAccess")) {
        const access = item.payload as any; const guestAccount = accountFor(access.guest);
        for (const project of access.projects) await client.query("INSERT INTO stash_project_guests(project_id,account_id) VALUES($1,$2) ON CONFLICT DO NOTHING",
          [project.projectId,guestAccount]);
      }
      const integrationTransformations: ImportTransformation[] = [];
      for (const item of durable.filter(({kind})=>kind==="RepositoryConnection")) {
        const source=item.payload as any; const disconnected=source.schema==="stash.disconnected-repository-connection.v1"?source:{...source,
          schema:"stash.disconnected-repository-connection.v1",state:"disconnected",reason:"credentials_not_portable"};
        await client.query(`INSERT INTO stash_disconnected_repository_connections(id,workspace_id,payload) VALUES($1,$2,$3::jsonb)`,
          [item.id,state.workspace.id,JSON.stringify(disconnected)]);
        await this.hooks.recordProjection(client,"RepositoryConnection",item.id,disconnected.schema,disconnected);
        integrationTransformations.push({kind:source.schema===disconnected.schema?"skipped":"transformed",object:`RepositoryConnection:${item.id}`,
          reason:source.schema===disconnected.schema?"already_disconnected":"credentials_not_portable"});
      }
      for (const item of durable.filter(({ kind }) => !["Project","Workflow","WorkspaceWorkflow","Collection","ViewBlock","RepositoryConnection"].includes(kind)))
        await this.hooks.recordProjection(client,item.kind as any,item.id,item.schema as any,item.payload);
      const ownership: ImportTransformation = {kind:"transformed",object:`Workspace:${state.workspace.id}`,
        reason:`ownership_mapped:${bundle.destinationOwnerAccountId}`};
      const transformations: ImportTransformation[] = [ownership,...(bundle.transformations ?? []),...bundle.identityStubs.map((identity) => ({ kind:"transformed" as const,
        object:`Identity:${identity.sourceAccountId}`,reason:"identity_stub_created" })),...integrationTransformations];
      const report: PortableWorkspaceImportReport = { schema:"stash.portable-workspace-import-report.v1",importId,
        workspaceId:state.workspace.id,archiveSha256:bundle.archiveSha256,identityStubs:bundle.identityStubs,
        transformations,transformed:transformations.filter(({kind})=>kind==="transformed"),skipped:transformations.filter(({kind})=>kind==="skipped"),
        ambiguous:transformations.filter(({kind})=>kind==="ambiguous") };
      await client.query("INSERT INTO stash_workspace_imports(import_id,archive_sha256,workspace_id,report) VALUES($1,$2,$3,$4::jsonb)",
        [importId,bundle.archiveSha256,state.workspace.id,JSON.stringify(report)]);
      return { status:"imported" as const,report };
    });
  }


  async mapImportedIdentity(input: { importId:string; sourceAccountId:string; localAccountId:string; idempotencyKey:string }) {
    return this.kernel.transaction(async(client)=>{
      await this.hooks.prepareImports(client); await client.query("SELECT pg_advisory_xact_lock(hashtext($1))",[`identity-map:${input.idempotencyKey}`]);
      const prior=await client.query<any>("SELECT * FROM stash_identity_mapping_receipts WHERE idempotency_key=$1",[input.idempotencyKey]);
      if(prior.rows[0]) return prior.rows[0].import_id===input.importId&&prior.rows[0].source_account_id===input.sourceAccountId&&prior.rows[0].local_account_id===input.localAccountId
        ?{status:"duplicate" as const,sourceAccountId:input.sourceAccountId,localAccountId:input.localAccountId}:{status:"conflict" as const};
      const imported=await client.query<{workspace_id:string;report:PortableWorkspaceImportReport}>("SELECT workspace_id,report FROM stash_workspace_imports WHERE import_id=$1",[input.importId]);
      if(!imported.rows[0] || !imported.rows[0].report.identityStubs.some(({sourceAccountId})=>sourceAccountId===input.sourceAccountId))
        return {status:"not_found" as const};
      const workspaceId=imported.rows[0].workspace_id;
      const local=await client.query<{name:string}>("SELECT name FROM stash_accounts WHERE id=$1",[input.localAccountId]);
      if(!local.rows[0]) return {status:"local_account_not_found" as const};
      const stub=await client.query<{account_id:string;mapped_to_account_id:string|null}>("SELECT account_id,mapped_to_account_id FROM stash_identity_stubs WHERE source_account_id=$1 FOR UPDATE",[input.sourceAccountId]);
      if(!stub.rows[0]) return {status:"not_found" as const};
      if(stub.rows[0].mapped_to_account_id&&stub.rows[0].mapped_to_account_id!==input.localAccountId) return {status:"conflict" as const};
      const stubId=stub.rows[0].account_id;
      for(const table of ["stash_workspaces","stash_projects","stash_notes","stash_tasks","stash_attachments"])
        await client.query(`UPDATE ${table} SET created_by_account_id=$1 WHERE created_by_account_id=$2 AND ${table==="stash_workspaces"?"id":"workspace_id"}=$3`,[input.localAccountId,stubId,workspaceId]);
      await client.query("UPDATE stash_note_history SET actor_account_id=$1 WHERE actor_account_id=$2 AND workspace_id=$3",[input.localAccountId,stubId,workspaceId]);
      await client.query("UPDATE stash_workspace_activity SET actor_account_id=$1 WHERE actor_account_id=$2 AND workspace_id=$3",[input.localAccountId,stubId,workspaceId]);
      await client.query(`UPDATE stash_discussion_messages message SET author_account_id=$1 FROM stash_discussions discussion
        WHERE message.discussion_id=discussion.id AND message.author_account_id=$2 AND discussion.workspace_id=$3`,[input.localAccountId,stubId,workspaceId]);
      await client.query(`UPDATE stash_discussion_work_links link SET created_by_account_id=$1 FROM stash_discussions discussion
        WHERE link.discussion_id=discussion.id AND link.created_by_account_id=$2 AND discussion.workspace_id=$3`,[input.localAccountId,stubId,workspaceId]);
      await client.query(`INSERT INTO stash_project_guests(project_id,account_id) SELECT guest.project_id,$1 FROM stash_project_guests guest
        JOIN stash_projects project ON project.id=guest.project_id WHERE guest.account_id=$2 AND project.workspace_id=$3 ON CONFLICT DO NOTHING`,[input.localAccountId,stubId,workspaceId]);
      await client.query(`DELETE FROM stash_project_guests guest USING stash_projects project WHERE guest.project_id=project.id
        AND guest.account_id=$1 AND project.workspace_id=$2`,[stubId,workspaceId]);
      const projects=await client.query<{id:string}>("SELECT id FROM stash_projects WHERE workspace_id=$1",[workspaceId]); const projectIds=new Set(projects.rows.map(({id})=>id));
      const projections=await client.query<any>("SELECT object_kind,object_id,revision,payload FROM stash_portable_projection_outbox");
      const replace=(value:unknown):unknown=>{ if(Array.isArray(value)) return value.map(replace); if(value&&typeof value==="object") { const record=value as Record<string,unknown>;
        const mapped=record.localAccountId===input.sourceAccountId&&typeof record.displayName==="string"?{...record,localAccountId:input.localAccountId,displayName:local.rows[0]!.name}:record;
        return Object.fromEntries(Object.entries(mapped).map(([key,child])=>[key,replace(child)])); } return value; };
      for(const row of projections.rows) { const payload=row.payload as any; const belongs=payload.id===workspaceId||payload.workspaceId===workspaceId||projectIds.has(payload.projectId)
        ||Array.isArray(payload.projectIds)&&payload.projectIds.some((id:string)=>projectIds.has(id))||Array.isArray(payload.projects)&&payload.projects.some((p:any)=>p.workspaceId===workspaceId);
        if(belongs&&JSON.stringify(payload).includes(input.sourceAccountId)) await client.query(`UPDATE stash_portable_projection_outbox SET payload=$4::jsonb
          WHERE object_kind=$1 AND object_id=$2 AND revision=$3`,[row.object_kind,row.object_id,row.revision,JSON.stringify(replace(payload))]); }
      const disconnected=await client.query<{id:string;payload:unknown}>("SELECT id,payload FROM stash_disconnected_repository_connections WHERE workspace_id=$1",[workspaceId]);
      for(const connection of disconnected.rows) if(JSON.stringify(connection.payload).includes(input.sourceAccountId))
        await client.query("UPDATE stash_disconnected_repository_connections SET payload=$2::jsonb WHERE id=$1",[connection.id,JSON.stringify(replace(connection.payload))]);
      await client.query("UPDATE stash_identity_stubs SET mapped_to_account_id=$2,mapped_at=now() WHERE source_account_id=$1",[input.sourceAccountId,input.localAccountId]);
      await client.query("INSERT INTO stash_identity_mapping_receipts(idempotency_key,import_id,source_account_id,local_account_id) VALUES($1,$2,$3,$4)",
        [input.idempotencyKey,input.importId,input.sourceAccountId,input.localAccountId]);
      return {status:"mapped" as const,sourceAccountId:input.sourceAccountId,localAccountId:input.localAccountId};
    });
  }


  async readExportSnapshot(memberId: string, workspaceId: string): Promise<
    { status: "found"; snapshot: PortableWorkspaceExportSnapshot }
    | { status: "workspace_forbidden" | "workspace_not_found" }
  > {
    // Schema preparation is deliberately outside the read-only snapshot transaction.
    await this.kernel.withSession(async (setup) => {
      await this.hooks.prepare(setup);
      await this.hooks.prepareHistory(setup);
      await this.hooks.backfillLegacyNoteHistory(setup);
      await this.hooks.prepareAttachments(setup);
      await this.hooks.prepareInvitations(setup);
      await this.hooks.prepareBoards(setup);
      await this.hooks.prepareContributedPortableObjects(setup);
    });

    return this.kernel.readOnlySnapshot(async (client) => {
      const access = await client.query<{ member: boolean; guest_project_ids: string[]; workspace_projection: PortableWorkspaceProjection | null }>(
        `SELECT
          ((workspace.owner_type = 'personal' AND workspace.personal_owner_id = $2)
            OR (workspace.owner_type = 'organization' AND EXISTS (
              SELECT 1 FROM stash_organization_memberships membership
              WHERE membership.organization_id = workspace.organization_owner_id AND membership.account_id = $2))) AS member,
          ARRAY(SELECT project.id FROM stash_projects project JOIN stash_project_guests guest ON guest.project_id = project.id
            WHERE project.workspace_id = workspace.id AND guest.account_id = $2 ORDER BY project.id) AS guest_project_ids,
          projection.payload AS workspace_projection
        FROM stash_workspaces workspace
        LEFT JOIN LATERAL (SELECT payload FROM stash_portable_projection_outbox
          WHERE object_kind = 'Workspace' AND object_id = workspace.id ORDER BY revision DESC LIMIT 1) projection ON TRUE
        WHERE workspace.id = $1`, [workspaceId, memberId]);
      const permission = access.rows[0];
      if (!permission) return { status: "workspace_not_found" };
      const guestProjectIds = permission.guest_project_ids ?? [];
      if (!permission.member && guestProjectIds.length === 0) return { status: "workspace_forbidden" };
      if (!permission.workspace_projection) throw new Error("workspace_projection_unavailable");

      const notes = await client.query<{ id: string; payload: PortableNoteProjection | PortableNoteStateProjection | null }>(
        `SELECT note.id, projection.payload FROM stash_notes note
         JOIN stash_workspaces workspace ON workspace.id=note.workspace_id
         LEFT JOIN LATERAL (SELECT payload FROM stash_portable_projection_outbox
           WHERE object_kind = 'Note' AND object_id = note.id ORDER BY revision DESC LIMIT 1) projection ON TRUE
         WHERE note.workspace_id = $1 AND ($2::boolean OR ${effectiveNoteReadSql("note", "workspace", "$3")})
         ORDER BY note.id`, [workspaceId, permission.member, memberId]);
      if (notes.rows.some(({ payload }) => !payload)) throw new Error("portable_projection_unavailable");
      const noteProjections = notes.rows.map(({ payload }) => portableExportNoteProjection(payload!));
      const visibleNoteIds = new Set(noteProjections.map(({ id }) => id));
      const noteLocations = await client.query<{ note_id: string; payload: PortableNoteLocationProjection | null }>(
        `SELECT note.id AS note_id, projection.payload FROM stash_notes note
         LEFT JOIN LATERAL (SELECT payload FROM stash_portable_projection_outbox
           WHERE object_kind='NoteLocation' AND object_id=note.id ORDER BY revision DESC LIMIT 1) projection ON TRUE
         WHERE note.workspace_id=$1 AND note.id=ANY($2::uuid[]) ORDER BY note.id`,
      [workspaceId, [...visibleNoteIds]]);
      const noteLinks = await client.query<{ id: string; payload: PortableNoteLinkStateProjection | PortableNoteLinkProjection | null }>(
        `SELECT link.id, projection.payload FROM stash_note_links link
         JOIN stash_notes source ON source.id=link.source_note_id
         LEFT JOIN stash_notes target ON target.id=link.target_note_id
         LEFT JOIN LATERAL (SELECT payload FROM stash_portable_projection_outbox
           WHERE object_kind='NoteLink' AND object_id=link.id ORDER BY revision DESC LIMIT 1) projection ON TRUE
         WHERE link.workspace_id=$1 AND ($2::boolean OR
           (link.source_note_id=ANY($3::uuid[]) AND link.target_note_id IS NOT NULL AND link.target_note_id=ANY($3::uuid[]))) ORDER BY link.id`,
      [workspaceId, permission.member, [...visibleNoteIds]]);
      const tasks = await client.query<{ id: string; payload: PortableExportTaskProjection | null }>(
        `SELECT task.id, projection.payload FROM stash_tasks task
         LEFT JOIN LATERAL (SELECT payload FROM stash_portable_projection_outbox
           WHERE object_kind = 'Task' AND object_id = task.id ORDER BY revision DESC LIMIT 1) projection ON TRUE
         WHERE task.workspace_id = $1 AND ($2::boolean OR task.project_id = ANY($3::uuid[]) OR EXISTS(
           SELECT 1 FROM stash_task_projects association WHERE association.task_id=task.id AND association.project_id=ANY($3::uuid[])))
         ORDER BY task.id`, [workspaceId, permission.member, guestProjectIds]);
      const boards = await client.query<{ id: string; payload: Board | null }>(
        `SELECT board.id, projection.payload FROM stash_boards board
         JOIN stash_projects project ON project.id = board.project_id
         LEFT JOIN LATERAL (SELECT payload FROM stash_portable_projection_outbox
           WHERE object_kind = 'Board' AND object_id = board.id ORDER BY revision DESC LIMIT 1) projection ON TRUE
         WHERE project.workspace_id = $1 AND ($2::boolean OR board.project_id = ANY($3::uuid[]))
         ORDER BY board.id`, [workspaceId, permission.member, guestProjectIds]);
      const attachments = await client.query<{ id: string; storage_key: string; payload: PortableAttachmentProjection | null }>(
        `SELECT attachment.id, attachment.storage_key, projection.payload FROM stash_attachments attachment
         LEFT JOIN LATERAL (SELECT payload FROM stash_portable_projection_outbox
           WHERE object_kind = 'Attachment' AND object_id = attachment.id ORDER BY revision DESC LIMIT 1) projection ON TRUE
         WHERE attachment.workspace_id = $1 AND ($2::boolean OR EXISTS (
           SELECT 1 FROM stash_notes note WHERE note.workspace_id = attachment.workspace_id
             AND note.id = ANY($3::uuid[])
             AND (strpos(note.content, attachment.relative_path) > 0
               OR strpos(note.content, replace(attachment.relative_path, '%', '%25')) > 0)))
         ORDER BY attachment.id`, [workspaceId, permission.member, [...visibleNoteIds]]);
      const activities = permission.member ? await client.query<{ payload: ActivityRecord }>(`SELECT projection.payload
        FROM stash_workspace_activity activity JOIN LATERAL (SELECT payload FROM stash_portable_projection_outbox
          WHERE object_kind='Activity' AND object_id=activity.id ORDER BY revision DESC LIMIT 1) projection ON TRUE
        WHERE activity.workspace_id=$1 ORDER BY activity.occurred_at,activity.id`, [workspaceId]) : { rows: [] };
      const histories = await client.query<any>(`SELECT history.*, actor.name AS actor_name,
        COALESCE(stub.source_account_id,history.actor_account_id::text) AS portable_actor_id FROM stash_note_history history
        JOIN stash_accounts actor ON actor.id=history.actor_account_id LEFT JOIN stash_identity_stubs stub ON stub.account_id=actor.id
        JOIN stash_notes note ON note.id=history.note_id
        WHERE history.workspace_id=$1 AND note.id=ANY($2::uuid[])
        ORDER BY history.note_id,history.revision`, [workspaceId, [...visibleNoteIds]]);
      const durableObjects = await client.query<{ object_kind: string; object_id: string; projection_schema: string; payload: unknown }>(
        `SELECT DISTINCT ON (projection.object_kind, projection.object_id)
           projection.object_kind,projection.object_id,projection.projection_schema,projection.payload
         FROM stash_portable_projection_outbox projection
         WHERE projection.object_kind IN ('Project','Workflow','WorkspaceWorkflow','Collection','ViewBlock','GuestProjectAccess','RepositoryConnection','Discussion','DiscussionWorkLink')
           AND (
             (projection.object_kind='Project' AND projection.payload->>'workspaceId'=$1::text
               AND ($2::boolean OR projection.object_id=ANY($3::uuid[])))
             OR (projection.object_kind='Workflow'
               AND (projection.payload->>'projectId')::uuid IN (SELECT id FROM stash_projects WHERE workspace_id=$1::uuid)
               AND ($2::boolean OR (projection.payload->>'projectId')::uuid=ANY($3::uuid[])))
             OR (projection.object_kind IN ('WorkspaceWorkflow','Collection','ViewBlock')
               AND projection.payload->>'workspaceId'=$1::text AND $2::boolean)
             OR (projection.object_kind='GuestProjectAccess' AND $2::boolean AND EXISTS (
               SELECT 1 FROM jsonb_array_elements(projection.payload->'projects') selected
               WHERE selected->>'workspaceId'=$1::text))
             OR (projection.object_kind IN ('Discussion','DiscussionWorkLink') AND projection.payload->>'workspaceId'=$1::text
               AND $2::boolean)
             OR (projection.object_kind='RepositoryConnection' AND $2::boolean AND EXISTS (
               SELECT 1 FROM jsonb_array_elements_text(projection.payload->'projectIds') project_id
               WHERE project_id::uuid IN (SELECT id FROM stash_projects WHERE workspace_id=$1::uuid)))
           )
         ORDER BY projection.object_kind,projection.object_id,projection.revision DESC`,
        [workspaceId, permission.member, guestProjectIds]);
      if (notes.rows.some(({ payload }) => !payload) || tasks.rows.some(({ payload }) => !payload)
        || boards.rows.some(({ payload }) => !payload)
        || noteLocations.rows.some(({ payload }) => !payload) || noteLinks.rows.some(({ payload }) => !payload)
        || attachments.rows.some(({ payload }) => !payload)) throw new Error("portable_projection_unavailable");
      const taskProjections = tasks.rows.map(({ payload }) => payload!);
      const visibleTaskIds = new Set(taskProjections.map(({ id }) => id));
      const visibleProjectIds = new Set(guestProjectIds);
      const contributedDurable = await this.hooks.readContributedPortableObjects(
        client, { workspaceId, memberId, member: permission.member, visibleNoteIds },
      );
      const visibleTasks = permission.member ? taskProjections : taskProjections.map((payload) => ({
        ...payload,
        sourceNoteIds: payload.sourceNoteIds.filter((id) => visibleNoteIds.has(id)),
        ...(payload.sourceBlocks ? { sourceBlocks: payload.sourceBlocks.filter(({ noteId }) => visibleNoteIds.has(noteId)) } : {}),
        ...(payload.linkedNoteIds ? { linkedNoteIds: payload.linkedNoteIds.filter((id) => visibleNoteIds.has(id)) } : {}),
        ...(payload.dependencies ? { dependencies: payload.dependencies.filter(({ taskId }) => visibleTaskIds.has(taskId)) } : {}),
        ...(payload.keyAliases ? { keyAliases: payload.keyAliases.filter(({ projectId }) => visibleProjectIds.has(projectId)) } : {}),
      }));
      return { status: "found", snapshot: {
        workspace: permission.workspace_projection,
        notes: noteProjections,
        tasks: visibleTasks,
        boards: boards.rows.map(({ payload }) => payload!),
        attachments: attachments.rows.map(({ storage_key, payload }) => ({ storageKey: storage_key, projection: payload! })),
        noteLocations: noteLocations.rows.map(({ payload }) => payload!),
        noteLinks: noteLinks.rows.map(({ payload }) => payload!).map((payload) => "candidateNoteIds" in payload
          ? { ...payload, candidateNoteIds: payload.candidateNoteIds.filter((id) => visibleNoteIds.has(id)) } : payload),
        activities: activities.rows.map(({ payload }) => payload),
        noteHistory: histories.rows.map((row): NoteHistoryRevision => ({ noteId: row.note_id, workspaceId: row.workspace_id,
          revision: Number(row.revision), content: row.content, document: row.document, recordedAt: new Date(row.recorded_at).toISOString(),
          actor: { localAccountId: row.portable_actor_id, displayName: row.actor_name }, cause: this.hooks.parseActivityCause(row.cause) })),
        durableObjects: [...durableObjects.rows.map((row) => ({ kind: row.object_kind, id: row.object_id,
          schema: row.projection_schema, payload: row.payload })), ...contributedDurable],
      } };
    });
  }
}

function attachmentRecord(row: any): AttachmentRecord {
  return { id: row.id, workspaceId: row.workspace_id, filename: row.filename, contentType: row.content_type,
    size: Number(row.byte_size), relativePath: row.relative_path, storageKey: row.storage_key, source: row.source,
    createdByMemberId: row.created_by_account_id, createdAt: new Date(row.created_at).toISOString() };
}
