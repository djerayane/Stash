import type { RelationshipEdge, RelationshipNeighborhood, RelationshipNode, RelationshipQuery } from "@stash/domain-types";

import type { PostgresKernel, PostgresQueryable } from "../instance-operations/storage/postgres-kernel.js";
import type { RelationshipMaintenance, RelationshipQueryRepository } from "./relationship-query.js";

type PrepareNotes = (client: PostgresQueryable) => Promise<void>;
type VisibleNote = { id: string; title: string; parent_id: string | null };

const workspaceMember = (workspace: "workspace" | "stash_workspaces", member = "$2") =>
  `((${workspace}.owner_type='personal' AND ${workspace}.personal_owner_id=${member}) OR
    (${workspace}.owner_type='organization' AND EXISTS (SELECT 1 FROM stash_organization_memberships membership
      WHERE membership.organization_id=${workspace}.organization_owner_id AND membership.account_id=${member})))`;

const inheritedProjectGuest = (note: "note", member = "$2") => `EXISTS(WITH RECURSIVE ancestry AS (
  SELECT ${note}.id,${note}.parent_id,${note}.project_id UNION ALL
  SELECT parent.id,parent.parent_id,parent.project_id FROM stash_notes parent JOIN ancestry ON ancestry.parent_id=parent.id
) SELECT 1 FROM ancestry JOIN stash_project_guests guest ON guest.project_id=ancestry.project_id WHERE guest.account_id=${member})`;

function relationIncluded(query: RelationshipQuery, type: string | null): boolean {
  if (!query.relationTypes) return true;
  return query.relationTypes.includes(type ?? "untyped");
}

export class PostgresRelationshipQueryRepository implements RelationshipQueryRepository {
  constructor(private readonly kernel: PostgresKernel, private readonly prepareNotes: PrepareNotes) {}

