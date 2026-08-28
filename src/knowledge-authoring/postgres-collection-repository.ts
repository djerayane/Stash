import type { PostgresKernel, PostgresQueryable } from "../instance-operations/storage/postgres-kernel.js";
import { effectiveNoteReadSql } from "./postgres-note-access.js";
import { normalizeCollection, type Collection as CanonicalCollection, type CollectionImpact, type CollectionPropertyImpact,
  type CollectionPropertyValue, type CollectionRecord as CanonicalRecord, type ViewBlock as CanonicalViewBlock, type ViewDefinition } from "@stash/domain-types";
import type { CollectionProperty as CanonicalProperty } from "@stash/domain-types";
import type { CollectionRepository, CollectionViewResult } from "./collections.js";

type PrepareNotes = (client: PostgresQueryable) => Promise<void>;
export type TaskViewSource = (memberId: string, workspaceId: string) => Promise<
  { status: "found"; tasks: readonly unknown[]; workflow?: {statuses:readonly unknown[]} } | { status: "workspace_not_found" }
>;
const member = `(workspace.owner_type='personal' AND workspace.personal_owner_id=$2) OR
  (workspace.owner_type='organization' AND EXISTS (SELECT 1 FROM stash_organization_memberships membership
    WHERE membership.organization_id=workspace.organization_owner_id AND membership.account_id=$2))`;

/** Focused canonical Collection and View Block persistence over the shared Postgres kernel. */
export class PostgresCollectionRepository implements CollectionRepository {
  constructor(private readonly kernel: PostgresKernel, private readonly prepareNotes: PrepareNotes,
    private readonly taskViewSource?: TaskViewSource) {}

  async prepare(client: PostgresQueryable): Promise<void> {
    await this.prepareNotes(client);
    await client.query(`
      CREATE TABLE IF NOT EXISTS stash_collections (
        id UUID PRIMARY KEY, workspace_id UUID NOT NULL REFERENCES stash_workspaces(id) ON DELETE CASCADE,
        owner_note_id UUID NOT NULL REFERENCES stash_notes(id) ON DELETE RESTRICT, title TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS stash_collection_properties (
        id UUID PRIMARY KEY, collection_id UUID NOT NULL REFERENCES stash_collections(id) ON DELETE CASCADE,
        name TEXT NOT NULL, property_type TEXT NOT NULL CHECK(property_type IN ('text','number','checkbox','date_time','single_select','multi_select','person','url','attachment','relation')),
        configuration JSONB NOT NULL DEFAULT '{}'::jsonb, position INTEGER NOT NULL CHECK(position>0),
        UNIQUE(collection_id,position)
      );
      CREATE TABLE IF NOT EXISTS stash_collection_records (
        id UUID PRIMARY KEY, collection_id UUID NOT NULL REFERENCES stash_collections(id) ON DELETE CASCADE,
        position INTEGER NOT NULL CHECK(position>0), UNIQUE(collection_id,position)
      );
      CREATE TABLE IF NOT EXISTS stash_collection_record_values (
        record_id UUID NOT NULL REFERENCES stash_collection_records(id) ON DELETE CASCADE,
        property_id UUID NOT NULL REFERENCES stash_collection_properties(id) ON DELETE CASCADE,
        value JSONB NOT NULL, PRIMARY KEY(record_id,property_id)
      );
      CREATE TABLE IF NOT EXISTS stash_view_blocks (
        id UUID PRIMARY KEY, workspace_id UUID NOT NULL REFERENCES stash_workspaces(id) ON DELETE CASCADE,
        owner_note_id UUID NOT NULL REFERENCES stash_notes(id) ON DELETE RESTRICT,
        block_id UUID NOT NULL UNIQUE, title TEXT NOT NULL, source_kind TEXT NOT NULL CHECK(source_kind IN ('tasks','collection')),
        source_workspace_id UUID REFERENCES stash_workspaces(id), source_project_scope TEXT CHECK(source_project_scope='none'),
        source_collection_id UUID REFERENCES stash_collections(id) ON DELETE RESTRICT,
        query JSONB, layout TEXT NOT NULL CHECK(layout IN ('list','table','board','calendar')), definition JSONB
      );
    `);
  }
  async create(memberId: string, collection: CanonicalCollection): Promise<
    { status: "created"; collection: CanonicalCollection }
    | { status: "note_not_found" | "workspace_mismatch" | "collection_conflict" }> {
    return this.kernel.transaction(async (client) => {
      await this.prepare(client);
      const owner = await client.query<{ workspace_id: string }>(`SELECT note.workspace_id FROM stash_notes note
        JOIN stash_workspaces workspace ON workspace.id=note.workspace_id
        WHERE note.id=$1 AND note.archived_at IS NULL AND note.trashed_at IS NULL AND (${member})`,
      [collection.ownerNoteId, memberId]);
      if (!owner.rows[0]) return { status: "note_not_found" as const };
      if (owner.rows[0].workspace_id !== collection.workspaceId) return { status: "workspace_mismatch" as const };
      try {
        await client.query("INSERT INTO stash_collections(id,workspace_id,owner_note_id,title) VALUES($1,$2,$3,$4)",
          [collection.id, collection.workspaceId, collection.ownerNoteId, collection.title]);
        for (const property of collection.properties) {
          const configuration = property.type === "single_select" || property.type === "multi_select" ? { options: property.options }
            : property.type === "relation" ? { target: property.target } : {};
          await client.query(`INSERT INTO stash_collection_properties(id,collection_id,name,property_type,configuration,position)
            VALUES($1,$2,$3,$4,$5::jsonb,$6)`, [property.id, collection.id, property.name, property.type, JSON.stringify(configuration), property.position]);
        }
        for (const record of collection.records) {
          await client.query("INSERT INTO stash_collection_records(id,collection_id,position) VALUES($1,$2,$3)", [record.id, collection.id, record.position]);
          for (const [propertyId, value] of Object.entries(record.values)) await client.query(`INSERT INTO stash_collection_record_values
            (record_id,property_id,value) VALUES($1,$2,$3::jsonb)`, [record.id, propertyId, JSON.stringify(value)]);
        }
      } catch (error) {
        if (error && typeof error === "object" && "code" in error && error.code === "23505") return { status: "collection_conflict" as const };
        throw error;
      }
      await this.projection(client, "Collection", collection.id, collection.schema, collection);
      return { status: "created" as const, collection };
    });
  }

