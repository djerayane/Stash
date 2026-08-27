import { createHash, randomUUID } from "node:crypto";
import type { RelationshipVisualizationFilters, TermVisualizationFilters, VisualizationDefinition } from "@stash/domain-types";
import type { PostgresKernel, PostgresQueryable } from "../instance-operations/storage/postgres-kernel.js";
import type { PostgresPortableProjectionContributor } from "../instance-operations/storage/portable-projection-contributor.js";
import type { PortableDurableObject } from "../portable-workspace-export.js";
import type { SavedVisualizationBlock, VisualizationBlockRepository } from "./visualization-block.js";
import { effectiveNoteReadSql, workspaceMemberSql } from "./postgres-note-access.js";

type PrepareNotes = (client: PostgresQueryable) => Promise<void>;
const saved = (noteId: string, definition: VisualizationDefinition, revision: number): SavedVisualizationBlock => ({ noteId, definition, revision });
const projection = (definition: VisualizationDefinition, workspaceId: string, noteId: string, revision: number) =>
  ({ ...definition, workspaceId, ownerNoteId: noteId, revision });
const positions = (definition: VisualizationDefinition): Readonly<Record<string, { x: number; y: number }>> =>
  "positions" in definition.layout ? definition.layout.positions : {};
const rootId = (definition: VisualizationDefinition): string | undefined =>
  definition.query.kind === "relationship" ? definition.query.input.rootId : undefined;
const referencedNoteIds = (definition: VisualizationDefinition): string[] => [...new Set([
  ...(rootId(definition) ? [rootId(definition)!] : []), ...Object.keys(positions(definition)),
  ...definition.viewEdges.flatMap((edge) => [edge.sourceNoteId, edge.targetNoteId]),
])];
function permissionFilteredDefinition(definition: VisualizationDefinition, visibleIds: ReadonlySet<string>,
  visibleTypes?: ReadonlySet<string>): VisualizationDefinition | undefined {
  const queryRoot = rootId(definition); if (queryRoot && !visibleIds.has(queryRoot)) return undefined;
  const viewEdges = definition.viewEdges.filter((edge) => visibleIds.has(edge.sourceNoteId) && visibleIds.has(edge.targetNoteId)).map((edge) =>
    edge.relationshipType && visibleTypes && !visibleTypes.has(edge.relationshipType) ? { ...edge, relationshipType: undefined } : edge);
  const layout = "positions" in definition.layout ? { ...definition.layout,
    positions: Object.fromEntries(Object.entries(definition.layout.positions).filter(([id]) => visibleIds.has(id))) } : definition.layout;
  if (!visibleTypes) return { ...definition, layout, viewEdges } as VisualizationDefinition;
  if (definition.query.kind === "relationship") { const filters = definition.filters as RelationshipVisualizationFilters;
    return { ...definition, query: { ...definition.query, input: { ...definition.query.input,
    ...(definition.query.input.relationTypes ? { relationTypes: definition.query.input.relationTypes.filter((type) => visibleTypes.has(type)) } : {}) } },
    filters: { ...filters, relationTypes: filters.relationTypes.filter((type) => visibleTypes.has(type)) }, layout, viewEdges } as VisualizationDefinition; }
  const filters = definition.filters as TermVisualizationFilters;
  return { ...definition, query: { ...definition.query, input: { ...definition.query.input,
    terms: definition.query.input.terms.filter((term) => visibleTypes.has(term)) } },
  filters: { terms: filters.terms.filter((term) => visibleTypes.has(term)) }, layout, viewEdges } as VisualizationDefinition;
}

