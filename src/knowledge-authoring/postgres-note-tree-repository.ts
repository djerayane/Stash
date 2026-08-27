import { randomUUID } from "node:crypto";

import type { PortableNoteLinkStateProjection, PortableNoteLocationProjection } from "../note-links.js";
import type { PortableNoteProjection } from "../notes.js";
import { paragraphDocument } from "../rich-text.js";
import type { PostgresKernel, PostgresQueryable } from "../instance-operations/storage/postgres-kernel.js";
import type { NoteTreeAccessChange, NoteTreeNode, NoteTreeRepository } from "./note-tree.js";

type PrepareNotes = (client: PostgresQueryable) => Promise<void>;
export interface NoteTreeBranchLifecycle {
  beforeStateChange(client: PostgresQueryable, noteIds: readonly string[], state: "archived" | "trashed"):
    Promise<"allowed" | "collection_owner_requires_relocation">;
}

const workspaceMember = (workspace: "workspace" | "stash_workspaces", member = "$2") =>
  `((${workspace}.owner_type='personal' AND ${workspace}.personal_owner_id=${member}) OR
    (${workspace}.owner_type='organization' AND EXISTS (SELECT 1 FROM stash_organization_memberships membership
      WHERE membership.organization_id=${workspace}.organization_owner_id AND membership.account_id=${member})))`;

const inheritedProjectGuest = (note: "note", member = "$2") => `EXISTS(WITH RECURSIVE ancestry AS (
  SELECT ${note}.id,${note}.parent_id,${note}.project_id UNION ALL
  SELECT parent.id,parent.parent_id,parent.project_id FROM stash_notes parent JOIN ancestry ON ancestry.parent_id=parent.id
) SELECT 1 FROM ancestry JOIN stash_project_guests guest ON guest.project_id=ancestry.project_id WHERE guest.account_id=${member})`;

/** Capability-owned Note Tree persistence over the shared PostgreSQL kernel. */
export class PostgresNoteTreeRepository implements NoteTreeRepository {
  constructor(private readonly kernel: PostgresKernel, private readonly prepareNotes: PrepareNotes,
    private readonly lifecycle?: NoteTreeBranchLifecycle) {}

  async prepare(client: PostgresQueryable): Promise<void> {
    await this.prepareNotes(client);
    await client.query(`
      ALTER TABLE stash_notes ADD COLUMN IF NOT EXISTS title TEXT;
      UPDATE stash_notes SET title=left(regexp_replace(split_part(content, E'\n', 1), '^#+[[:space:]]*', ''), 240) WHERE title IS NULL;
      ALTER TABLE stash_notes ALTER COLUMN title SET NOT NULL;
      ALTER TABLE stash_notes ADD COLUMN IF NOT EXISTS parent_id UUID REFERENCES stash_notes(id) ON DELETE SET NULL;
      ALTER TABLE stash_notes ADD COLUMN IF NOT EXISTS tree_position BIGINT;
      WITH positioned AS (
        SELECT id,row_number() OVER (PARTITION BY workspace_id,parent_id ORDER BY created_at,id) AS position
        FROM stash_notes WHERE tree_position IS NULL
      ) UPDATE stash_notes note SET tree_position=positioned.position FROM positioned WHERE note.id=positioned.id;
      ALTER TABLE stash_notes ALTER COLUMN tree_position SET NOT NULL;
      ALTER TABLE stash_notes ADD COLUMN IF NOT EXISTS trashed_at TIMESTAMPTZ;
      ALTER TABLE stash_note_links ADD COLUMN IF NOT EXISTS relationship_type TEXT;
      CREATE INDEX IF NOT EXISTS stash_notes_tree_order ON stash_notes(workspace_id,parent_id,tree_position,id);
      CREATE OR REPLACE FUNCTION stash_assign_note_tree_position() RETURNS TRIGGER AS $assign_note_tree_position$
      BEGIN
        IF NEW.title IS NULL THEN NEW.title := left(regexp_replace(split_part(NEW.content, E'\n', 1), '^#+[[:space:]]*', ''), 240); END IF;
        IF NEW.tree_position IS NULL THEN
          SELECT COALESCE(MAX(tree_position),0)+1 INTO NEW.tree_position FROM stash_notes
            WHERE workspace_id=NEW.workspace_id AND parent_id IS NOT DISTINCT FROM NEW.parent_id;
        END IF;
        RETURN NEW;
      END
      $assign_note_tree_position$ LANGUAGE plpgsql;
      DROP TRIGGER IF EXISTS stash_assign_note_tree_position ON stash_notes;
      CREATE TRIGGER stash_assign_note_tree_position BEFORE INSERT ON stash_notes
        FOR EACH ROW EXECUTE FUNCTION stash_assign_note_tree_position();
    `);
  }