  async readCollection(memberId: string, collectionId: string): Promise<
    { status: "found"; collection: CanonicalCollection } | { status: "collection_not_found" }> {
    return this.kernel.withSession(async (client) => {
      await this.prepare(client);
      const authorized = await client.query<{ id: string }>(`SELECT collection.id FROM stash_collections collection
        JOIN stash_notes note ON note.id=collection.owner_note_id JOIN stash_workspaces workspace ON workspace.id=collection.workspace_id
        WHERE collection.id=$1 AND ${effectiveNoteReadSql("note", "workspace", "$2")}`, [collectionId, memberId]);
      if (!authorized.rows[0]) return { status: "collection_not_found" as const };
      return { status: "found" as const, collection: await this.permissionFilteredCollection(client, memberId,
        await this.canonicalCollection(client, collectionId)) };
    });
  }

  async renameCollection(memberId: string, collectionId: string, title: string): Promise<
    { status: "updated"; collection: CanonicalCollection } | { status: "collection_not_found" }> {
    return this.kernel.transaction(async (client) => {
      await this.prepare(client);
      const updated = await client.query(`UPDATE stash_collections collection SET title=$3 FROM stash_workspaces workspace
        WHERE collection.id=$1 AND workspace.id=collection.workspace_id AND (${member}) RETURNING collection.id`, [collectionId, memberId, title]);
      if (!updated.rowCount) return { status: "collection_not_found" as const };
      const collection = await this.canonicalCollection(client, collectionId);
      await this.projection(client, "Collection", collectionId, collection.schema, collection);
      return { status: "updated" as const, collection };
    });
  }

  async renameCollectionProperty(memberId: string, collectionId: string, propertyId: string, name: string): Promise<
    { status: "updated"; collection: CanonicalCollection } | { status: "collection_not_found" | "property_not_found" }> {
    return this.kernel.transaction(async (client) => {
      await this.prepare(client);
      const authorized = await client.query(`SELECT collection.id FROM stash_collections collection JOIN stash_workspaces workspace
        ON workspace.id=collection.workspace_id WHERE collection.id=$1 AND (${member}) FOR UPDATE OF collection`, [collectionId, memberId]);
      if (!authorized.rowCount) return { status: "collection_not_found" as const };
      const updated = await client.query("UPDATE stash_collection_properties SET name=$3 WHERE collection_id=$1 AND id=$2 RETURNING id",
        [collectionId, propertyId, name]);
      if (!updated.rowCount) return { status: "property_not_found" as const };
      const collection = await this.canonicalCollection(client, collectionId);
      await this.projection(client, "Collection", collectionId, collection.schema, collection);
      return { status: "updated" as const, collection };
    });
  }

  async createCollectionProperty(memberId: string, collectionId: string, property: CanonicalProperty): Promise<
    { status: "created"; property: CanonicalProperty } | { status: "collection_not_found" | "property_conflict" }> {
    return this.kernel.transaction(async (client) => {
      await this.prepare(client);
      if (!(await client.query(`SELECT collection.id FROM stash_collections collection JOIN stash_workspaces workspace
        ON workspace.id=collection.workspace_id WHERE collection.id=$1 AND (${member}) FOR UPDATE OF collection`, [collectionId, memberId])).rowCount)
        return { status: "collection_not_found" as const };
      const configuration = property.type === "single_select" || property.type === "multi_select" ? { options: property.options }
        : property.type === "relation" ? { target: property.target } : {};
      try { await client.query(`INSERT INTO stash_collection_properties(id,collection_id,name,property_type,configuration,position)
        VALUES($1,$2,$3,$4,$5::jsonb,$6)`, [property.id, collectionId, property.name, property.type,
        JSON.stringify(configuration), property.position]); }
      catch (error) { if (error && typeof error === "object" && "code" in error && error.code === "23505")
        return { status: "property_conflict" as const }; throw error; }
      const collection = await this.canonicalCollection(client, collectionId);
      await this.projection(client, "Collection", collectionId, collection.schema, collection);
      return { status: "created" as const, property };
    });
  }

  async updateCollectionProperty(memberId: string, collectionId: string, propertyId: string, input: Readonly<Record<string, unknown>>): Promise<
    { status: "updated"; collection: CanonicalCollection }
    | { status: "collection_not_found" | "property_not_found" | "primary_property_required" | "invalid_property" }> {
    return this.kernel.transaction(async (client) => {
      await this.prepare(client);
      if (!(await client.query(`SELECT collection.id FROM stash_collections collection JOIN stash_workspaces workspace
        ON workspace.id=collection.workspace_id WHERE collection.id=$1 AND (${member}) FOR UPDATE OF collection`, [collectionId, memberId])).rowCount)
        return { status: "collection_not_found" as const };
      const current = await this.canonicalCollection(client, collectionId);
      const property = current.properties.find(({ id }) => id === propertyId);
      if (!property) return { status: "property_not_found" as const };
      if (property.type === "text" && input.type !== undefined && input.type !== "text"
        && current.properties.filter(({ type }) => type === "text").length === 1)
        return { status: "primary_property_required" as const };
      const candidate: Record<string, unknown> = { ...property, ...input, id: property.id, position: property.position };
      if (input.type !== "single_select" && input.type !== "multi_select" && input.type !== undefined) delete candidate.options;
      if (input.type !== "relation" && input.type !== undefined) delete candidate.target;
      let normalized: CanonicalCollection;
      try { normalized = normalizeCollection({ ...current,
        properties: current.properties.map((entry) => entry.id === propertyId ? candidate : entry) }); }
      catch { return { status: "invalid_property" as const }; }
      if (current.properties.some(({ type }) => type === "text") && !normalized.properties.some(({ type }) => type === "text"))
        return { status: "primary_property_required" as const };
      const next = normalized.properties.find(({ id }) => id === propertyId)!;
      const configuration = next.type === "single_select" || next.type === "multi_select" ? { options: next.options }
        : next.type === "relation" ? { target: next.target } : {};
      const updated = await client.query(`UPDATE stash_collection_properties SET name=$3,property_type=$4,configuration=$5::jsonb
        WHERE collection_id=$1 AND id=$2 RETURNING id`, [collectionId, next.id, next.name, next.type, JSON.stringify(configuration)]);
      if (!updated.rowCount) return { status: "property_not_found" as const };
      const collection = await this.canonicalCollection(client, collectionId);
      await this.projection(client, "Collection", collectionId, collection.schema, collection);
      return { status: "updated" as const, collection };
    });
  }

