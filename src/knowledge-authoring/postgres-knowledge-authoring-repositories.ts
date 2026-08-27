import type { ActivityCause } from "../activity.js";
import type { NoteRecord, NoteRepository, PortableNoteProjection } from "../notes.js";
import type { AttachmentRecord, PortableAttachmentProjection } from "../attachments.js";
import type { PostgresKernel, PostgresQueryable } from "../instance-operations/storage/postgres-kernel.js";

interface PostgresKnowledgeAuthoringHooks {
  prepare(client: PostgresQueryable): Promise<void>;
  prepareInvitations(client: PostgresQueryable): Promise<void>;
  prepareAttachments(client: PostgresQueryable): Promise<void>;
  prepareWorkspaceProjects(client: PostgresQueryable): Promise<void>;
  recordProjection(client: PostgresQueryable, kind: "Attachment", id: string, schema: PortableAttachmentProjection["schema"], projection: PortableAttachmentProjection): Promise<void>;
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

/** PostgreSQL implementation of the Knowledge Authoring persistence seam. */
export class PostgresKnowledgeAuthoringRepositories {
  constructor(private readonly kernel: PostgresKernel, private readonly hooks: PostgresKnowledgeAuthoringHooks) {}

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
      tag === undefined ? [workspaceId, memberId] : [workspaceId, memberId, JSON.stringify([tag])]);
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
}

function attachmentRecord(row: any): AttachmentRecord {
  return { id: row.id, workspaceId: row.workspace_id, filename: row.filename, contentType: row.content_type,
    size: Number(row.byte_size), relativePath: row.relative_path, storageKey: row.storage_key, source: row.source,
    createdByMemberId: row.created_by_account_id, createdAt: new Date(row.created_at).toISOString() };
}
