import { randomUUID } from "node:crypto";
import type { VisualizationDefinition } from "@stash/domain-types";
import type { PostgresKernel, PostgresQueryable } from "../instance-operations/storage/postgres-kernel.js";
import type { SavedVisualizationBlock, VisualizationBlockRepository } from "./visualization-block.js";

type PrepareNotes = (client: PostgresQueryable) => Promise<void>;
const member = (parameter = "$2") => `((workspace.owner_type='personal' AND workspace.personal_owner_id=${parameter}) OR
  (workspace.owner_type='organization' AND EXISTS (SELECT 1 FROM stash_organization_memberships membership
    WHERE membership.organization_id=workspace.organization_owner_id AND membership.account_id=${parameter})))`;
const saved = (noteId: string, definition: VisualizationDefinition, revision: number): SavedVisualizationBlock => ({ noteId, definition, revision });

export class PostgresVisualizationBlockRepository implements VisualizationBlockRepository {
  constructor(private readonly kernel: PostgresKernel, private readonly prepareNotes: PrepareNotes) {}
  async prepare(client: PostgresQueryable): Promise<void> { await this.prepareNotes(client); await client.query(`CREATE TABLE IF NOT EXISTS stash_visualization_blocks(
    id UUID PRIMARY KEY,workspace_id UUID NOT NULL REFERENCES stash_workspaces(id) ON DELETE CASCADE,
    owner_note_id UUID NOT NULL REFERENCES stash_notes(id) ON DELETE CASCADE,definition JSONB NOT NULL,
    revision INTEGER NOT NULL CHECK(revision>0),UNIQUE(owner_note_id,id))`); }
  async save(memberId: string, noteId: string, definition: VisualizationDefinition, expectedRevision?: number) {
    return this.kernel.transaction(async (client) => { await this.prepare(client);
      const owner = await client.query<{ workspace_id: string }>(`SELECT note.workspace_id FROM stash_notes note JOIN stash_workspaces workspace ON workspace.id=note.workspace_id
        WHERE note.id=$1 AND note.archived_at IS NULL AND note.trashed_at IS NULL AND ${member()} FOR UPDATE OF note`, [noteId, memberId]);
      const workspaceId = owner.rows[0]?.workspace_id; if (!workspaceId) return { status: "not_found" as const };
      const referenced = [...new Set([definition.query.rootId, ...definition.viewEdges.flatMap((edge) => [edge.sourceNoteId, edge.targetNoteId])])];
      const notes = await client.query<{ id: string }>(`SELECT id FROM stash_notes WHERE workspace_id=$1 AND id=ANY($2::uuid[])
        AND archived_at IS NULL AND trashed_at IS NULL`, [workspaceId, referenced]);
      if (notes.rows.length !== referenced.length) return { status: "not_found" as const };
      const current = await client.query<{ definition: VisualizationDefinition; revision: number; owner_note_id: string }>(
        "SELECT definition,revision,owner_note_id FROM stash_visualization_blocks WHERE id=$1 FOR UPDATE", [definition.id]);
      if (current.rows[0] && current.rows[0].owner_note_id !== noteId) return { status: "not_found" as const };
      if (current.rows[0] && expectedRevision !== undefined && Number(current.rows[0].revision) !== expectedRevision)
        return { status: "changed" as const, block: saved(noteId, current.rows[0].definition, Number(current.rows[0].revision)) };
      const revision = current.rows[0] ? Number(current.rows[0].revision) + 1 : 1;
      await client.query(`INSERT INTO stash_visualization_blocks(id,workspace_id,owner_note_id,definition,revision) VALUES($1,$2,$3,$4::jsonb,$5)
        ON CONFLICT(id) DO UPDATE SET definition=excluded.definition,revision=excluded.revision`, [definition.id, workspaceId, noteId, JSON.stringify(definition), revision]);
      const projection = { ...definition, workspaceId, ownerNoteId: noteId, revision };
      await client.query(`INSERT INTO stash_portable_projection_outbox(object_kind,object_id,revision,projection_schema,payload)
        VALUES('VisualizationBlock',$1,$2,'stash.visualization.v1',$3::jsonb)`, [definition.id, revision, JSON.stringify(projection)]);
      return { status: "saved" as const, block: saved(noteId, definition, revision) };
    });
  }
  async read(memberId: string, noteId: string, blockId: string) { return this.kernel.withSession(async (client) => { await this.prepare(client);
    const row = await client.query<{ definition: VisualizationDefinition; revision: number }>(`SELECT view.definition,view.revision FROM stash_visualization_blocks view
      JOIN stash_notes note ON note.id=view.owner_note_id JOIN stash_workspaces workspace ON workspace.id=view.workspace_id
      WHERE view.id=$1 AND view.owner_note_id=$2 AND note.archived_at IS NULL AND note.trashed_at IS NULL AND ${member("$3")}`,
    [blockId, noteId, memberId]);
    return row.rows[0] ? { status: "found" as const, block: saved(noteId, row.rows[0].definition, Number(row.rows[0].revision)) } : { status: "not_found" as const };
  }); }
  async promoteViewEdge(memberId: string, noteId: string, blockId: string, edgeId: string) { return this.kernel.transaction(async (client) => { await this.prepare(client);
    const row = await client.query<{ definition: VisualizationDefinition; workspace_id: string }>(`SELECT view.definition,view.workspace_id FROM stash_visualization_blocks view
      JOIN stash_notes note ON note.id=view.owner_note_id JOIN stash_workspaces workspace ON workspace.id=view.workspace_id
      WHERE view.id=$1 AND view.owner_note_id=$2 AND ${member("$3")} FOR UPDATE OF view`, [blockId, noteId, memberId]);
    const view = row.rows[0]; if (!view) return { status: "not_found" as const };
    const edge = view.definition.viewEdges.find((candidate) => candidate.id === edgeId); if (!edge) return { status: "edge_not_found" as const };
    const notes = await client.query<{ id: string; portable_path: string }>(`SELECT id,portable_path FROM stash_notes WHERE id=ANY($1::uuid[]) AND workspace_id=$2
      AND archived_at IS NULL AND trashed_at IS NULL`, [[edge.sourceNoteId, edge.targetNoteId], view.workspace_id]);
    if (notes.rows.length !== 2) return { status: "not_found" as const };
    const targetPath = notes.rows.find(({ id }) => id === edge.targetNoteId)?.portable_path;
    if (!targetPath) return { status: "not_found" as const };
    const linkId = randomUUID(); const result = await client.query(`INSERT INTO stash_note_links
      (id,workspace_id,source_note_id,target_note_id,target_path,label,relationship_type,revision) VALUES($1,$2,$3,$4,$5,$6,$7,1)
      ON CONFLICT(source_note_id,target_note_id) DO NOTHING RETURNING id`, [linkId, view.workspace_id, edge.sourceNoteId, edge.targetNoteId,
      targetPath, edge.relationshipType ?? "Note", edge.relationshipType ?? null]);
    if (!result.rowCount) return { status: "already_linked" as const };
    const projection = { schema: "stash.note-link.v2", id: linkId, workspaceId: view.workspace_id, sourceNoteId: edge.sourceNoteId,
      targetNoteId: edge.targetNoteId, label: edge.relationshipType ?? "Note", ...(edge.relationshipType ? { relationshipType: edge.relationshipType } : {}), revision: 1 };
    await client.query(`INSERT INTO stash_portable_projection_outbox(object_kind,object_id,revision,projection_schema,payload)
      VALUES('NoteLink',$1,1,'stash.note-link.v2',$2::jsonb)`, [linkId, JSON.stringify(projection)]);
    return { status: "promoted" as const, linkId };
  }); }
}