  async reorderCollectionProperties(memberId: string, collectionId: string, properties: readonly CanonicalProperty[]): Promise<
    { status: "updated"; collection: CanonicalCollection } | { status: "collection_not_found" | "property_not_found" }> {
    return this.kernel.transaction(async (client) => {
      await this.prepare(client);
      if (!(await client.query(`SELECT collection.id FROM stash_collections collection JOIN stash_workspaces workspace
        ON workspace.id=collection.workspace_id WHERE collection.id=$1 AND (${member}) FOR UPDATE OF collection`, [collectionId, memberId])).rowCount)
        return { status: "collection_not_found" as const };
      const locked = await client.query<{ id: string }>("SELECT id FROM stash_collection_properties WHERE collection_id=$1 FOR UPDATE", [collectionId]);
      if (locked.rows.length !== properties.length || properties.some((property) => !locked.rows.some(({ id }) => id === property.id)))
        return { status: "property_not_found" as const };
      await client.query("UPDATE stash_collection_properties SET position=position+1000000 WHERE collection_id=$1", [collectionId]);
      for (const property of properties) await client.query("UPDATE stash_collection_properties SET position=$3 WHERE collection_id=$1 AND id=$2",
        [collectionId, property.id, property.position]);
      const collection = await this.canonicalCollection(client, collectionId);
      await this.projection(client, "Collection", collectionId, collection.schema, collection);
      return { status: "updated" as const, collection };
    });
  }

  async previewCollectionPropertyRemoval(memberId: string, collectionId: string, propertyId: string): Promise<
    { status: "found"; impact: CollectionPropertyImpact }
    | { status: "collection_not_found" | "property_not_found" | "primary_property_required" }> {
    return this.kernel.withSession(async (client) => {
      await this.prepare(client);
      if (!(await client.query(`SELECT collection.id FROM stash_collections collection JOIN stash_workspaces workspace
        ON workspace.id=collection.workspace_id WHERE collection.id=$1 AND (${member})`, [collectionId, memberId])).rowCount)
        return { status: "collection_not_found" as const };
      const collection = await this.canonicalCollection(client, collectionId);
      const property = collection.properties.find(({ id }) => id === propertyId);
      if (!property) return { status: "property_not_found" as const };
      if (property.type === "text" && collection.properties.filter(({ type }) => type === "text").length === 1)
        return { status: "primary_property_required" as const };
      return { status: "found" as const, impact: (await this.propertyRemovalImpact(client, collectionId, propertyId, property.type, false)).impact };
    });
  }

  async deleteCollectionProperty(memberId: string, collectionId: string, propertyId: string, impactToken: string): Promise<
    { status: "updated"; collection: CanonicalCollection; impact: CollectionPropertyImpact }
    | { status: "impact_changed"; impact: CollectionPropertyImpact }
    | { status: "collection_not_found" | "property_not_found" | "primary_property_required" }> {
    return this.kernel.transaction(async (client) => {
      await this.prepare(client);
      if (!(await client.query(`SELECT collection.id FROM stash_collections collection JOIN stash_workspaces workspace
        ON workspace.id=collection.workspace_id WHERE collection.id=$1 AND (${member}) FOR UPDATE OF collection`, [collectionId, memberId])).rowCount)
        return { status: "collection_not_found" as const };
      const current = await this.canonicalCollection(client, collectionId);
      const property = current.properties.find(({ id }) => id === propertyId);
      if (!property) return { status: "property_not_found" as const };
      if (property.type === "text" && current.properties.filter(({ type }) => type === "text").length === 1)
        return { status: "primary_property_required" as const };
      const exact = await this.propertyRemovalImpact(client, collectionId, propertyId, property.type, true);
      if (exact.impact.token !== impactToken) return { status: "impact_changed" as const, impact: exact.impact };
      for (const id of exact.affectedViewIds) {
        const view = await this.canonicalView(client, id); const definition = withoutProperty(view.definition, propertyId);
        await client.query("UPDATE stash_view_blocks SET definition=$2::jsonb WHERE id=$1", [id, JSON.stringify(definition)]);
        await this.projection(client, "ViewBlock", id, view.schema, { ...view, definition });
      }
      await client.query("DELETE FROM stash_collection_properties WHERE collection_id=$1 AND id=$2", [collectionId, propertyId]);
      const remaining = await client.query<{ id: string }>(`SELECT id FROM stash_collection_properties
        WHERE collection_id=$1 ORDER BY position,id FOR UPDATE`, [collectionId]);
      await client.query("UPDATE stash_collection_properties SET position=position+1000000 WHERE collection_id=$1", [collectionId]);
      for (const [index, row] of remaining.rows.entries()) await client.query("UPDATE stash_collection_properties SET position=$2 WHERE id=$1", [row.id, index + 1]);
      const collection = await this.canonicalCollection(client, collectionId);
      await this.projection(client, "Collection", collectionId, collection.schema, collection);
      return { status: "updated" as const, collection, impact: exact.impact };
    });
  }

  async moveCollectionRecord(memberId: string, collectionId: string, recordId: string, beforeId?: string): Promise<
    { status: "moved" } | { status: "collection_not_found" | "record_not_found" | "before_not_found" }> {
    return this.kernel.transaction(async (client) => {
      await this.prepare(client);
      const authorized = await client.query(`SELECT collection.id FROM stash_collections collection JOIN stash_workspaces workspace
        ON workspace.id=collection.workspace_id WHERE collection.id=$1 AND (${member}) FOR UPDATE OF collection`, [collectionId, memberId]);
      if (!authorized.rowCount) return { status: "collection_not_found" as const };
      const rows = await client.query<{ id: string }>(`SELECT id FROM stash_collection_records WHERE collection_id=$1 ORDER BY position,id FOR UPDATE`, [collectionId]);
      const ids = rows.rows.map(({ id }) => id); const current = ids.indexOf(recordId);
      if (current < 0) return { status: "record_not_found" as const };
      ids.splice(current, 1);
      if (beforeId) {
        const target = ids.indexOf(beforeId); if (target < 0) return { status: "before_not_found" as const }; ids.splice(target, 0, recordId);
      } else ids.push(recordId);
      await client.query("UPDATE stash_collection_records SET position=position+1000000 WHERE collection_id=$1", [collectionId]);
      for (const [index, id] of ids.entries()) await client.query("UPDATE stash_collection_records SET position=$2 WHERE id=$1", [id, index + 1]);
      const collection = await this.canonicalCollection(client, collectionId);
      await this.projection(client, "Collection", collectionId, collection.schema, collection);
      return { status: "moved" as const };
    });
  }