export class PostgresVisualizationBlockRepository implements VisualizationBlockRepository, PostgresPortableProjectionContributor {
  static readonly portableObjectKinds = ["VisualizationBlock"] as const;
  constructor(private readonly kernel: PostgresKernel, private readonly prepareNotes: PrepareNotes) {}
  async prepare(client: PostgresQueryable): Promise<void> {
    await this.prepareNotes(client);
    await client.query(`CREATE TABLE IF NOT EXISTS stash_visualization_blocks(
      id UUID PRIMARY KEY,workspace_id UUID NOT NULL REFERENCES stash_workspaces(id) ON DELETE CASCADE,
      owner_note_id UUID NOT NULL REFERENCES stash_notes(id) ON DELETE CASCADE,definition JSONB NOT NULL,
      revision INTEGER NOT NULL CHECK(revision>0),UNIQUE(owner_note_id,id));
      CREATE TABLE IF NOT EXISTS stash_visualization_block_saves(
      block_id UUID NOT NULL REFERENCES stash_visualization_blocks(id) ON DELETE CASCADE,idempotency_key UUID NOT NULL,
      member_id UUID NOT NULL REFERENCES stash_accounts(id),fingerprint TEXT NOT NULL,result JSONB NOT NULL,activity_id UUID NOT NULL,
      PRIMARY KEY(block_id,idempotency_key));
      CREATE TABLE IF NOT EXISTS stash_visualization_edge_promotions(
      block_id UUID NOT NULL REFERENCES stash_visualization_blocks(id) ON DELETE CASCADE,edge_id TEXT NOT NULL,
      member_id UUID NOT NULL REFERENCES stash_accounts(id),idempotency_key UUID NOT NULL,link_id UUID NOT NULL,
      activity_id UUID NOT NULL,PRIMARY KEY(block_id,edge_id,idempotency_key));`);
  }
  async preparePortableObjects(client: PostgresQueryable): Promise<void> { await this.prepare(client); }
  async #record(client: PostgresQueryable, kind: "VisualizationBlock" | "NoteLink" | "Activity", id: string, revision: number,
    schema: string, value: object): Promise<void> {
    await client.query(`INSERT INTO stash_portable_projection_outbox(object_kind,object_id,revision,projection_schema,payload)
      VALUES($1,$2,$3,$4,$5::jsonb) ON CONFLICT(object_kind,object_id,revision) DO NOTHING`,
    [kind, id, revision, schema, JSON.stringify(value)]);
  }
  async save(memberId: string, noteId: string, definition: VisualizationDefinition, expectedRevision: number | undefined, idempotencyKey: string) {
    return this.kernel.transaction(async (client) => { await this.prepare(client);
      await client.query("SELECT pg_advisory_xact_lock(hashtext('stash-visualization-save'),hashtext($1))", [idempotencyKey]);
      const fingerprint = createHash("sha256").update(JSON.stringify({ noteId, definition, expectedRevision: expectedRevision ?? null })).digest("hex");
      const owner = await client.query<{ workspace_id: string }>(`SELECT note.workspace_id FROM stash_notes note JOIN stash_workspaces workspace ON workspace.id=note.workspace_id
        WHERE note.id=$1 AND note.archived_at IS NULL AND note.trashed_at IS NULL AND ${workspaceMemberSql("workspace", "$2")} FOR UPDATE OF note`, [noteId, memberId]);
      const workspaceId = owner.rows[0]?.workspace_id; if (!workspaceId) return { status: "not_found" as const };
      const receipt = await client.query<{ member_id: string; fingerprint: string; result: SavedVisualizationBlock }>(
        "SELECT member_id,fingerprint,result FROM stash_visualization_block_saves WHERE block_id=$1 AND idempotency_key=$2",
        [definition.id, idempotencyKey]);
      if (receipt.rows[0]) return receipt.rows[0].member_id === memberId && receipt.rows[0].fingerprint === fingerprint
        ? { status: "saved" as const, block: receipt.rows[0].result } : { status: "idempotency_conflict" as const };
      const referenced = referencedNoteIds(definition);
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
      const actor = await client.query<{ name: string }>("SELECT name FROM stash_accounts WHERE id=$1", [memberId]);
      const activityId = randomUUID(); const occurredAt = new Date().toISOString();
      const result = saved(noteId, definition, revision);
      const activity = { schema: "stash.activity.v1" as const, id: activityId, workspaceId,
        action: current.rows[0] ? "visualization_block_updated" : "visualization_block_created",
        object: { kind: "VisualizationBlock" as const, id: definition.id },
        actor: { localAccountId: memberId, displayName: actor.rows[0]?.name ?? "Member" }, cause: { kind: "member" as const }, occurredAt,
        before: current.rows[0] ? { definition: current.rows[0].definition, revision: Number(current.rows[0].revision) } : { present: false },
        after: { definition, revision } };
      await client.query(`INSERT INTO stash_workspace_activity
        (id,workspace_id,object_kind,object_id,action,actor_account_id,cause,occurred_at,before_state,after_state)
        VALUES($1,$2,'VisualizationBlock',$3,$4,$5,'member',$6,$7::jsonb,$8::jsonb)`,
      [activityId, workspaceId, definition.id, activity.action, memberId, occurredAt, JSON.stringify(activity.before), JSON.stringify(activity.after)]);
      await this.#record(client, "VisualizationBlock", definition.id, revision, "stash.visualization.v1", projection(definition, workspaceId, noteId, revision));
      await this.#record(client, "Activity", activityId, 1, activity.schema, activity);
      await client.query(`INSERT INTO stash_visualization_block_saves(block_id,idempotency_key,member_id,fingerprint,result,activity_id)
        VALUES($1,$2,$3,$4,$5::jsonb,$6)`, [definition.id, idempotencyKey, memberId, fingerprint, JSON.stringify(result), activityId]);
      return { status: "saved" as const, block: result };
    });
  }
  async read(memberId: string, noteId: string, blockId: string) {
    return this.kernel.withSession(async (client) => { await this.prepare(client);
      const row = await client.query<{ definition: VisualizationDefinition; revision: number; workspace_id: string; can_edit: boolean }>(`SELECT view.definition,view.revision,view.workspace_id,
        ${workspaceMemberSql("workspace", "$3")} AS can_edit
        FROM stash_visualization_blocks view JOIN stash_notes note ON note.id=view.owner_note_id
        JOIN stash_workspaces workspace ON workspace.id=view.workspace_id
        WHERE view.id=$1 AND view.owner_note_id=$2 AND note.archived_at IS NULL AND note.trashed_at IS NULL
        AND ${effectiveNoteReadSql("note", "workspace", "$3")}`, [blockId, noteId, memberId]);
      const found = row.rows[0]; if (!found) return { status: "not_found" as const };
      const definition = found.definition;
      const referenced = referencedNoteIds(definition);
      const visible = await client.query<{ id: string }>(`SELECT candidate.id FROM stash_notes candidate
        JOIN stash_workspaces workspace ON workspace.id=candidate.workspace_id WHERE candidate.workspace_id=$1
        AND candidate.id=ANY($2::uuid[]) AND candidate.archived_at IS NULL AND candidate.trashed_at IS NULL
        AND ${effectiveNoteReadSql("candidate", "workspace", "$3")}`, [found.workspace_id, referenced, memberId]);
      const allowed = new Set(visible.rows.map(({ id }) => id));
      const visibleTypes = found.can_edit ? undefined : await this.#visibleRelationTypesForMember(client, found.workspace_id, memberId);
      const filtered = permissionFilteredDefinition(definition, allowed, visibleTypes); if (!filtered) return { status: "not_found" as const };
      return { status: "found" as const, block: saved(noteId, filtered, Number(found.revision)) };
    });
  }
  async #visibleRelationTypes(client: PostgresQueryable, workspaceId: string, visibleIds: ReadonlySet<string>): Promise<Set<string>> {
    if (!visibleIds.size) return new Set();
    const types = await client.query<{ relationship_type: string }>(`SELECT DISTINCT COALESCE(link.relationship_type,'untyped') AS relationship_type
      FROM stash_note_links link JOIN stash_notes source ON source.id=link.source_note_id JOIN stash_notes target ON target.id=link.target_note_id
      WHERE link.workspace_id=$1 AND link.source_note_id=ANY($2::uuid[]) AND link.target_note_id=ANY($2::uuid[])
      LIMIT 100`,
    [workspaceId, [...visibleIds]]);
    return new Set(types.rows.map(({ relationship_type }) => relationship_type));
  }
  async #visibleRelationTypesForMember(client: PostgresQueryable, workspaceId: string, memberId: string): Promise<Set<string>> {
    const types = await client.query<{ relationship_type: string }>(`SELECT DISTINCT COALESCE(link.relationship_type,'untyped') AS relationship_type
      FROM stash_note_links link JOIN stash_notes source ON source.id=link.source_note_id JOIN stash_notes target ON target.id=link.target_note_id
      JOIN stash_workspaces workspace ON workspace.id=link.workspace_id WHERE link.workspace_id=$1
        AND source.archived_at IS NULL AND source.trashed_at IS NULL AND target.archived_at IS NULL AND target.trashed_at IS NULL
        AND ${effectiveNoteReadSql("source", "workspace", "$2")} AND ${effectiveNoteReadSql("target", "workspace", "$2")} LIMIT 100`,
    [workspaceId, memberId]);
    return new Set(types.rows.map(({ relationship_type }) => relationship_type));
  }
  async promoteViewEdge(memberId: string, noteId: string, blockId: string, edgeId: string, idempotencyKey: string) {
    return this.kernel.transaction(async (client) => { await this.prepare(client);
      await client.query("SELECT pg_advisory_xact_lock(hashtext('stash-visualization-promotion'),hashtext($1))", [idempotencyKey]);
      const row = await client.query<{ definition: VisualizationDefinition; workspace_id: string }>(`SELECT view.definition,view.workspace_id FROM stash_visualization_blocks view
        JOIN stash_notes note ON note.id=view.owner_note_id JOIN stash_workspaces workspace ON workspace.id=view.workspace_id
        WHERE view.id=$1 AND view.owner_note_id=$2 AND note.archived_at IS NULL AND note.trashed_at IS NULL
        AND ${workspaceMemberSql("workspace", "$3")} FOR UPDATE OF view`, [blockId, noteId, memberId]);
      const view = row.rows[0]; if (!view) return { status: "not_found" as const };
      const receipt = await client.query<{ link_id: string; activity_id: string }>(`SELECT link_id,activity_id FROM stash_visualization_edge_promotions
        WHERE block_id=$1 AND edge_id=$2 AND idempotency_key=$3 AND member_id=$4`, [blockId, edgeId, idempotencyKey, memberId]);
      if (receipt.rows[0]) return { status: "promoted" as const, linkId: receipt.rows[0].link_id, activityId: receipt.rows[0].activity_id };
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
      const noteLink = { schema: "stash.note-link.v2" as const, id: linkId, workspaceId: view.workspace_id, sourceNoteId: edge.sourceNoteId,
        targetNoteId: edge.targetNoteId, targetPath, candidateNoteIds: [], label: edge.relationshipType ?? "Note",
        ...(edge.relationshipType ? { relationshipType: edge.relationshipType } : {}), revision: 1 };
      const actor = await client.query<{ name: string }>("SELECT name FROM stash_accounts WHERE id=$1", [memberId]);
      const activityId = randomUUID(); const occurredAt = new Date().toISOString();
      const activity = { schema: "stash.activity.v1" as const, id: activityId, workspaceId: view.workspace_id,
        action: "visualization_edge_promoted", object: { kind: "NoteLink" as const, id: linkId },
        actor: { localAccountId: memberId, displayName: actor.rows[0]?.name ?? "Member" }, cause: { kind: "member" as const }, occurredAt,
        before: { visualizationBlockId: blockId, viewEdgeId: edgeId }, after: noteLink };
      await client.query(`INSERT INTO stash_workspace_activity
        (id,workspace_id,object_kind,object_id,action,actor_account_id,cause,occurred_at,before_state,after_state)
        VALUES($1,$2,'NoteLink',$3,$4,$5,'member',$6,$7::jsonb,$8::jsonb)`,
      [activityId, view.workspace_id, linkId, activity.action, memberId, occurredAt, JSON.stringify(activity.before), JSON.stringify(activity.after)]);
      await this.#record(client, "NoteLink", linkId, 1, noteLink.schema, noteLink);
      await this.#record(client, "Activity", activityId, 1, activity.schema, activity);
      await client.query(`INSERT INTO stash_visualization_edge_promotions(block_id,edge_id,member_id,idempotency_key,link_id,activity_id)
        VALUES($1,$2,$3,$4,$5,$6)`, [blockId, edgeId, memberId, idempotencyKey, linkId, activityId]);
      return { status: "promoted" as const, linkId, activityId };
    });
  }
  async importPortableObjects(client: PostgresQueryable, objects: readonly PortableDurableObject[], workspaceId: string): Promise<void> {
    const views = objects.filter(({ kind }) => kind === "VisualizationBlock"); if (!views.length) return;
    await this.prepare(client);
    for (const item of views) {
      const view = item.payload as VisualizationDefinition & { ownerNoteId: string; revision: number };
      const definition = { schema: view.schema, id: view.id, kind: view.kind, query: view.query, filters: view.filters,
        layout: view.layout, viewEdges: view.viewEdges } as VisualizationDefinition;
      await client.query(`INSERT INTO stash_visualization_blocks(id,workspace_id,owner_note_id,definition,revision)
        VALUES($1,$2,$3,$4::jsonb,$5)`, [item.id, workspaceId, view.ownerNoteId, JSON.stringify(definition), view.revision]);
      await this.#record(client, "VisualizationBlock", item.id, view.revision, "stash.visualization.v1", view);
    }
  }
  async readPortableObjects(client: PostgresQueryable, input: { workspaceId: string; memberId: string; member: boolean;
    visibleNoteIds: ReadonlySet<string> }): Promise<PortableDurableObject[]> {
    if (!input.visibleNoteIds.size) return [];
    const rows = await client.query<{ id: string; definition: VisualizationDefinition; owner_note_id: string; revision: number }>(`SELECT id,definition,owner_note_id,revision
      FROM stash_visualization_blocks WHERE workspace_id=$1 AND owner_note_id=ANY($2::uuid[]) ORDER BY id`,
    [input.workspaceId, [...input.visibleNoteIds]]);
    const visibleTypes = input.member ? undefined : await this.#visibleRelationTypes(client, input.workspaceId, input.visibleNoteIds);
    return rows.rows.flatMap((row) => {
      const filtered = permissionFilteredDefinition(row.definition, input.visibleNoteIds, visibleTypes); if (!filtered) return [];
      return [{ kind: "VisualizationBlock", id: row.id, schema: "stash.visualization.v1",
        payload: projection(filtered, input.workspaceId, row.owner_note_id, Number(row.revision)) }];
    });
  }
}
