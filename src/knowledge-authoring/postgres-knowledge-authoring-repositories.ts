import type { ActivityCause, ActivityRecord, NoteHistoryRevision } from "../activity.js";
import { noteOperationDigest, type NoteConflictResolution, type NoteEditBatch, type NoteEditConflict } from "../notes.js";
import { createHash, randomUUID } from "node:crypto";
import type { NoteRecord, NoteRepository, NoteTriageChange, NoteTriageResult, PortableNoteProjection, PortableTaskProjection, TaskCreation } from "../notes.js";
import { paragraphDocument, richTextToMarkdown } from "../rich-text.js";
import { initialWorkflowStatus, type ProjectWorkflow, type WorkflowStatus } from "../project-workflows.js";
import type { CreateDiscussionWorkDraft, DiscussionDraft, DiscussionMessage, DiscussionRecord, DiscussionTarget, DiscussionWorkActivity, DiscussionWorkOutcome, PortableDiscussionProjection, PortableDiscussionTarget, PortableDiscussionWorkLinkProjection } from "../discussions.js";
import type { AttachmentRecord, PortableAttachmentProjection } from "../attachments.js";
import type { NoteLinkRecord, NoteLocationRecord, PortableNoteLinkStateProjection, PortableNoteLocationProjection } from "../note-links.js";
import * as Y from "yjs";
import { InvalidCollaborationUpdate, type CollaborationSnapshot } from "../note-collaboration.js";
import { collaborativeDocumentFromRichText, validatedRichTextFromCollaborativeDocument } from "./collaborative-document.js";
import type { WorkspaceSearchFacet, WorkspaceSearchKind, WorkspaceSearchQuery, WorkspaceSearchResult } from "../workspace-search.js";
import type { PostgresKernel, PostgresQueryable } from "../instance-operations/storage/postgres-kernel.js";

interface PostgresKnowledgeAuthoringHooks {
  prepare(client: PostgresQueryable): Promise<void>;
  prepareInvitations(client: PostgresQueryable): Promise<void>;
  prepareAttachments(client: PostgresQueryable): Promise<void>;
  backfillLegacyNoteHistory(client: PostgresQueryable): Promise<void>;
  parseActivityCause(value: string): ActivityCause;
  prepareHistory(client: PostgresQueryable): Promise<void>;
  prepareWorkspaceProjects(client: PostgresQueryable): Promise<void>;
  recordProjection(client: PostgresQueryable, kind: any, id: string, schema: any, projection: any): Promise<void>;
  authorizeNote(client: PostgresQueryable, memberId: string, noteId: string): Promise<"edit" | "read" | "none">;
  recordNoteRevisionAndActivity(client: PostgresQueryable, memberId: string, before: NoteRecord | undefined, after: NoteRecord,
    action: string, cause: ActivityCause): Promise<ActivityRecord>;
  recordInitialNoteLocation(client: PostgresQueryable, noteId: string, workspaceId: string): Promise<void>;
  recordDiscussionMentionNotifications(client: PostgresQueryable, memberId: string, discussion: DiscussionRecord, message: DiscussionMessage): Promise<void>;
  recordProjectActivityNotifications(client: PostgresQueryable, activity: any): Promise<void>;
  recordDomainActivity(client: PostgresQueryable, memberId: string, workspaceId: string, kind: any, objectId: string,
    action: string, before: object, after: object): Promise<void>;
  recordCreatedNote(
    client: PostgresQueryable,
    memberId: string,
    note: NoteRecord,
    projection: PortableNoteProjection,
    cause: ActivityCause,
  ): Promise<void>;
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

/** PostgreSQL implementation of the Knowledge Authoring persistence seam. */
export class PostgresKnowledgeAuthoringRepositories {
  constructor(private readonly kernel: PostgresKernel, private readonly hooks: PostgresKnowledgeAuthoringHooks) {}

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
    await this.hooks.recordDomainActivity(client, memberId, workspaceId, "Note", noteId, "note_organized",
      { projectId: before.rows[0]?.project_id ?? null, tags: before.rows[0]?.tags ?? [] }, { projectId: change.note.projectId, tags: change.note.tags });
    return { result: change };
  }

  private async archiveInboxNote(client: PostgresQueryable, memberId: string, workspaceId: string, noteId: string,
    change: Extract<NoteTriageChange, { kind: "archived" }>) {
    await client.query("UPDATE stash_notes SET archived_at=$2 WHERE id=$1", [noteId, change.note.archivedAt]);
    await this.hooks.recordDomainActivity(client, memberId, workspaceId, "Note", noteId, "note_archived", { archivedAt: null }, { archivedAt: change.note.archivedAt });
    return { result: change };
  }