  async createCollectionRecord(memberId: string, collectionId: string, record: CanonicalRecord): Promise<
    { status: "created"; record: CanonicalRecord } | { status: "collection_not_found" | "record_conflict" }> {
    return this.kernel.transaction(async (client) => {
      await this.prepare(client);
      if (!(await client.query(`SELECT collection.id FROM stash_collections collection JOIN stash_workspaces workspace
        ON workspace.id=collection.workspace_id WHERE collection.id=$1 AND (${member}) FOR UPDATE OF collection`, [collectionId, memberId])).rowCount)
        return { status: "collection_not_found" as const };
      try {
        await client.query("INSERT INTO stash_collection_records(id,collection_id,position) VALUES($1,$2,$3)", [record.id, collectionId, record.position]);
        for (const [propertyId, value] of Object.entries(record.values)) await client.query(`INSERT INTO stash_collection_record_values
          (record_id,property_id,value) VALUES($1,$2,$3::jsonb)`, [record.id, propertyId, JSON.stringify(value)]);
      } catch (error) {
        if (error && typeof error === "object" && "code" in error && error.code === "23505") return { status: "record_conflict" as const };
        throw error;
      }
      const collection = await this.canonicalCollection(client, collectionId); await this.projection(client, "Collection", collectionId, collection.schema, collection);
      return { status: "created" as const, record };
    });
  }

  async updateCollectionRecordValues(memberId: string, collectionId: string, recordId: string,
    values: Readonly<Record<string, CollectionPropertyValue>>): Promise<
    { status: "updated"; record: CanonicalRecord }
    | { status: "collection_not_found" | "record_not_found" | "invalid_record" }> {
    return this.kernel.transaction(async (client) => {
      await this.prepare(client);
      if (!(await client.query(`SELECT collection.id FROM stash_collections collection JOIN stash_workspaces workspace
        ON workspace.id=collection.workspace_id WHERE collection.id=$1 AND (${member}) FOR UPDATE OF collection`, [collectionId, memberId])).rowCount)
        return { status: "collection_not_found" as const };
      if (!(await client.query("SELECT 1 FROM stash_collection_records WHERE id=$1 AND collection_id=$2 FOR UPDATE", [recordId, collectionId])).rowCount)
        return { status: "record_not_found" as const };
      const current = await this.canonicalCollection(client, collectionId); const found = current.records.find(({ id }) => id === recordId)!;
      let normalized: CanonicalCollection;
      try { normalized = normalizeCollection({ ...current, records: current.records.map((record) => record.id === recordId
        ? { ...record, values: { ...record.values, ...values } } : record) }); }
      catch { return { status: "invalid_record" as const }; }
      const record = normalized.records.find(({ id }) => id === recordId)!;
      for (const [propertyId, value] of Object.entries(values)) await client.query(`INSERT INTO stash_collection_record_values
        (record_id,property_id,value) VALUES($1,$2,$3::jsonb)
        ON CONFLICT(record_id,property_id) DO UPDATE SET value=EXCLUDED.value`, [recordId, propertyId, JSON.stringify(value)]);
      const collection = await this.canonicalCollection(client, collectionId); await this.projection(client, "Collection", collectionId, collection.schema, collection);
      return { status: "updated" as const, record };
    });
  }

  async createCanonicalViewBlock(memberId: string, view: CanonicalViewBlock): Promise<
    { status: "created"; view: CanonicalViewBlock } | { status: "note_not_found" | "workspace_mismatch" | "source_unavailable" | "view_conflict" }> {
    return this.kernel.transaction(async (client) => {
      await this.prepare(client);
      const owner = await client.query<{ workspace_id: string }>(`SELECT note.workspace_id FROM stash_notes note JOIN stash_workspaces workspace
        ON workspace.id=note.workspace_id WHERE note.id=$1 AND note.archived_at IS NULL AND note.trashed_at IS NULL AND (${member})`,
      [view.ownerNoteId, memberId]);
      if (!owner.rows[0]) return { status: "note_not_found" as const };
      if (owner.rows[0].workspace_id !== view.workspaceId) return { status: "workspace_mismatch" as const };
      if (view.definition.source.kind === "collection") {
        const source = await client.query(`SELECT 1 FROM stash_collections collection JOIN stash_notes note ON note.id=collection.owner_note_id
          JOIN stash_workspaces workspace ON workspace.id=collection.workspace_id WHERE collection.id=$1 AND collection.workspace_id=$2
          AND ${effectiveNoteReadSql("note", "workspace", "$3")} FOR UPDATE OF collection`,
        [view.definition.source.collectionId, view.workspaceId, memberId]);
        if (!source.rowCount) return { status: "source_unavailable" as const };
        if (!definitionFitsCollection(view.definition, await this.canonicalCollection(client, view.definition.source.collectionId)))
          return { status: "source_unavailable" as const };
      } else if (view.definition.source.workspaceId !== view.workspaceId) return { status: "workspace_mismatch" as const };
      try {
        await client.query(`INSERT INTO stash_view_blocks(id,workspace_id,owner_note_id,block_id,title,source_kind,source_workspace_id,
          source_collection_id,source_project_scope,query,layout,definition) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,NULL,$10,$11::jsonb)`,
        [view.id, view.workspaceId, view.ownerNoteId, view.blockId, view.title, view.definition.source.kind,
          view.definition.source.kind === "tasks" ? view.definition.source.workspaceId : null,
          view.definition.source.kind === "collection" ? view.definition.source.collectionId : null,
          view.definition.source.kind === "tasks" ? "none" : null, view.definition.presentation, JSON.stringify(view.definition)]);
      } catch (error) {
        if (error && typeof error === "object" && "code" in error && error.code === "23505") return { status: "view_conflict" as const };
        throw error;
      }
      await this.projection(client, "ViewBlock", view.id, view.schema, view);
      return { status: "created" as const, view };
    });
  }

