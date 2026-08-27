import type { RelationshipEdge, RelationshipNeighborhood, RelationshipNode, RelationshipQuery } from "@stash/domain-types";

import type { PostgresKernel, PostgresQueryable } from "../instance-operations/storage/postgres-kernel.js";
import { effectiveNoteReadSql, workspaceMemberSql } from "./postgres-note-access.js";
import type { RelationshipMaintenance, RelationshipMaintenanceQuery, RelationshipQueryRepository } from "./relationship-query.js";

type PrepareNotes = (client: PostgresQueryable) => Promise<void>;
type VisibleNote = { id: string; title: string; parent_id: string | null };
const MAX_EDGE_FACTOR = 4;

export class PostgresRelationshipQueryRepository implements RelationshipQueryRepository {
  constructor(private readonly kernel: PostgresKernel, private readonly prepareNotes: PrepareNotes) {}

  async #neighbors(client: PostgresQueryable, workspaceId: string, memberId: string, frontier: readonly string[],
    excluded: readonly string[], query: RelationshipQuery, rowLimit: number): Promise<VisibleNote[]> {
    if (!frontier.length || rowLimit < 1) return [];
    const linkJoin = query.direction === "outgoing"
      ? "note.id=link.target_note_id" : query.direction === "incoming"
        ? "note.id=link.source_note_id" : "note.id=CASE WHEN link.source_note_id=ANY($3::uuid[]) THEN link.target_note_id ELSE link.source_note_id END";
    const linkFrontier = query.direction === "outgoing" ? "link.source_note_id=ANY($3::uuid[])"
      : query.direction === "incoming" ? "link.target_note_id=ANY($3::uuid[])"
        : "(link.source_note_id=ANY($3::uuid[]) OR link.target_note_id=ANY($3::uuid[]))";
    const hierarchy = query.includeHierarchy ? `UNION ALL
      SELECT note.id,note.title,note.parent_id FROM stash_notes note JOIN stash_workspaces workspace ON workspace.id=note.workspace_id
        WHERE note.workspace_id=$1 AND note.parent_id=ANY($3::uuid[]) AND note.archived_at IS NULL AND note.trashed_at IS NULL
          AND ${effectiveNoteReadSql("note", "workspace", "$2")}
      UNION ALL
      SELECT note.id,note.title,note.parent_id FROM stash_notes child JOIN stash_notes note ON note.id=child.parent_id
        JOIN stash_workspaces workspace ON workspace.id=note.workspace_id WHERE child.id=ANY($3::uuid[]) AND note.workspace_id=$1
          AND note.archived_at IS NULL AND note.trashed_at IS NULL AND ${effectiveNoteReadSql("note", "workspace", "$2")}` : "";
    const result = await client.query<VisibleNote>(`WITH candidates AS (
      SELECT note.id,note.title,note.parent_id FROM stash_note_links link JOIN stash_notes note ON ${linkJoin}
        JOIN stash_workspaces workspace ON workspace.id=note.workspace_id WHERE link.workspace_id=$1 AND ${linkFrontier}
          AND link.target_note_id IS NOT NULL AND note.archived_at IS NULL AND note.trashed_at IS NULL
          AND ($5::text[] IS NULL OR COALESCE(link.relationship_type,'untyped')=ANY($5::text[]))
          AND ${effectiveNoteReadSql("note", "workspace", "$2")}
      ${hierarchy}
    ) SELECT id,min(title) AS title,min(parent_id::text)::uuid AS parent_id FROM candidates
      WHERE NOT id=ANY($4::uuid[]) GROUP BY id ORDER BY min(title),id LIMIT $6`,
    [workspaceId, memberId, frontier, excluded, query.relationTypes ?? null, rowLimit]);
    return result.rows;
  }

  async query(memberId: string, query: RelationshipQuery) {
    return this.kernel.withSession(async (client) => {
      await this.prepareNotes(client);
      const root = await client.query<VisibleNote & { workspace_id: string }>(`SELECT note.id,note.title,note.parent_id,note.workspace_id
        FROM stash_notes note JOIN stash_workspaces workspace ON workspace.id=note.workspace_id WHERE note.id=$1
        AND note.archived_at IS NULL AND note.trashed_at IS NULL AND ${effectiveNoteReadSql("note", "workspace", "$2")}`, [query.rootId, memberId]);
      const rootNote = root.rows[0]; if (!rootNote) return { status: "not_found" as const };
      const selected = new Map<string, VisibleNote & { depth: number }>([[rootNote.id, { ...rootNote, depth: 0 }]]);
      let frontier = [rootNote.id]; let hasMore = false;
      for (let depth = 1; depth <= query.depth && frontier.length; depth += 1) {
        const remaining = query.limit - selected.size;
        const candidates = await this.#neighbors(client, rootNote.workspace_id, memberId, frontier, [...selected.keys()], query, remaining + 1);
        if (candidates.length > remaining) hasMore = true;
        const added = candidates.slice(0, Math.max(0, remaining));
        frontier = added.map(({ id }) => id);
        for (const note of added) selected.set(note.id, { ...note, depth });
        if (hasMore || selected.size >= query.limit) break;
      }
      if (!hasMore && frontier.length) hasMore = (await this.#neighbors(client, rootNote.workspace_id, memberId, frontier,
        [...selected.keys()], query, 1)).length > 0;
      const selectedIds = [...selected.keys()]; const edgeLimit = Math.min(400, query.limit * MAX_EDGE_FACTOR);
      const edgeRows = await client.query<{ id: string; source_note_id: string; target_note_id: string; kind: "note-link" | "hierarchy"; relationship_type: string | null }>(`WITH edges AS (
        SELECT link.id::text,link.source_note_id,link.target_note_id,'note-link'::text AS kind,link.relationship_type
          FROM stash_note_links link WHERE link.source_note_id=ANY($1::uuid[]) AND link.target_note_id=ANY($1::uuid[])
            AND ($2::text[] IS NULL OR COALESCE(link.relationship_type,'untyped')=ANY($2::text[]))
        ${query.includeHierarchy ? `UNION ALL SELECT 'hierarchy:'||parent_id::text||':'||id::text,parent_id,id,'hierarchy',NULL
          FROM stash_notes WHERE id=ANY($1::uuid[]) AND parent_id=ANY($1::uuid[])` : ""}
      ) SELECT * FROM edges ORDER BY kind,id LIMIT $3`, [selectedIds, query.relationTypes ?? null, edgeLimit + 1]);
      if (edgeRows.rows.length > edgeLimit) hasMore = true;
      const edges: RelationshipEdge[] = edgeRows.rows.slice(0, edgeLimit).map((edge) => ({ id: edge.id,
        sourceNoteId: edge.source_note_id, targetNoteId: edge.target_note_id, kind: edge.kind,
        ...(edge.relationship_type ? { relationshipType: edge.relationship_type } : {}) }));
      const nodes: RelationshipNode[] = [...selected.values()].map(({ id, title, depth }) => ({ id, title, depth }));
      return { status: "found" as const, neighborhood: { rootId: query.rootId, depth: query.depth, limit: query.limit,
        direction: query.direction, nodes, edges, outline: [...nodes], hasMore } satisfies RelationshipNeighborhood };
    });
  }

  async maintenance(memberId: string, workspaceId: string, page: RelationshipMaintenanceQuery) {
    return this.kernel.withSession(async (client) => {
      await this.prepareNotes(client);
      const access = await client.query<{ workspace_access: boolean; project_access: boolean }>(`SELECT
        ${workspaceMemberSql("stash_workspaces", "$2")} AS workspace_access,
        EXISTS(SELECT 1 FROM stash_projects project JOIN stash_project_guests guest ON guest.project_id=project.id
          WHERE project.workspace_id=stash_workspaces.id AND guest.account_id=$2) AS project_access
        FROM stash_workspaces WHERE id=$1`, [workspaceId, memberId]);
      const permission = access.rows[0];
      if (!permission || !permission.workspace_access && !permission.project_access) return { status: "workspace_forbidden" as const };
      const orphans = await client.query<{ id: string; title: string }>(`SELECT note.id,note.title FROM stash_notes note
        JOIN stash_workspaces workspace ON workspace.id=note.workspace_id WHERE note.workspace_id=$1
          AND note.archived_at IS NULL AND note.trashed_at IS NULL AND ${effectiveNoteReadSql("note", "workspace", "$2")}
          AND NOT EXISTS (SELECT 1 FROM stash_note_links link JOIN stash_notes other ON other.id=CASE
            WHEN link.source_note_id=note.id THEN link.target_note_id ELSE link.source_note_id END
            JOIN stash_workspaces other_workspace ON other_workspace.id=other.workspace_id
            WHERE link.target_note_id IS NOT NULL AND (link.source_note_id=note.id OR link.target_note_id=note.id)
              AND other.archived_at IS NULL AND other.trashed_at IS NULL AND ${effectiveNoteReadSql("other", "other_workspace", "$2")})
          AND NOT (${workspaceMemberSql("workspace", "$2")} AND EXISTS (SELECT 1 FROM stash_note_links unresolved
            WHERE unresolved.source_note_id=note.id AND unresolved.target_note_id IS NULL))
        ORDER BY note.title,note.id LIMIT $3 OFFSET $4`, [workspaceId, memberId, page.limit + 1, page.offset]);
      const broken = permission.workspace_access ? await client.query<{ id: string; source_note_id: string; source_title: string;
        target_path: string | null; label: string; revision: number; candidates: Array<{ id: string; title: string }> }>(`SELECT link.id,link.source_note_id,
          source.title AS source_title,link.target_path,link.label,link.revision,COALESCE((SELECT json_agg(candidate_row ORDER BY candidate_row.title,candidate_row.id)
            FROM (SELECT candidate.id,candidate.title FROM stash_notes candidate WHERE candidate.id=ANY(link.candidate_note_ids)
              AND candidate.workspace_id=$1 AND candidate.archived_at IS NULL AND candidate.trashed_at IS NULL LIMIT 100) candidate_row),'[]'::json) AS candidates
        FROM stash_note_links link JOIN stash_notes source ON source.id=link.source_note_id
        WHERE link.workspace_id=$1 AND link.target_note_id IS NULL ORDER BY source.title,link.id LIMIT $2 OFFSET $3`,
      [workspaceId, page.limit + 1, page.offset]) : { rows: [] };
      const more = orphans.rows.length > page.limit || broken.rows.length > page.limit;
      const brokenLinks: Array<RelationshipMaintenance["brokenLinks"][number]> = broken.rows.slice(0, page.limit).map((link) => ({ id: link.id,
        sourceNoteId: link.source_note_id, sourceTitle: link.source_title, label: link.label,
        ...(link.target_path ? { targetPath: link.target_path } : {}), revision: Number(link.revision), candidates: link.candidates }));
      return { status: "found" as const, orphans: orphans.rows.slice(0, page.limit), brokenLinks,
        ...(more ? { nextCursor: String(page.offset + page.limit) } : {}) };
    });
  }
}