  async applyImportedLocations(client: PostgresQueryable, locations: readonly PortableNoteLocationProjection[]): Promise<void> {
    await this.prepare(client);
    for (const location of locations) await client.query(`UPDATE stash_notes SET parent_id=$2,tree_position=COALESCE($3::bigint,tree_position),
      archived_at=$4::timestamptz,trashed_at=$5::timestamptz WHERE id=$1 AND workspace_id=$6`,
    [location.noteId, location.parentId ?? null, location.position ?? null, location.archivedAt ?? null, location.trashedAt ?? null, location.workspaceId]);
  }

  async applyImportedRelationships(client: PostgresQueryable,
    links: ReadonlyArray<{ id: string; relationshipType?: string }>): Promise<void> {
    await this.prepare(client);
    for (const link of links) if (link.relationshipType) await client.query(
      "UPDATE stash_note_links SET relationship_type=$2 WHERE id=$1", [link.id, link.relationshipType]);
  }

  async #projection(client: PostgresQueryable, kind: "Note" | "NoteLocation" | "NoteLink", id: string,
    schema: "stash.note.v1" | "stash.note-location.v1" | "stash.note-link.v2", payload: object): Promise<void> {
    await client.query(`INSERT INTO stash_portable_projection_outbox(object_kind,object_id,revision,projection_schema,payload)
      SELECT $1,$2,COALESCE(MAX(revision),0)+1,$3,$4::jsonb FROM stash_portable_projection_outbox
      WHERE object_kind=$1 AND object_id=$2`, [kind, id, schema, JSON.stringify(payload)]);
  }

  async createTreeNote(memberId: string, workspaceId: string,
    input: { id: string; title: string; parentId?: string; beforeId?: string }) {
    return this.kernel.transaction(async (client) => {
      await this.prepare(client);
      const access = await client.query<{ allowed: boolean }>(`SELECT ${workspaceMember("stash_workspaces")} AS allowed
        FROM stash_workspaces WHERE id=$1 FOR UPDATE`, [workspaceId, memberId]);
      if (!access.rows[0]?.allowed) return { status: "workspace_forbidden" as const };
      if (input.parentId && !(await client.query(`SELECT 1 FROM stash_notes WHERE id=$1 AND workspace_id=$2
        AND archived_at IS NULL AND trashed_at IS NULL`, [input.parentId, workspaceId])).rowCount) return { status: "parent_not_found" as const };
      let position: bigint;
      if (input.beforeId) {
        const before = await client.query<{ tree_position: string }>(`SELECT tree_position FROM stash_notes WHERE id=$1 AND workspace_id=$2
          AND parent_id IS NOT DISTINCT FROM $3::uuid AND archived_at IS NULL AND trashed_at IS NULL FOR UPDATE`,
        [input.beforeId, workspaceId, input.parentId ?? null]);
        if (!before.rows[0]) return { status: "before_not_found" as const };
        position = BigInt(before.rows[0].tree_position);
        await client.query(`UPDATE stash_notes SET tree_position=tree_position+1 WHERE workspace_id=$1
          AND parent_id IS NOT DISTINCT FROM $2::uuid AND tree_position >= $3`, [workspaceId, input.parentId ?? null, position.toString()]);
      } else {
        const end = await client.query<{ position: string }>(`SELECT COALESCE(MAX(tree_position),0)+1 AS position FROM stash_notes
          WHERE workspace_id=$1 AND parent_id IS NOT DISTINCT FROM $2::uuid`, [workspaceId, input.parentId ?? null]);
        position = BigInt(end.rows[0]!.position);
      }
      const createdAt = new Date().toISOString();
      const document = paragraphDocument(input.title, randomUUID());
      await client.query(`INSERT INTO stash_notes
        (id,workspace_id,project_id,content,document,revision,tags,created_by_account_id,created_at,title,parent_id,tree_position)
        VALUES($1,$2,NULL,$3,$4::jsonb,1,'[]'::jsonb,$5,$6,$3,$7,$8)`,
      [input.id, workspaceId, input.title, JSON.stringify(document), memberId, createdAt, input.parentId ?? null, position.toString()]);
      const identity = await client.query<{ name: string }>("SELECT name FROM stash_accounts WHERE id=$1", [memberId]);
      const note: PortableNoteProjection = { schema: "stash.note.v1", id: input.id, workspaceId, content: input.title, tags: [],
        createdAt, createdBy: { localAccountId: memberId, displayName: identity.rows[0]!.name } };
      await this.#projection(client, "Note", input.id, note.schema, note);
      const location: PortableNoteLocationProjection = { schema: "stash.note-location.v1", noteId: input.id, workspaceId,
        path: `notes/${input.id}.md`, aliases: [], revision: 1, ...(input.parentId ? { parentId: input.parentId } : {}), position: position.toString() };
      await this.#projection(client, "NoteLocation", input.id, location.schema, location);
      return { status: "created" as const, node: { id: input.id, workspaceId, ...(input.parentId ? { parentId: input.parentId } : {}),
        title: input.title, position: position.toString(), childCount: 0 } };
    });
  }

  async listNoteTree(memberId: string, workspaceId: string) {
    return this.kernel.withSession(async (client) => {
      await this.prepare(client);
      const access = await client.query<{ allowed: boolean }>(`SELECT ${workspaceMember("stash_workspaces")} AS allowed
        FROM stash_workspaces WHERE id=$1`, [workspaceId, memberId]);
      if (!access.rows[0]?.allowed) return { status: "workspace_forbidden" as const };
      const result = await client.query<any>(`WITH RECURSIVE tree AS (
        SELECT note.id,note.workspace_id,note.parent_id,note.title,note.tree_position,ARRAY[note.tree_position] AS ordering
        FROM stash_notes note WHERE note.workspace_id=$1 AND note.parent_id IS NULL AND note.archived_at IS NULL AND note.trashed_at IS NULL
        UNION ALL SELECT child.id,child.workspace_id,child.parent_id,child.title,child.tree_position,tree.ordering || child.tree_position
        FROM stash_notes child JOIN tree ON tree.id=child.parent_id WHERE child.archived_at IS NULL AND child.trashed_at IS NULL
      ) SELECT tree.*,(SELECT count(*)::integer FROM stash_notes child WHERE child.parent_id=tree.id
        AND child.archived_at IS NULL AND child.trashed_at IS NULL) AS child_count FROM tree ORDER BY ordering,id`, [workspaceId]);
      const nodes: NoteTreeNode[] = result.rows.map((row: any) => ({ id: row.id, workspaceId: row.workspace_id,
        ...(row.parent_id ? { parentId: row.parent_id } : {}), title: row.title, position: String(row.tree_position), childCount: Number(row.child_count) }));
      return { status: "found" as const, nodes };
    });
  }

  async #effectiveProjects(client: PostgresQueryable, noteId?: string): Promise<string[]> {
    if (!noteId) return [];
    const result = await client.query<{ project_id: string }>(`WITH RECURSIVE path AS (
      SELECT id,parent_id,project_id FROM stash_notes WHERE id=$1
      UNION ALL SELECT parent.id,parent.parent_id,parent.project_id FROM stash_notes parent JOIN path ON path.parent_id=parent.id
    ) SELECT DISTINCT project_id FROM path WHERE project_id IS NOT NULL ORDER BY project_id`, [noteId]);
    return result.rows.map(({ project_id }) => project_id);
  }

  async #accessChanges(client: PostgresQueryable, noteId: string, destinationParentId?: string,
    removing = false): Promise<NoteTreeAccessChange[]> {
    const branch = await client.query<{ id: string; title: string; parent_id: string | null; project_id: string | null }>(`WITH RECURSIVE branch AS (
      SELECT id,title,parent_id,project_id,tree_position,ARRAY[tree_position] AS ordering FROM stash_notes WHERE id=$1
      UNION ALL SELECT child.id,child.title,child.parent_id,child.project_id,child.tree_position,branch.ordering || child.tree_position
        FROM stash_notes child JOIN branch ON child.parent_id=branch.id
    ) SELECT id,title,parent_id,project_id FROM branch ORDER BY ordering,id`, [noteId]);
    const byId = new Map(branch.rows.map((row) => [row.id, row]));
    const destinationProjects = new Set(await this.#effectiveProjects(client, destinationParentId));
    const changes: Array<Omit<NoteTreeAccessChange, "projectName">> = [];
    for (const row of branch.rows) {
      const before = new Set(await this.#effectiveProjects(client, row.id));
      const after = new Set<string>();
      let cursor: typeof row | undefined = row;
      while (!removing && cursor) {
        if (cursor.project_id) after.add(cursor.project_id);
        cursor = cursor.parent_id ? byId.get(cursor.parent_id) : undefined;
      }
      if (!removing) for (const projectId of destinationProjects) after.add(projectId);
      for (const projectId of [...before].sort()) if (!after.has(projectId)) changes.push({ noteId: row.id, noteTitle: row.title, projectId, effect: "lost" });
      for (const projectId of [...after].sort()) if (!before.has(projectId)) changes.push({ noteId: row.id, noteTitle: row.title, projectId, effect: "gained" });
    }
    if (!changes.length) return [];
    const projects = await client.query<{ id: string; name: string }>(
      "SELECT id,name FROM stash_projects WHERE id=ANY($1::uuid[])", [[...new Set(changes.map(({ projectId }) => projectId))]]);
    const names = new Map(projects.rows.map(({ id, name }) => [id, name]));
    return changes.map((change) => ({ ...change, projectName: names.get(change.projectId) ?? "Project" }));
  }

  async moveNoteTreeBranch(memberId: string, noteId: string, destination: { parentId?: string; beforeId?: string }) {
    return this.kernel.transaction(async (client) => {
      await this.prepare(client);
      const preliminary = await client.query<{ workspace_id: string }>(`SELECT note.workspace_id FROM stash_notes note JOIN stash_workspaces workspace ON workspace.id=note.workspace_id
        WHERE note.id=$1 AND note.archived_at IS NULL AND note.trashed_at IS NULL AND ${workspaceMember("workspace")}`, [noteId, memberId]);
      if (!preliminary.rows[0]) return { status: "note_not_found" as const };
      await client.query("SELECT id FROM stash_workspaces WHERE id=$1 FOR UPDATE", [preliminary.rows[0].workspace_id]);
      const found = await client.query<any>(`SELECT note.* FROM stash_notes note WHERE note.id=$1
        AND note.archived_at IS NULL AND note.trashed_at IS NULL FOR UPDATE`, [noteId]);
      const note = found.rows[0]; if (!note) return { status: "note_not_found" as const };
      const branch = await client.query<{ id: string; title: string }>(`WITH RECURSIVE branch AS (
        SELECT id,title,tree_position,ARRAY[tree_position] AS ordering FROM stash_notes WHERE id=$1
        UNION ALL SELECT child.id,child.title,child.tree_position,branch.ordering || child.tree_position FROM stash_notes child JOIN branch ON child.parent_id=branch.id)
        SELECT id,title FROM branch ORDER BY ordering,id`, [noteId]);
      const movedIds = branch.rows.map(({ id }) => id);
      if (destination.parentId && movedIds.includes(destination.parentId)) return { status: "cycle" as const };
      if (destination.parentId && !(await client.query(`SELECT 1 FROM stash_notes WHERE id=$1 AND workspace_id=$2
        AND archived_at IS NULL AND trashed_at IS NULL`, [destination.parentId, note.workspace_id])).rowCount) return { status: "parent_not_found" as const };
      const projectAccessChanges = await this.#accessChanges(client, noteId, destination.parentId);
      let beforePosition: bigint | undefined;
      if (destination.beforeId) {
        if (movedIds.includes(destination.beforeId)) return { status: "cycle" as const };
        const before = await client.query<{ tree_position: string }>(`SELECT tree_position FROM stash_notes WHERE id=$1 AND workspace_id=$2
          AND parent_id IS NOT DISTINCT FROM $3::uuid AND archived_at IS NULL AND trashed_at IS NULL FOR UPDATE`,
        [destination.beforeId, note.workspace_id, destination.parentId ?? null]);
        if (!before.rows[0]) return { status: "before_not_found" as const };
        beforePosition = BigInt(before.rows[0].tree_position);
      }
      const sameParent = (note.parent_id ?? undefined) === destination.parentId;
      if (sameParent && !destination.beforeId && !(await client.query(`SELECT 1 FROM stash_notes WHERE workspace_id=$1
        AND parent_id IS NOT DISTINCT FROM $2::uuid AND tree_position>$3 AND archived_at IS NULL AND trashed_at IS NULL LIMIT 1`,
      [note.workspace_id, note.parent_id, note.tree_position])).rowCount) return { status: "unchanged" as const, movedIds, projectAccessChanges: [] as [] };
      await client.query(`UPDATE stash_notes SET tree_position=tree_position-1 WHERE workspace_id=$1
        AND parent_id IS NOT DISTINCT FROM $2::uuid AND tree_position>$3`, [note.workspace_id, note.parent_id, note.tree_position]);
      if (sameParent && beforePosition !== undefined && BigInt(note.tree_position) < beforePosition) beforePosition -= 1n;
      let position = beforePosition;
      if (position === undefined) position = BigInt((await client.query<{ position: string }>(`SELECT COALESCE(MAX(tree_position),0)+1 AS position
        FROM stash_notes WHERE workspace_id=$1 AND parent_id IS NOT DISTINCT FROM $2::uuid`, [note.workspace_id, destination.parentId ?? null])).rows[0]!.position);
      else await client.query(`UPDATE stash_notes SET tree_position=tree_position+1 WHERE workspace_id=$1
        AND parent_id IS NOT DISTINCT FROM $2::uuid AND tree_position >= $3`, [note.workspace_id, destination.parentId ?? null, position.toString()]);
      await client.query("UPDATE stash_notes SET parent_id=$2,tree_position=$3,location_revision=location_revision+1 WHERE id=$1",
        [noteId, destination.parentId ?? null, position.toString()]);
      await this.#recordLocation(client, { ...note, parent_id: destination.parentId ?? null, tree_position: position.toString(),
        location_revision: Number(note.location_revision) + 1 });
      return { status: "moved" as const, movedIds, projectAccessChanges };
    });
  }

  async previewNoteBranch(memberId: string, noteId: string, action: "archive" | "trash" | "move",
    destination?: { parentId?: string; beforeId?: string }) {
    return this.kernel.withSession(async (client) => {
      await this.prepare(client);
      const found = await client.query<any>(`SELECT note.id,note.workspace_id,note.title FROM stash_notes note JOIN stash_workspaces workspace
        ON workspace.id=note.workspace_id WHERE note.id=$1 AND note.trashed_at IS NULL AND ${workspaceMember("workspace")}`, [noteId, memberId]);
      const note = found.rows[0]; if (!note) return { status: "note_not_found" as const };
      const branch = await client.query<{ id: string; title: string }>(`WITH RECURSIVE branch AS (
        SELECT id,title,tree_position,ARRAY[tree_position] AS ordering FROM stash_notes WHERE id=$1
        UNION ALL SELECT child.id,child.title,child.tree_position,branch.ordering || child.tree_position FROM stash_notes child JOIN branch ON child.parent_id=branch.id)
        SELECT id,title FROM branch ORDER BY ordering,id`, [noteId]);
      const ids = branch.rows.map(({ id }) => id);
      if (action === "move") {
        if (destination?.parentId && ids.includes(destination.parentId)) return { status: "cycle" as const };
        if (destination?.parentId && !(await client.query(`SELECT 1 FROM stash_notes WHERE id=$1 AND workspace_id=$2
          AND archived_at IS NULL AND trashed_at IS NULL`, [destination.parentId, note.workspace_id])).rowCount) return { status: "parent_not_found" as const };
        if (destination?.beforeId && !(await client.query(`SELECT 1 FROM stash_notes WHERE id=$1 AND workspace_id=$2
          AND parent_id IS NOT DISTINCT FROM $3::uuid AND archived_at IS NULL AND trashed_at IS NULL`,
        [destination.beforeId, note.workspace_id, destination.parentId ?? null])).rowCount) return { status: "before_not_found" as const };
      }
      const external = await client.query<any>(`SELECT linked.id,linked.title,edge.direction FROM (
        SELECT target_note_id AS linked_id,'outgoing' AS direction FROM stash_note_links WHERE source_note_id=ANY($1::uuid[]) AND NOT target_note_id=ANY($1::uuid[])
        UNION ALL SELECT source_note_id AS linked_id,'incoming' AS direction FROM stash_note_links WHERE target_note_id=ANY($1::uuid[]) AND NOT source_note_id=ANY($1::uuid[])
      ) edge JOIN stash_notes linked ON linked.id=edge.linked_id ORDER BY linked.title,linked.id,edge.direction`, [ids]);
      return { status: "found" as const, impact: { noteId, title: note.title, descendantCount: ids.length - 1,
        descendants: branch.rows.slice(1).map(({ id, title }) => ({ noteId: id, title })), affectedNoteIds: ids,
        externalLinks: external.rows.map(({ id, title, direction }: any) => ({ noteId: id, title, direction })),
        projectAccessChanges: await this.#accessChanges(client, noteId, destination?.parentId, action !== "move") } };
    });
  }

  async listRemovedNoteBranches(memberId: string, workspaceId: string) {
    return this.kernel.withSession(async (client) => {
      await this.prepare(client);
      const access = await client.query<{ allowed: boolean }>(`SELECT ${workspaceMember("stash_workspaces")} AS allowed
        FROM stash_workspaces WHERE id=$1`, [workspaceId, memberId]);
      if (!access.rows[0]?.allowed) return { status: "workspace_forbidden" as const };
      const result = await client.query<any>(`SELECT note.id,note.workspace_id,note.title,
        CASE WHEN note.trashed_at IS NOT NULL THEN 'trashed' ELSE 'archived' END AS state,
        COALESCE(note.trashed_at,note.archived_at) AS removed_at
        FROM stash_notes note LEFT JOIN stash_notes parent ON parent.id=note.parent_id
        WHERE note.workspace_id=$1 AND (note.archived_at IS NOT NULL OR note.trashed_at IS NOT NULL)
          AND (note.parent_id IS NULL OR (parent.archived_at IS NULL AND parent.trashed_at IS NULL))
        ORDER BY removed_at DESC,note.title,note.id`, [workspaceId]);
      return { status: "found" as const, branches: result.rows.map((row: any) => ({ id: row.id, workspaceId: row.workspace_id,
        title: row.title, state: row.state, removedAt: new Date(row.removed_at).toISOString() })) };
    });
  }

  async #recordLocation(client: PostgresQueryable, row: any): Promise<void> {
    const aliases = await client.query<{ path: string }>("SELECT path FROM stash_note_path_aliases WHERE note_id=$1 ORDER BY created_at,path", [row.id]);
    const location: PortableNoteLocationProjection = { schema: "stash.note-location.v1", noteId: row.id, workspaceId: row.workspace_id,
      path: row.portable_path, aliases: aliases.rows.map(({ path }) => path), revision: Number(row.location_revision),
      ...(row.parent_id ? { parentId: row.parent_id } : {}), position: String(row.tree_position),
      ...(row.archived_at ? { archivedAt: new Date(row.archived_at).toISOString() } : {}),
      ...(row.trashed_at ? { trashedAt: new Date(row.trashed_at).toISOString() } : {}) };
    await this.#projection(client, "NoteLocation", row.id, location.schema, location);
  }

  async setNoteBranchState(memberId: string, noteId: string, state: "archived" | "trashed") {
    return this.kernel.transaction(async (client) => {
      await this.prepare(client);
      const preliminary = await client.query<{ workspace_id: string }>(`SELECT note.workspace_id FROM stash_notes note JOIN stash_workspaces workspace ON workspace.id=note.workspace_id WHERE note.id=$1
        AND ${workspaceMember("workspace")}`, [noteId, memberId]);
      if (!preliminary.rows[0]) return { status: "note_not_found" as const };
      await client.query("SELECT id FROM stash_workspaces WHERE id=$1 FOR UPDATE", [preliminary.rows[0].workspace_id]);
      if (!(await client.query("SELECT 1 FROM stash_notes WHERE id=$1 FOR UPDATE", [noteId])).rowCount) return { status: "note_not_found" as const };
      const branch = await client.query<{ id: string }>(`WITH RECURSIVE branch AS (
        SELECT id,tree_position,ARRAY[tree_position] AS ordering FROM stash_notes WHERE id=$1
        UNION ALL SELECT child.id,child.tree_position,branch.ordering || child.tree_position FROM stash_notes child JOIN branch ON child.parent_id=branch.id
      ) SELECT id FROM branch ORDER BY ordering,id`, [noteId]);
      const permitted = await this.lifecycle?.beforeStateChange(client, branch.rows.map(({ id }) => id), state);
      if (permitted === "collection_owner_requires_relocation") return { status: "collection_owner_requires_relocation" as const };
      const column = state === "archived" ? "archived_at" : "trashed_at";
      const rows = await client.query<any>(`WITH RECURSIVE branch AS (
        SELECT id,tree_position,ARRAY[tree_position] AS ordering FROM stash_notes WHERE id=$1
        UNION ALL SELECT child.id,child.tree_position,branch.ordering || child.tree_position FROM stash_notes child JOIN branch ON child.parent_id=branch.id
      ), updated AS (UPDATE stash_notes SET ${column}=CURRENT_TIMESTAMP,location_revision=location_revision+1
        WHERE id IN (SELECT id FROM branch) RETURNING *) SELECT updated.* FROM updated JOIN branch USING(id) ORDER BY branch.ordering,updated.id`, [noteId]);
      for (const row of rows.rows) await this.#recordLocation(client, row);
      return { status: "updated" as const, affectedIds: rows.rows.map(({ id }: any) => id) };
    });
  }

  async restoreNoteBranch(memberId: string, noteId: string) {
    return this.kernel.transaction(async (client) => {
      await this.prepare(client);
      const preliminary = await client.query<{ workspace_id: string }>(`SELECT note.workspace_id FROM stash_notes note JOIN stash_workspaces workspace ON workspace.id=note.workspace_id
        WHERE note.id=$1 AND (note.archived_at IS NOT NULL OR note.trashed_at IS NOT NULL) AND ${workspaceMember("workspace")}`, [noteId, memberId]);
      if (!preliminary.rows[0]) return { status: "note_not_found" as const };
      await client.query("SELECT id FROM stash_workspaces WHERE id=$1 FOR UPDATE", [preliminary.rows[0].workspace_id]);
      const found = await client.query<any>(`SELECT * FROM stash_notes WHERE id=$1
        AND (archived_at IS NOT NULL OR trashed_at IS NOT NULL) FOR UPDATE`, [noteId]);
      const root = found.rows[0]; if (!root) return { status: "note_not_found" as const };
      let parentRestored = true;
      if (root.parent_id && !(await client.query("SELECT 1 FROM stash_notes WHERE id=$1 AND archived_at IS NULL AND trashed_at IS NULL", [root.parent_id])).rowCount) {
        parentRestored = false;
        const end = await client.query<{ position: string }>("SELECT COALESCE(MAX(tree_position),0)+1 AS position FROM stash_notes WHERE workspace_id=$1 AND parent_id IS NULL", [root.workspace_id]);
        await client.query("UPDATE stash_notes SET parent_id=NULL,tree_position=$2 WHERE id=$1", [noteId, end.rows[0]!.position]);
      }
      const rows = await client.query<any>(`WITH RECURSIVE branch AS (
        SELECT id,tree_position,ARRAY[tree_position] AS ordering FROM stash_notes WHERE id=$1
        UNION ALL SELECT child.id,child.tree_position,branch.ordering || child.tree_position FROM stash_notes child JOIN branch ON child.parent_id=branch.id
      ), updated AS (UPDATE stash_notes SET archived_at=NULL,trashed_at=NULL,location_revision=location_revision+1
        WHERE id IN (SELECT id FROM branch) RETURNING *) SELECT updated.* FROM updated JOIN branch USING(id) ORDER BY branch.ordering,updated.id`, [noteId]);
      for (const row of rows.rows) await this.#recordLocation(client, row);
      return { status: "restored" as const, restoredIds: rows.rows.map(({ id }: any) => id), parentRestored };
    });
  }

  async readNoteTreeContext(memberId: string, noteId: string) {
    return this.kernel.withSession(async (client) => {
      await this.prepare(client);
      const authorized = await client.query<{ workspace_id: string; parent_id: string | null; revision: number; created_at: string; workspace_access: boolean }>(`SELECT
        note.workspace_id,note.parent_id,note.revision,note.created_at,
        ${workspaceMember("workspace")} AS workspace_access
        FROM stash_notes note JOIN stash_workspaces workspace ON workspace.id=note.workspace_id
        WHERE note.id=$1 AND note.archived_at IS NULL AND note.trashed_at IS NULL AND
        (${workspaceMember("workspace")} OR ${inheritedProjectGuest("note")})`, [noteId, memberId]);
      const access = authorized.rows[0];
      if (!access) return { status: "note_not_found" as const };
      const guestProjects = access.workspace_access ? new Set<string>() : new Set((await client.query<{ project_id: string }>(
        "SELECT project_id FROM stash_project_guests WHERE account_id=$1 ORDER BY project_id", [memberId])).rows.map(({ project_id }) => project_id));
      const ancestors = await client.query<any>(`WITH RECURSIVE path AS (SELECT id,parent_id,title,project_id,0 AS depth FROM stash_notes WHERE id=$1
        UNION ALL SELECT parent.id,parent.parent_id,parent.title,parent.project_id,path.depth+1 FROM stash_notes parent JOIN path ON path.parent_id=parent.id)
        SELECT id,title,project_id FROM path ORDER BY depth DESC`, [noteId]);
      const outgoing = await client.query<any>(`SELECT link.id,link.target_note_id AS note_id,target.title,link.label,link.relationship_type
        FROM stash_note_links link JOIN stash_notes target ON target.id=link.target_note_id WHERE link.source_note_id=$1
        AND target.archived_at IS NULL AND target.trashed_at IS NULL ORDER BY target.title,target.id`, [noteId]);
      const backlinks = await client.query<any>(`SELECT link.id,link.source_note_id AS note_id,source.title,link.label,link.relationship_type
        FROM stash_note_links link JOIN stash_notes source ON source.id=link.source_note_id WHERE link.target_note_id=$1
        AND source.archived_at IS NULL AND source.trashed_at IS NULL ORDER BY source.title,source.id`, [noteId]);
      const projectIds = await this.#effectiveProjects(client, noteId);
      const visibleProjectIds = access.workspace_access ? projectIds : projectIds.filter((projectId) => guestProjects.has(projectId));
      const projects = visibleProjectIds.length ? await client.query<{ id: string; name: string; project_key: string }>(
        "SELECT id,name,project_key FROM stash_projects WHERE id=ANY($1::uuid[]) ORDER BY name,id", [visibleProjectIds]) : { rows: [] };
      const visibleLinks = async (rows: any[]) => {
        if (access.workspace_access) return rows;
        const visible: any[] = [];
        for (const row of rows) if ((await this.#effectiveProjects(client, row.note_id)).some((projectId) => guestProjects.has(projectId))) visible.push(row);
        return visible;
      };
      const links = (rows: any[]) => rows.map(({ id, note_id, title, label, relationship_type }) => ({ id, noteId: note_id, title, label,
        ...(relationship_type ? { relationshipType: relationship_type } : {}) }));
      const visibleBreadcrumbs: Array<{ id: string; title: string }> = [];
      const inheritedProjects = new Set<string>();
      for (const row of ancestors.rows) {
        if (row.project_id) inheritedProjects.add(row.project_id);
        if (access.workspace_access || [...inheritedProjects].some((projectId) => guestProjects.has(projectId)))
          visibleBreadcrumbs.push({ id: row.id, title: row.title });
      }
      const parent = visibleBreadcrumbs.at(-2);
      return { status: "found" as const, context: { noteId, workspaceId: access.workspace_id, state: "active" as const,
        ...(parent && parent.id === access.parent_id ? { parent } : {}), revision: Number(access.revision),
        createdAt: new Date(access.created_at).toISOString(), historyCount: Number(access.revision),
        access: access.workspace_access ? "edit" as const : "read" as const,
        accessSource: access.workspace_access ? "workspace" as const : "project" as const, breadcrumbs: visibleBreadcrumbs,
        outgoingLinks: links(await visibleLinks(outgoing.rows)), backlinks: links(await visibleLinks(backlinks.rows)),
        projectIds: visibleProjectIds, projects: projects.rows.map(({ id, name, project_key }) => ({ id, name, key: project_key })) } };
    });
  }

  /** Temporary legacy collaboration delegation until the Note editor consumes this capability directly. */
  async authorizeNote(client: PostgresQueryable, memberId: string, noteId: string): Promise<"edit" | "read" | "none"> {
    const result = await client.query<{ can_edit: boolean; can_read: boolean }>(`SELECT
      ${workspaceMember("workspace")} AS can_edit,
      (${workspaceMember("workspace")} OR ${inheritedProjectGuest("note")}) AS can_read
      FROM stash_notes note JOIN stash_workspaces workspace ON workspace.id=note.workspace_id WHERE note.id=$1`, [noteId, memberId]);
    return result.rows[0]?.can_edit ? "edit" : result.rows[0]?.can_read ? "read" : "none";
  }

  async createContextLink(memberId: string, sourceNoteId: string,
    link: { id: string; targetNoteId: string; label: string; relationshipType?: string }) {
    return this.kernel.transaction(async (client) => {
      await this.prepare(client);
      const source = await client.query<any>(`SELECT note.workspace_id,note.portable_path FROM stash_notes note
        JOIN stash_workspaces workspace ON workspace.id=note.workspace_id WHERE note.id=$1
        AND note.archived_at IS NULL AND note.trashed_at IS NULL AND ${workspaceMember("workspace")}`, [sourceNoteId, memberId]);
      if (!source.rows[0]) return { status: "source_not_found" as const };
      const target = await client.query<{ title: string; portable_path: string }>(`SELECT title,portable_path FROM stash_notes
        WHERE id=$1 AND workspace_id=$2 AND archived_at IS NULL AND trashed_at IS NULL`, [link.targetNoteId, source.rows[0].workspace_id]);
      if (!target.rows[0]) return { status: "target_not_found" as const };
      const inserted = await client.query(`INSERT INTO stash_note_links
        (id,workspace_id,source_note_id,target_note_id,target_path,label,relationship_type,revision)
        VALUES($1,$2,$3,$4,$5,$6,$7,1) ON CONFLICT(source_note_id,target_note_id) DO NOTHING RETURNING id`,
      [link.id, source.rows[0].workspace_id, sourceNoteId, link.targetNoteId, target.rows[0].portable_path, link.label, link.relationshipType ?? null]);
      if (!inserted.rowCount) return { status: "already_linked" as const };
      const projection: PortableNoteLinkStateProjection = { schema: "stash.note-link.v2", id: link.id,
        workspaceId: source.rows[0].workspace_id, sourceNoteId, targetNoteId: link.targetNoteId, label: link.label,
        ...(link.relationshipType ? { relationshipType: link.relationshipType } : {}), revision: 1 };
      await this.#projection(client, "NoteLink", link.id, projection.schema, projection);
      return { status: "created" as const, link: { id: link.id, noteId: link.targetNoteId,
        title: target.rows[0].title, label: link.label, ...(link.relationshipType ? { relationshipType: link.relationshipType } : {}) } };
    });
  }
}