  async readCanonicalViewBlock(memberId: string, viewId: string): Promise<CollectionViewResult> {
    return this.kernel.withSession(async (client) => {
      await this.prepare(client);
      const accessible = await client.query<{ id: string }>(`SELECT view.id FROM stash_view_blocks view JOIN stash_notes note ON note.id=view.owner_note_id
        JOIN stash_workspaces workspace ON workspace.id=view.workspace_id WHERE view.id=$1 AND note.archived_at IS NULL
        AND note.trashed_at IS NULL AND ${effectiveNoteReadSql("note", "workspace", "$2")}`, [viewId, memberId]);
      if (!accessible.rows[0]) return { status: "view_not_found" as const };
      const view = await this.canonicalView(client, viewId);
      if (view.definition.source.kind === "collection") {
        const authorized = await client.query(`SELECT collection.id FROM stash_collections collection JOIN stash_notes note
          ON note.id=collection.owner_note_id JOIN stash_workspaces workspace ON workspace.id=collection.workspace_id
          WHERE collection.id=$1 AND ${effectiveNoteReadSql("note", "workspace", "$2")}`,
        [view.definition.source.collectionId, memberId]);
        if (!authorized.rowCount) return { status: "source_unavailable" as const };
        return { status: "found" as const, view, source: { kind: "collection" as const,
          collection: await this.permissionFilteredCollection(client, memberId,
            await this.canonicalCollection(client, view.definition.source.collectionId)) } };
      }
      if (!this.taskViewSource) return { status: "source_unavailable" as const };
      const tasks = await this.taskViewSource(memberId, view.definition.source.workspaceId);
      if (tasks.status !== "found") return { status: "source_unavailable" as const };
      return { status: "found" as const, view, source: { kind: "tasks" as const, records: tasks.tasks,
        statuses: tasks.workflow?.statuses ?? [] } };
    });
  }

  async updateCanonicalViewBlock(memberId: string, viewId: string, definition: ViewDefinition): Promise<
    { status: "updated" } | { status: "view_not_found" | "source_unavailable" }> {
    return this.kernel.transaction(async (client) => {
      await this.prepare(client);
      const found = await client.query<{ workspace_id: string }>(`SELECT view.workspace_id FROM stash_view_blocks view
        JOIN stash_workspaces workspace ON workspace.id=view.workspace_id WHERE view.id=$1 AND (${member})`, [viewId, memberId]);
      if (!found.rows[0]) return { status: "view_not_found" as const };
      const workspaceId = found.rows[0].workspace_id;
      if (definition.source.kind === "collection") {
        if (!(await client.query(`SELECT 1 FROM stash_collections collection JOIN stash_notes note ON note.id=collection.owner_note_id
          JOIN stash_workspaces workspace ON workspace.id=collection.workspace_id WHERE collection.id=$1 AND collection.workspace_id=$2
          AND ${effectiveNoteReadSql("note", "workspace", "$3")} FOR UPDATE OF collection`, [definition.source.collectionId, workspaceId, memberId])).rowCount)
          return { status: "source_unavailable" as const };
        if (!definitionFitsCollection(definition, await this.canonicalCollection(client, definition.source.collectionId)))
          return { status: "source_unavailable" as const };
      } else if (definition.source.workspaceId !== workspaceId) return { status: "source_unavailable" as const };
      if (!(await client.query(`SELECT view.id FROM stash_view_blocks view JOIN stash_workspaces workspace ON workspace.id=view.workspace_id
        WHERE view.id=$1 AND (${member}) FOR UPDATE OF view`, [viewId, memberId])).rowCount) return { status: "view_not_found" as const };
      await client.query(`UPDATE stash_view_blocks SET source_kind=$2,source_workspace_id=$3,source_collection_id=$4,
        source_project_scope=$5,layout=$6,definition=$7::jsonb WHERE id=$1`, [viewId, definition.source.kind,
        definition.source.kind === "tasks" ? definition.source.workspaceId : null,
        definition.source.kind === "collection" ? definition.source.collectionId : null,
        definition.source.kind === "tasks" ? "none" : null, definition.presentation, JSON.stringify(definition)]);
      const view = await this.canonicalView(client, viewId);
      await this.projection(client, "ViewBlock", view.id, view.schema, view);
      return { status: "updated" as const };
    });
  }

  async listCollectionsForNote(memberId: string, noteId: string): Promise<
    { status: "found"; workspaceId: string; collections: readonly CanonicalCollection[]; availableCollections: readonly CanonicalCollection[];
      availableCollectionNotes: Readonly<Record<string, string>>; availableNotes: readonly { readonly id: string; readonly title: string }[];
      views: readonly CanonicalViewBlock[] } | { status: "note_not_found" }> {
    return this.kernel.withSession(async (client) => {
      await this.prepare(client);
      const note = await client.query<{ workspace_id: string }>(`SELECT note.workspace_id FROM stash_notes note JOIN stash_workspaces workspace ON workspace.id=note.workspace_id
        WHERE note.id=$1 AND note.archived_at IS NULL AND note.trashed_at IS NULL AND ${effectiveNoteReadSql("note", "workspace", "$2")}`,
      [noteId, memberId]);
      if (!note.rows[0]) return { status: "note_not_found" as const };
      const collections = await client.query<{ id: string }>("SELECT id FROM stash_collections WHERE owner_note_id=$1 ORDER BY title,id", [noteId]);
      const available = await client.query<{ id: string; owner_note_title: string }>(`SELECT collection.id,owner_note.title owner_note_title FROM stash_collections collection
        JOIN stash_notes owner_note ON owner_note.id=collection.owner_note_id
        JOIN stash_workspaces workspace ON workspace.id=collection.workspace_id
        WHERE collection.workspace_id=$1 AND ${effectiveNoteReadSql("owner_note", "workspace", "$2")}
        ORDER BY collection.title,collection.id`, [note.rows[0].workspace_id, memberId]);
      const availableNotes = await client.query<{ id: string; title: string }>(`SELECT candidate.id,candidate.title FROM stash_notes candidate
        JOIN stash_workspaces workspace ON workspace.id=candidate.workspace_id WHERE candidate.workspace_id=$1
        AND candidate.archived_at IS NULL AND candidate.trashed_at IS NULL AND ${effectiveNoteReadSql("candidate", "workspace", "$2")}
        ORDER BY candidate.title,candidate.id`, [note.rows[0].workspace_id, memberId]);
      const views = await client.query<{ id: string }>("SELECT id FROM stash_view_blocks WHERE owner_note_id=$1 ORDER BY title,id", [noteId]);
      return { status: "found" as const, workspaceId: note.rows[0].workspace_id,
        collections: await Promise.all(collections.rows.map(async ({ id }) => this.permissionFilteredCollection(client, memberId,
          await this.canonicalCollection(client, id)))),
        availableCollections: await Promise.all(available.rows.map(async ({ id }) => this.permissionFilteredCollection(client, memberId,
          await this.canonicalCollection(client, id)))),
        availableCollectionNotes: Object.fromEntries(available.rows.map(({ id, owner_note_title }) => [id, owner_note_title])),
        availableNotes: availableNotes.rows,
        views: await Promise.all(views.rows.map(({ id }) => this.canonicalView(client, id))) };
    });
  }

