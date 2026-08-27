import type { ActivityCause } from "../activity.js";
import { noteOperationDigest, type NoteConflictResolution, type NoteEditBatch, type NoteEditConflict } from "../notes.js";
import { randomUUID } from "node:crypto";
import type { NoteRecord, NoteRepository, NoteTriageChange, NoteTriageResult, PortableNoteProjection, PortableTaskProjection, TaskCreation } from "../notes.js";
import { richTextToMarkdown } from "../rich-text.js";
import { initialWorkflowStatus, type ProjectWorkflow, type WorkflowStatus } from "../project-workflows.js";
import type { AttachmentRecord, PortableAttachmentProjection } from "../attachments.js";
import type { NoteLinkRecord, NoteLocationRecord, PortableNoteLinkStateProjection, PortableNoteLocationProjection } from "../note-links.js";
import * as Y from "yjs";
import { InvalidCollaborationUpdate, type CollaborationSnapshot } from "../note-collaboration.js";
import { collaborativeDocumentFromRichText, validatedRichTextFromCollaborativeDocument } from "./collaborative-document.js";
import type { PostgresKernel, PostgresQueryable } from "../instance-operations/storage/postgres-kernel.js";

interface PostgresKnowledgeAuthoringHooks {
  prepare(client: PostgresQueryable): Promise<void>;
  prepareInvitations(client: PostgresQueryable): Promise<void>;
  prepareAttachments(client: PostgresQueryable): Promise<void>;
  prepareHistory(client: PostgresQueryable): Promise<void>;
  prepareWorkspaceProjects(client: PostgresQueryable): Promise<void>;
  recordProjection(client: PostgresQueryable, kind: any, id: string, schema: any, projection: any): Promise<void>;
  authorizeNote(client: PostgresQueryable, memberId: string, noteId: string): Promise<"edit" | "read" | "none">;
  recordNoteRevisionAndActivity(client: PostgresQueryable, memberId: string, before: NoteRecord | undefined, after: NoteRecord,
    action: string, cause: ActivityCause): Promise<unknown>;
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
}

function attachmentRecord(row: any): AttachmentRecord {
  return { id: row.id, workspaceId: row.workspace_id, filename: row.filename, contentType: row.content_type,
    size: Number(row.byte_size), relativePath: row.relative_path, storageKey: row.storage_key, source: row.source,
    createdByMemberId: row.created_by_account_id, createdAt: new Date(row.created_at).toISOString() };
}