  private async linkInboxNote(client: PostgresQueryable, memberId: string, workspaceId: string, noteId: string,
    change: Extract<NoteTriageChange, { kind: "linked" }>) {
    if (!(await client.query("SELECT 1 FROM stash_notes WHERE id=$1 AND workspace_id=$2", [change.link.targetNoteId, workspaceId])).rowCount)
      return { status: "target_note_not_found" as const };
    await client.query("INSERT INTO stash_note_links (id,workspace_id,source_note_id,target_note_id) VALUES ($1,$2,$3,$4)",
      [change.link.id, workspaceId, noteId, change.link.targetNoteId]);
    await this.hooks.recordDomainActivity(client, memberId, workspaceId, "NoteLink", change.link.id, "note_link_created", {}, change.link);
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
    await this.hooks.recordDomainActivity(client, memberId, workspaceId, "Task", task.id, "task_created_from_inbox", {}, task);
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
      await this.hooks.recordCreatedNote(client, memberId, note, projection, cause);
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
      await this.hooks.recordCreatedNote(client, memberId, note, projection, { kind: "member" });
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
    if (await this.hooks.authorizeNote(this.kernel, memberId, noteId) === "none") return undefined;
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
      await this.hooks.recordDomainActivity(client,memberId,current.workspaceId,"NoteLocation",noteId,"note_moved",current,location);
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
      await this.hooks.recordDomainActivity(client,memberId,saved.workspaceId,"NoteLink",saved.id,"note_link_created",{},saved);
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
      await this.hooks.recordDomainActivity(client,memberId,saved.workspaceId,"NoteLink",saved.id,"note_link_imported",{},saved);
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
      await this.hooks.recordDomainActivity(client,memberId,current.workspaceId,"NoteLink",linkId,"note_link_repaired",current,repaired);
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
      await this.hooks.recordNoteRevisionAndActivity(client, memberId, current, note, "note_edited", { kind: "member" });
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
      await this.hooks.recordNoteRevisionAndActivity(client, memberId, current, note,
        resolution === "apply_contribution" ? "note_conflict_contribution_applied" : "note_conflict_kept_current", { kind: "member" });
      return { status: "resolved" as const, note, projection: projectionFor(note) };
    });
  }


  async loadNoteCollaboration(memberId: string, noteId: string): Promise<CollaborationSnapshot | undefined> {
    return this.kernel.transaction(async (client) => {
      await this.ensureCollaborationSchema(client);
      const access = await this.hooks.authorizeNote(client, memberId, noteId);
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
      if (await this.hooks.authorizeNote(client, memberId, noteId) !== "edit") return undefined;
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
      await this.hooks.recordNoteRevisionAndActivity(client, memberId, before, note, "note_edited", { kind: "member" });
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
        const noteAccess = await this.hooks.authorizeNote(client, memberId, draft.target.noteId);
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
            await this.hooks.recordNoteRevisionAndActivity(client, memberId, before, noteFromRow(row),
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
      await this.hooks.recordDiscussionMentionNotifications(client, memberId, discussion, first);
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
      const access = await this.hooks.authorizeNote(client, memberId, noteId);
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
      const access = await this.hooks.authorizeNote(client, memberId, noteId);
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
      await this.hooks.recordDiscussionMentionNotifications(client, memberId, discussion, message);
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
        await this.hooks.recordNoteRevisionAndActivity(client, memberId, undefined, { id: draft.workId, workspaceId: discussion.workspaceId,
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
      await this.hooks.recordProjectActivityNotifications(client, activity);
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
      if (await this.hooks.authorizeNote(client, memberId, row.note_id) === "none") return undefined;
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
      const access = await this.hooks.authorizeNote(client, memberId, noteId);
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
      if (await this.hooks.authorizeNote(client, memberId, noteId) !== "edit") return { status: "not_found" as const };
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
      const activity = await this.hooks.recordNoteRevisionAndActivity(client, memberId, before, note, "note_restored",
        { kind: "member", restorationOfRevision: targetRevision });
      const restoreResult = { revision: note.revision, content: note.content, document: note.document };
      await client.query("INSERT INTO stash_note_restore_receipts (note_id,idempotency_key,target_revision,activity_id,restore_result) VALUES ($1,$2,$3,$4,$5::jsonb)",
        [noteId, idempotencyKey, targetRevision, activity.id, JSON.stringify(restoreResult)]);
      return { status: "restored" as const, note: restoreResult, activity };
    });
  }
}

function attachmentRecord(row: any): AttachmentRecord {
  return { id: row.id, workspaceId: row.workspace_id, filename: row.filename, contentType: row.content_type,
    size: Number(row.byte_size), relativePath: row.relative_path, storageKey: row.storage_key, source: row.source,
    createdByMemberId: row.created_by_account_id, createdAt: new Date(row.created_at).toISOString() };
}