  async previewCollectionRemoval(memberId: string, noteId: string): Promise<
    { status: "found"; impact: CollectionImpact } | { status: "note_not_found" }> {
    return this.kernel.withSession(async (client) => {
      await this.prepare(client);
      if (!(await this.editableNote(client, memberId, noteId)).rowCount) return { status: "note_not_found" as const };
      return { status: "found" as const, impact: await this.collectionImpact(client, noteId) };
    });
  }

  async relocateCollections(memberId: string, noteId: string, destinationNoteId: string, collectionIds: readonly string[]): Promise<
    { status: "relocated"; collectionIds: readonly string[] } | { status: "note_not_found" | "destination_not_found" | "collection_not_found" }> {
    return this.kernel.transaction(async (client) => {
      await this.prepare(client); const source = await this.editableNote(client, memberId, noteId, true);
      if (!source.rows[0]) return { status: "note_not_found" as const };
      const destination = await this.editableNote(client, memberId, destinationNoteId, true);
      if (!destination.rows[0] || destination.rows[0].workspace_id !== source.rows[0].workspace_id)
        return { status: "destination_not_found" as const };
      const owned = await client.query<{ id: string }>("SELECT id FROM stash_collections WHERE owner_note_id=$1 AND id=ANY($2::uuid[]) FOR UPDATE",
        [noteId, collectionIds]);
      if (owned.rows.length !== collectionIds.length) return { status: "collection_not_found" as const };
      await client.query("UPDATE stash_collections SET owner_note_id=$2 WHERE id=ANY($1::uuid[])", [collectionIds, destinationNoteId]);
      for (const id of collectionIds) { const collection = await this.canonicalCollection(client, id);
        await this.projection(client, "Collection", id, collection.schema, collection); }
      return { status: "relocated" as const, collectionIds: [...collectionIds] };
    });
  }

  async deleteCollections(memberId: string, noteId: string, collectionIds: readonly string[], impactToken: string): Promise<
    { status: "deleted"; collectionIds: readonly string[] } | { status: "note_not_found" | "collection_not_found" | "impact_changed" }> {
    return this.kernel.transaction(async (client) => {
      await this.prepare(client);
      if (!(await this.editableNote(client, memberId, noteId, true)).rowCount) return { status: "note_not_found" as const };
      const uniqueCollectionIds = [...new Set(collectionIds)];
      const owned = await client.query<{ id: string }>(`SELECT id FROM stash_collections
        WHERE owner_note_id=$1 AND id=ANY($2::uuid[]) FOR UPDATE`, [noteId, uniqueCollectionIds]);
      if (owned.rows.length !== uniqueCollectionIds.length || uniqueCollectionIds.length !== collectionIds.length)
        return { status: "collection_not_found" as const };
      const impact = await this.collectionImpact(client, noteId);
      if (impact.token !== impactToken || collectionIds.some((id) => !impact.collections.some((entry) => entry.id === id)))
        return { status: "impact_changed" as const };

      const recordIds = (await client.query<{ id: string }>(`SELECT id FROM stash_collection_records
        WHERE collection_id=ANY($1::uuid[]) FOR UPDATE`, [uniqueCollectionIds])).rows.map(({ id }) => id);
      const removedRecords = new Set(recordIds);
      const relationValues = await client.query<{ record_id: string; property_id: string; collection_id: string; value: unknown }>(`SELECT
        value.record_id,value.property_id,property.collection_id,value.value
        FROM stash_collection_record_values value JOIN stash_collection_properties property ON property.id=value.property_id
        WHERE property.property_type='relation' AND jsonb_typeof(value.value)='array' FOR UPDATE OF value`, []);
      const affectedCollections = new Set<string>();
      for (const row of relationValues.rows) {
        if (uniqueCollectionIds.includes(row.collection_id) || !Array.isArray(row.value)) continue;
        const repaired = row.value.filter((reference) => {
          const id = typeof reference === "string" ? reference
            : reference && typeof reference === "object" && "id" in reference ? (reference as { id?: unknown }).id : undefined;
          return typeof id !== "string" || !removedRecords.has(id);
        });
        if (repaired.length === row.value.length) continue;
        await client.query(`UPDATE stash_collection_record_values SET value=$3::jsonb
          WHERE record_id=$1 AND property_id=$2`, [row.record_id, row.property_id, JSON.stringify(repaired)]);
        affectedCollections.add(row.collection_id);
      }

      const viewIds = (await client.query<{ id: string }>(`SELECT id FROM stash_view_blocks
        WHERE source_collection_id=ANY($1::uuid[]) FOR UPDATE`, [uniqueCollectionIds])).rows.map(({ id }) => id);
      const optionalTables = await client.query<{ tutorials: string | null }>("SELECT to_regclass('stash_starter_tutorials')::text tutorials");
      if (optionalTables.rows[0]?.tutorials) await client.query(
        "DELETE FROM stash_starter_tutorials WHERE collection_id=ANY($1::uuid[])", [uniqueCollectionIds]);
      await client.query("DELETE FROM stash_view_blocks WHERE id=ANY($1::uuid[])", [viewIds]);
      await client.query("DELETE FROM stash_collections WHERE id=ANY($1::uuid[])", [uniqueCollectionIds]);
      await client.query(`DELETE FROM stash_portable_projection_outbox WHERE
        (object_kind='Collection' AND object_id=ANY($1::uuid[])) OR
        (object_kind='ViewBlock' AND object_id=ANY($2::uuid[]))`, [uniqueCollectionIds, viewIds]);
      for (const id of affectedCollections) {
        const collection = await this.canonicalCollection(client, id);
        await this.projection(client, "Collection", id, collection.schema, collection);
      }
      return { status: "deleted" as const, collectionIds: [...collectionIds] };
    });
  }

