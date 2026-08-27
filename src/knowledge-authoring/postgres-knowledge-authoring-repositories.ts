import type { ActivityCause } from "../activity.js";
import type { NoteRecord, NoteRepository, PortableNoteProjection } from "../notes.js";
import type { PostgresKernel, PostgresQueryable } from "../instance-operations/storage/postgres-kernel.js";

interface PostgresKnowledgeAuthoringHooks {
  prepare(client: PostgresQueryable): Promise<void>;
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
}