  async #visibleNotes(client: PostgresQueryable, workspaceId: string, memberId: string): Promise<VisibleNote[]> {
    const visible = await client.query<VisibleNote>(`SELECT note.id,note.title,note.parent_id FROM stash_notes note
      JOIN stash_workspaces workspace ON workspace.id=note.workspace_id WHERE note.workspace_id=$1
      AND note.archived_at IS NULL AND note.trashed_at IS NULL
      AND (${workspaceMember("workspace")} OR ${inheritedProjectGuest("note")}) ORDER BY note.title,note.id`, [workspaceId, memberId]);
    return visible.rows;
  }

  async query(memberId: string, query: RelationshipQuery) {
    return this.kernel.withSession(async (client) => {
      await this.prepareNotes(client);
      const root = await client.query<{ workspace_id: string }>(`SELECT note.workspace_id FROM stash_notes note
        JOIN stash_workspaces workspace ON workspace.id=note.workspace_id WHERE note.id=$1
        AND note.archived_at IS NULL AND note.trashed_at IS NULL
        AND (${workspaceMember("workspace")} OR ${inheritedProjectGuest("note")})`, [query.rootId, memberId]);
      const workspaceId = root.rows[0]?.workspace_id;
      if (!workspaceId) return { status: "not_found" as const };
      const visible = await this.#visibleNotes(client, workspaceId, memberId);
      const byId = new Map(visible.map((note) => [note.id, note]));
      const ids = visible.map(({ id }) => id);
      const links = ids.length ? await client.query<{ id: string; source_note_id: string; target_note_id: string; relationship_type: string | null }>(
        `SELECT id,source_note_id,target_note_id,relationship_type FROM stash_note_links
         WHERE source_note_id=ANY($1::uuid[]) AND target_note_id=ANY($1::uuid[]) ORDER BY id`, [ids]) : { rows: [] };
      const edges: RelationshipEdge[] = links.rows.filter((link) => relationIncluded(query, link.relationship_type)).map((link) => ({
        id: link.id, sourceNoteId: link.source_note_id, targetNoteId: link.target_note_id, kind: "note-link" as const,
        ...(link.relationship_type ? { relationshipType: link.relationship_type } : {}),
      }));
      if (query.includeHierarchy) for (const note of visible) if (note.parent_id && byId.has(note.parent_id)) edges.push({
        id: `hierarchy:${note.parent_id}:${note.id}`, sourceNoteId: note.parent_id, targetNoteId: note.id, kind: "hierarchy",
      });

      const adjacent = new Map<string, Set<string>>();
      const connect = (from: string, to: string) => {
        const current = adjacent.get(from) ?? new Set<string>(); current.add(to); adjacent.set(from, current);
      };
      for (const edge of edges) {
        if (edge.kind === "hierarchy" || query.direction !== "incoming") connect(edge.sourceNoteId, edge.targetNoteId);
        if (edge.kind === "hierarchy" || query.direction !== "outgoing") connect(edge.targetNoteId, edge.sourceNoteId);
      }
      const selected = new Map<string, number>([[query.rootId, 0]]);
      let frontier = [query.rootId]; let hasMore = false;
      for (let depth = 1; depth <= query.depth && frontier.length; depth += 1) {
        const candidates = [...new Set(frontier.flatMap((id) => [...(adjacent.get(id) ?? [])]))]
          .filter((id) => !selected.has(id)).sort((left, right) => {
            const titleOrder = byId.get(left)!.title.localeCompare(byId.get(right)!.title); return titleOrder || left.localeCompare(right);
          });
        const remaining = query.limit - selected.size;
        if (candidates.length > remaining) hasMore = true;
        frontier = candidates.slice(0, Math.max(remaining, 0));
        for (const id of frontier) selected.set(id, depth);
        if (selected.size >= query.limit) break;
      }
      const reachableBeyondDepth = frontier.some((id) => [...(adjacent.get(id) ?? [])].some((target) => !selected.has(target)));
      if (reachableBeyondDepth) hasMore = true;
      const nodes: RelationshipNode[] = [...selected].map(([id, depth]) => ({ id, title: byId.get(id)!.title, depth }));
      const selectedIds = new Set(selected.keys());
      const visibleEdges = edges.filter((edge) => selectedIds.has(edge.sourceNoteId) && selectedIds.has(edge.targetNoteId));
      return { status: "found" as const, neighborhood: { rootId: query.rootId, depth: query.depth, limit: query.limit,
        direction: query.direction, nodes, edges: visibleEdges, outline: [...nodes], hasMore } satisfies RelationshipNeighborhood };
    });
  }

  async maintenance(memberId: string, workspaceId: string) {
    return this.kernel.withSession(async (client) => {
      await this.prepareNotes(client);
      const access = await client.query<{ workspace_access: boolean; project_access: boolean }>(`SELECT
        ${workspaceMember("stash_workspaces")} AS workspace_access,
        EXISTS(SELECT 1 FROM stash_projects project JOIN stash_project_guests guest ON guest.project_id=project.id
          WHERE project.workspace_id=stash_workspaces.id AND guest.account_id=$2) AS project_access
        FROM stash_workspaces WHERE id=$1`, [workspaceId, memberId]);
      const permission = access.rows[0];
      if (!permission || !permission.workspace_access && !permission.project_access) return { status: "workspace_forbidden" as const };
      const visible = await this.#visibleNotes(client, workspaceId, memberId);
      const ids = visible.map(({ id }) => id); const byId = new Map(visible.map((note) => [note.id, note]));
      const links = ids.length ? await client.query<{ id: string; source_note_id: string; target_note_id: string | null; target_path: string | null;
        candidate_note_ids: string[]; label: string; revision: number }>(`SELECT id,source_note_id,target_note_id,target_path,candidate_note_ids,label,revision
        FROM stash_note_links WHERE source_note_id=ANY($1::uuid[]) ORDER BY id`, [ids]) : { rows: [] };
      const connected = new Set<string>();
      for (const link of links.rows) {
        if (link.target_note_id && byId.has(link.target_note_id)) { connected.add(link.source_note_id); connected.add(link.target_note_id); }
        else if (!link.target_note_id && permission.workspace_access) connected.add(link.source_note_id);
      }
      const orphans = visible.filter(({ id }) => !connected.has(id)).map(({ id, title }) => ({ id, title }));
      const brokenLinks: Array<RelationshipMaintenance["brokenLinks"][number]> = [];
      if (permission.workspace_access) for (const link of links.rows) if (!link.target_note_id) {
        const candidates = (link.candidate_note_ids ?? []).filter((id) => byId.has(id)).map((id) => ({ id, title: byId.get(id)!.title }));
        brokenLinks.push({ id: link.id, sourceNoteId: link.source_note_id, sourceTitle: byId.get(link.source_note_id)!.title,
          label: link.label, ...(link.target_path ? { targetPath: link.target_path } : {}), revision: Number(link.revision), candidates });
      }
      return { status: "found" as const, orphans, brokenLinks };
    });
  }
}