  private async propertyRemovalImpact(client: PostgresQueryable, collectionId: string, propertyId: string, propertyType: string, lock: boolean): Promise<{
    impact: CollectionPropertyImpact; affectedViewIds: string[];
  }> {
    const values = await client.query<{ record_id: string; value: unknown }>(`SELECT record_id,value FROM stash_collection_record_values
      WHERE property_id=$1 ORDER BY record_id${lock ? " FOR UPDATE" : ""}`, [propertyId]);
    const viewRows = await client.query<{ id: string }>(`SELECT id FROM stash_view_blocks WHERE source_collection_id=$1
      ORDER BY id${lock ? " FOR UPDATE" : ""}`, [collectionId]);
    const affectedViews: Array<{ id: string; definition: ViewDefinition }> = [];
    for (const { id } of viewRows.rows) {
      const view = await this.canonicalView(client, id); const repaired = withoutProperty(view.definition, propertyId);
      if (JSON.stringify(repaired) !== JSON.stringify(view.definition)) affectedViews.push({ id, definition: view.definition });
    }
    const affectedRelations = propertyType === "relation" ? values.rows.reduce((count, row) =>
      count + (Array.isArray(row.value) ? row.value.length : 0), 0) : 0;
    const token = encodeURIComponent(JSON.stringify({ collectionId, propertyId, propertyType,
      values: values.rows.map(({ record_id, value }) => [record_id, value]),
      views: affectedViews.map(({ id, definition }) => [id, definition]) }));
    return { impact: { collectionId, propertyId, affectedValues: values.rows.length, affectedRelations,
      affectedViews: affectedViews.length, token }, affectedViewIds: affectedViews.map(({ id }) => id) };
  }

  private async canonicalCollection(client: PostgresQueryable, id: string): Promise<CanonicalCollection> {
    const base = (await client.query<any>("SELECT * FROM stash_collections WHERE id=$1", [id])).rows[0];
    const properties = (await client.query<any>(`SELECT id,name,property_type,configuration,position FROM stash_collection_properties
      WHERE collection_id=$1 ORDER BY position,id`, [id])).rows.map((row: any) => ({ id: row.id, name: row.name, type: row.property_type,
      position: row.position, ...(row.property_type === "single_select" || row.property_type === "multi_select"
        ? { options: row.configuration.options ?? [] } : row.property_type === "relation" ? { target: row.configuration.target } : {}) }));
    const records = (await client.query<any>(`SELECT record.id,record.position,
      COALESCE(jsonb_object_agg(value.property_id,value.value) FILTER(WHERE value.property_id IS NOT NULL),'{}'::jsonb) values
      FROM stash_collection_records record LEFT JOIN stash_collection_record_values value ON value.record_id=record.id
      WHERE record.collection_id=$1 GROUP BY record.id ORDER BY record.position,record.id`, [id])).rows;
    return { schema: "stash.collection.v1", id: base.id, workspaceId: base.workspace_id, ownerNoteId: base.owner_note_id,
      title: base.title, properties, records: records.map((row: any) => ({ id: row.id, position: row.position, values: row.values })) };
  }
  private async canonicalView(client: PostgresQueryable, id: string): Promise<CanonicalViewBlock> {
    const row = (await client.query<any>("SELECT * FROM stash_view_blocks WHERE id=$1", [id])).rows[0];
    const definition: ViewDefinition = row.definition ?? { source: { kind: "tasks", workspaceId: row.source_workspace_id },
      presentation: row.layout, filters: row.query?.titleContains ? [{ propertyId: "task:title", operator: "contains", value: row.query.titleContains }] : [],
      sorts: [], layout: {} };
    return { schema: "stash.view-block.v1", id: row.id, workspaceId: row.workspace_id, ownerNoteId: row.owner_note_id,
      blockId: row.block_id, title: row.title, definition };
  }
  private async permissionFilteredCollection(client: PostgresQueryable, memberId: string,
    collection: CanonicalCollection): Promise<CanonicalCollection> {
    const memberAccess = await client.query<{ allowed: boolean }>(`SELECT ((workspace.owner_type='personal' AND workspace.personal_owner_id=$2)
      OR (workspace.owner_type='organization' AND EXISTS(SELECT 1 FROM stash_organization_memberships membership
        WHERE membership.organization_id=workspace.organization_owner_id AND membership.account_id=$2))) allowed
      FROM stash_workspaces workspace WHERE workspace.id=$1`, [collection.workspaceId, memberId]);
    if (memberAccess.rows[0]?.allowed) return collection;
    const allowed = new Map<string, Set<string>>();
    for (const property of collection.properties) {
      if (property.type === "person") { allowed.set(property.id, new Set([memberId])); continue; }
      if (property.type !== "relation") continue;
      const ids = [...new Set(collection.records.flatMap((record) => {
        const value = record.values[property.id]; return Array.isArray(value) ? (value as readonly { id?: string }[]).map(({ id }) => id).filter(Boolean) as string[] : [];
      }))];
      if (!ids.length) { allowed.set(property.id, new Set()); continue; }
      let rows: Array<{ id: string }> = [];
      if (property.target.kind === "notes") rows = (await client.query<{ id: string }>(`SELECT note.id FROM stash_notes note
        JOIN stash_workspaces workspace ON workspace.id=note.workspace_id WHERE note.id=ANY($1::uuid[])
        AND note.archived_at IS NULL AND note.trashed_at IS NULL AND ${effectiveNoteReadSql("note", "workspace", "$2")}`, [ids, memberId])).rows;
      else if (property.target.kind === "projects") rows = (await client.query<{ id: string }>(`SELECT project.id FROM stash_projects project
        JOIN stash_project_guests guest ON guest.project_id=project.id WHERE project.id=ANY($1::uuid[]) AND guest.account_id=$2`, [ids, memberId])).rows;
      else if (property.target.kind === "collection_records") rows = (await client.query<{ id: string }>(`SELECT record.id FROM stash_collection_records record
        JOIN stash_collections related ON related.id=record.collection_id JOIN stash_notes note ON note.id=related.owner_note_id
        JOIN stash_workspaces workspace ON workspace.id=related.workspace_id WHERE record.id=ANY($1::uuid[])
        AND ${effectiveNoteReadSql("note", "workspace", "$2")}`, [ids, memberId])).rows;
      else {
        const tables = await client.query<{ tasks: string | null }>("SELECT to_regclass('stash_tasks')::text tasks");
        rows = tables.rows[0]?.tasks ? (await client.query<{ id: string }>(`SELECT task.id FROM stash_tasks task
          JOIN stash_project_guests guest ON guest.project_id=task.project_id WHERE task.id=ANY($1::uuid[]) AND guest.account_id=$2`, [ids, memberId])).rows : [];
      }
      allowed.set(property.id, new Set(rows.map(({ id }) => id)));
    }
    return { ...collection, records: collection.records.map((record) => ({ ...record,
      values: Object.fromEntries(Object.entries(record.values).map(([propertyId, value]) => {
        const visible = allowed.get(propertyId); if (!visible || !Array.isArray(value)) return [propertyId, value];
        return [propertyId, value.filter((entry) => typeof entry === "string" ? visible.has(entry) : visible.has(entry.id))];
      })) })) };
  }
  private editableNote(client: PostgresQueryable, memberId: string, noteId: string, lock = false) {
    return client.query<{ id: string; workspace_id: string }>(`SELECT note.id,note.workspace_id FROM stash_notes note
      JOIN stash_workspaces workspace ON workspace.id=note.workspace_id WHERE note.id=$1 AND note.archived_at IS NULL
      AND note.trashed_at IS NULL AND (${member})${lock ? " FOR UPDATE OF note" : ""}`, [noteId, memberId]);
  }
  private async collectionImpact(client: PostgresQueryable, noteId: string): Promise<CollectionImpact> {
    const collections = await client.query<{ id: string; title: string; record_count: number }>(`SELECT collection.id,collection.title,
      count(record.id)::int record_count FROM stash_collections collection LEFT JOIN stash_collection_records record
      ON record.collection_id=collection.id WHERE collection.owner_note_id=$1 GROUP BY collection.id ORDER BY collection.title,collection.id`, [noteId]);
    const ids = collections.rows.map(({ id }) => id);
    if (!ids.length) return { noteId, collections: [], relations: [], viewBlocks: [], token: "empty" };
    const relations = await client.query<{ collection_id: string; record_id: string; property_id: string; target_collection_id: string; reference_count: number }>(`SELECT
      property.collection_id,value.record_id,value.property_id,property.configuration->'target'->>'collectionId' target_collection_id,
      CASE WHEN jsonb_typeof(value.value)='array' THEN jsonb_array_length(value.value) ELSE 0 END::int reference_count
      FROM stash_collection_record_values value JOIN stash_collection_properties property ON property.id=value.property_id
      WHERE property.property_type='relation' AND property.configuration->'target'->>'kind'='collection_records'
      AND property.configuration->'target'->>'collectionId'=ANY($1::text[])
      AND CASE WHEN jsonb_typeof(value.value)='array' THEN jsonb_array_length(value.value) ELSE 0 END>0
      ORDER BY property.collection_id,value.record_id,value.property_id`, [ids]);
    const views = await client.query<{ id: string; title: string; owner_note_id: string; source_collection_id: string }>(`SELECT id,title,owner_note_id,source_collection_id FROM stash_view_blocks
      WHERE source_collection_id=ANY($1::uuid[]) ORDER BY title,id`, [ids]);
    const collectionImpact = collections.rows.map((row) => ({ id: row.id, title: row.title, recordCount: Number(row.record_count) }));
    const relationImpact = relations.rows.map((row) => ({ collectionId: row.collection_id, recordId: row.record_id,
      propertyId: row.property_id, targetCollectionId: row.target_collection_id, referenceCount: Number(row.reference_count) }));
    const viewBlocks = views.rows.map((row) => ({ id: row.id, title: row.title, ownerNoteId: row.owner_note_id,
      collectionId: row.source_collection_id }));
    const token = encodeURIComponent(JSON.stringify({ collections: collectionImpact.map(({ id, recordCount }) => [id, recordCount]),
      relations: relationImpact.map(({ collectionId, recordId, propertyId, targetCollectionId, referenceCount }) =>
        [collectionId, recordId, propertyId, targetCollectionId, referenceCount]),
      views: viewBlocks.map(({ id }) => id) }));
    return { noteId, collections: collectionImpact, relations: relationImpact, viewBlocks, token };
  }
  private async projection(client:PostgresQueryable,kind:string,id:string,schema:string,payload:object){await client.query(`INSERT INTO stash_portable_projection_outbox(object_kind,object_id,revision,projection_schema,payload)
    SELECT $1,$2,COALESCE(MAX(revision),0)+1,$3,$4::jsonb FROM stash_portable_projection_outbox WHERE object_kind=$1 AND object_id=$2`,[kind,id,schema,JSON.stringify(payload)]);}
}

function withoutProperty(definition: ViewDefinition, propertyId: string): ViewDefinition {
  const visible = Array.isArray(definition.layout.visiblePropertyIds)
    ? definition.layout.visiblePropertyIds.filter((id) => id !== propertyId) : undefined;
  const { groupBy: _groupBy, ...withoutGroup } = definition; const base = definition.groupBy === propertyId ? withoutGroup : definition;
  return { ...base, filters: definition.filters.filter((filter) => filter.propertyId !== propertyId),
    sorts: definition.sorts.filter((sort) => sort.propertyId !== propertyId),
    layout: visible ? { ...definition.layout, visiblePropertyIds: visible } : definition.layout };
}

function definitionFitsCollection(definition: ViewDefinition, collection: CanonicalCollection) {
  const available = new Set(collection.properties.map(({ id }) => id));
  const referenced = [...definition.filters.map(({ propertyId }) => propertyId), ...definition.sorts.map(({ propertyId }) => propertyId),
    ...(definition.groupBy ? [definition.groupBy] : []), ...(Array.isArray(definition.layout.visiblePropertyIds)
      ? definition.layout.visiblePropertyIds.filter((id): id is string => typeof id === "string") : [])];
  return referenced.every((propertyId) => available.has(propertyId));
}
