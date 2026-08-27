import type { PostgresKernel, PostgresQueryable } from "../instance-operations/storage/postgres-kernel.js";
import type { NoteTreeBranchLifecycle } from "./postgres-note-tree-repository.js";
import type { NoteTreeImpactInspector } from "./note-tree.js";
import type { ViewBlock as CanonicalViewBlock, ViewDefinition } from "@stash/domain-types";
import type { Collection, StarterKnowledgeSetup, TutorialContribution, TutorialContributionRepository, ViewBlock } from "./collections.js";
import { PostgresCollectionRepository } from "./postgres-collection-repository.js";

type PrepareNotes = (client: PostgresQueryable) => Promise<void>;
const member = `(workspace.owner_type='personal' AND workspace.personal_owner_id=$2) OR
  (workspace.owner_type='organization' AND EXISTS (SELECT 1 FROM stash_organization_memberships membership
    WHERE membership.organization_id=workspace.organization_owner_id AND membership.account_id=$2))`;

/** Tutorial-only contribution persistence and Note lifecycle integration. */
export class PostgresTutorialContributionRepository implements TutorialContributionRepository, NoteTreeImpactInspector, NoteTreeBranchLifecycle {
  private readonly collections: PostgresCollectionRepository;
  constructor(private readonly kernel: PostgresKernel, prepareNotes: PrepareNotes) {
    this.collections = new PostgresCollectionRepository(kernel, prepareNotes);
  }

  async prepare(client: PostgresQueryable): Promise<void> {
    await this.collections.prepare(client);
    const planning = await client.query<{ statuses: string | null }>("SELECT to_regclass('stash_workspace_workflow_statuses')::text statuses");
    if (planning.rows[0]?.statuses) await client.query(`CREATE TABLE IF NOT EXISTS stash_starter_tutorials (
      root_note_id UUID PRIMARY KEY REFERENCES stash_notes(id) ON DELETE CASCADE,
      workspace_id UUID NOT NULL REFERENCES stash_workspaces(id) ON DELETE CASCADE,
      collection_id UUID NOT NULL REFERENCES stash_collections(id) ON DELETE RESTRICT,
      view_block_id UUID NOT NULL REFERENCES stash_view_blocks(id) ON DELETE RESTRICT,
      workspace_workflow_status_id UUID NOT NULL REFERENCES stash_workspace_workflow_statuses(id),
      sample_task_ids UUID[] NOT NULL
    )`);
  }
  async seed(client: PostgresQueryable, input: StarterKnowledgeSetup,
    lifecycle: { workflowStatusId: string; sampleTaskIds: string[] }): Promise<void> {
    await this.prepare(client);
    const collection = input.collection;
    await client.query("INSERT INTO stash_collections(id,workspace_id,owner_note_id,title) VALUES($1,$2,$3,$4)",
      [collection.id, collection.workspaceId, collection.ownerNoteId, collection.title]);
    for (const property of collection.properties) {
      const configuration = property.type === "single_select" || property.type === "multi_select" ? { options: property.options }
        : property.type === "relation" ? { target: property.target } : {};
      await client.query(`INSERT INTO stash_collection_properties
        (id,collection_id,name,property_type,configuration,position) VALUES($1,$2,$3,$4,$5::jsonb,$6)`,
      [property.id, collection.id, property.name, property.type, JSON.stringify(configuration), property.position]);
    }
    for (const record of collection.records) {
      await client.query("INSERT INTO stash_collection_records(id,collection_id,position) VALUES($1,$2,$3)",
        [record.id, collection.id, record.position]);
      for (const [propertyId, value] of Object.entries(record.values)) await client.query(`INSERT INTO stash_collection_record_values
        (record_id,property_id,value) VALUES($1,$2,$3::jsonb)`, [record.id, propertyId, JSON.stringify(value)]);
    }
    const view = input.viewBlock;
    await client.query(`INSERT INTO stash_view_blocks
      (id,workspace_id,owner_note_id,block_id,title,source_kind,source_workspace_id,source_project_scope,query,layout,definition)
      VALUES($1,$2,$3,$4,$5,'tasks',$6,'none',NULL,$7,$8::jsonb)`,
    [view.id, view.workspaceId, view.ownerNoteId, view.blockId, view.title,
      view.definition.source.kind === "tasks" ? view.definition.source.workspaceId : view.workspaceId,
      view.definition.presentation, JSON.stringify(view.definition)]);
    await client.query(`INSERT INTO stash_starter_tutorials
      (root_note_id,workspace_id,collection_id,view_block_id,workspace_workflow_status_id,sample_task_ids)
      VALUES($1,$2,$3,$4,$5,$6::uuid[])`, [input.rootNoteId, collection.workspaceId, collection.id, view.id,
      lifecycle.workflowStatusId, lifecycle.sampleTaskIds]);
    await this.projection(client, "Collection", collection.id, collection.schema, collection);
    await this.projection(client, "ViewBlock", view.id, view.schema, view);
  }

  read(memberId: string, noteId: string) { return this.kernel.withSession(async (client) => {
    await this.prepare(client); return this.readWith(client, memberId, noteId);
  }); }

  updateCollection(memberId: string, noteId: string, input: { title?: string; recordValue?: string }) {
    return this.kernel.transaction(async (client) => {
      await this.prepare(client); const tutorial = await this.readWith(client, memberId, noteId, true); if (!tutorial) return undefined;
      if (input.title) await client.query("UPDATE stash_collections SET title=$2 WHERE id=$1", [tutorial.collection.id, input.title]);
      if (input.recordValue) {
        const record = tutorial.collection.records[0]; const property = tutorial.collection.properties[0];
        if (record && property) await client.query(`UPDATE stash_collection_record_values SET value=$3::jsonb
          WHERE record_id=$1 AND property_id=$2`, [record.id, property.id, JSON.stringify(input.recordValue)]);
      }
      const updated = await this.readWith(client, memberId, noteId, true); if (updated) await this.projection(client, "Collection",
        updated.collection.id, updated.collection.schema, updated.collection); return updated;
    });
  }

  updateViewBlock(memberId: string, noteId: string, input: { layout: "list" | "table"; titleContains: string }) {
    return this.kernel.transaction(async (client) => {
      await this.prepare(client); const tutorial = await this.readWith(client, memberId, noteId, true); if (!tutorial) return undefined;
      const definition: ViewDefinition = { source: tutorial.viewBlock.definition.source, presentation: input.layout,
        filters: input.titleContains ? [{ propertyId: "task:title", operator: "contains", value: input.titleContains }] : [],
        sorts: [], layout: tutorial.viewBlock.definition.layout };
      await client.query("UPDATE stash_view_blocks SET layout=$2,query=NULL,definition=$3::jsonb WHERE id=$1", [tutorial.viewBlock.id,
        input.layout, JSON.stringify(definition)]);
      const updated = await this.readWith(client, memberId, noteId, true); if (updated) await this.projection(client, "ViewBlock",
        updated.viewBlock.id, updated.viewBlock.schema, updated.viewBlock); return updated;
    });
  }

  remove(memberId: string, noteId: string) { return this.kernel.transaction(async (client) => {
    await this.prepare(client); const metadata = await this.metadata(client, memberId, noteId, true); if (!metadata) return "not_found" as const;
    const ids = await this.branchIds(client, metadata.root_note_id);
    const links = await client.query<{id:string}>("SELECT id FROM stash_note_links WHERE source_note_id=ANY($1::uuid[]) OR target_note_id=ANY($1::uuid[])", [ids]);
    await client.query("DELETE FROM stash_note_links WHERE source_note_id=ANY($1::uuid[]) OR target_note_id=ANY($1::uuid[])", [ids]);
    await client.query("DELETE FROM stash_task_block_sources WHERE task_id=ANY($1::uuid[]) OR note_id=ANY($2::uuid[])", [metadata.sample_task_ids, ids]);
    await client.query("DELETE FROM stash_task_note_sources WHERE task_id=ANY($1::uuid[]) OR note_id=ANY($2::uuid[])", [metadata.sample_task_ids, ids]);
    await client.query("DELETE FROM stash_task_dependencies WHERE dependent_task_id=ANY($1::uuid[]) OR prerequisite_task_id=ANY($1::uuid[])", [metadata.sample_task_ids]);
    await client.query("DELETE FROM stash_task_key_aliases WHERE task_id=ANY($1::uuid[])", [metadata.sample_task_ids]);
    await client.query("DELETE FROM stash_tasks WHERE id=ANY($1::uuid[])", [metadata.sample_task_ids]);
    await client.query("DELETE FROM stash_starter_tutorials WHERE root_note_id=$1", [metadata.root_note_id]);
    await client.query("DELETE FROM stash_view_blocks WHERE id=$1", [metadata.view_block_id]);
    await client.query("DELETE FROM stash_collections WHERE id=$1", [metadata.collection_id]);
    await client.query("DELETE FROM stash_workspace_workflow_statuses WHERE id=$1 AND NOT EXISTS(SELECT 1 FROM stash_tasks WHERE workspace_workflow_status_id=$1)", [metadata.workspace_workflow_status_id]);
    await client.query("DELETE FROM stash_portable_projection_outbox WHERE (object_kind IN ('Note','NoteLocation') AND object_id=ANY($1::uuid[])) OR (object_kind='Task' AND object_id=ANY($2::uuid[])) OR (object_kind='NoteLink' AND object_id=ANY($3::uuid[])) OR (object_kind='Collection' AND object_id=$4) OR (object_kind='ViewBlock' AND object_id=$5) OR (object_kind='WorkspaceWorkflow' AND object_id=$6)",
      [ids, metadata.sample_task_ids, links.rows.map(({id})=>id), metadata.collection_id, metadata.view_block_id, metadata.workspace_workflow_status_id]);
    await client.query("DELETE FROM stash_notes WHERE id=ANY($1::uuid[])", [ids]);
    return "removed" as const;
  }); }

  async inspect(memberId: string, noteIds: readonly string[], action: "archive" | "trash" | "move"): Promise<{
    collectionCount: number;
    collectionRelocationRequired?: boolean;
  }> {
    if (!noteIds.length) return { collectionCount: 0 };
    return this.kernel.withSession(async (client) => { await this.prepare(client); const result = await client.query<{ count: number; relocation_required: boolean }>(`SELECT
      COUNT(DISTINCT collection.id)::int count,
      COALESCE(bool_or(tutorial.root_note_id IS NULL OR NOT tutorial.root_note_id=ANY($1::uuid[])),FALSE) relocation_required
      FROM stash_collections collection JOIN stash_workspaces workspace ON workspace.id=collection.workspace_id
      LEFT JOIN stash_starter_tutorials tutorial ON tutorial.collection_id=collection.id
      WHERE collection.owner_note_id=ANY($1::uuid[]) AND (${member})`, [noteIds, memberId]); return {
        collectionCount: result.rows[0]?.count ?? 0,
        collectionRelocationRequired: action === "trash" && result.rows[0]?.relocation_required === true,
      }; });
  }

  async beforeStateChange(client: PostgresQueryable, noteIds: readonly string[], state: "archived" | "trashed"):
    Promise<"allowed" | "collection_owner_requires_relocation"> {
    if (state === "archived" || !noteIds.length) return "allowed";
    const relations = await client.query<{ collections: string | null; tutorials: string | null }>(`SELECT
      to_regclass('stash_collections')::text collections, to_regclass('stash_starter_tutorials')::text tutorials`);
    if (!relations.rows[0]?.collections) return "allowed";
    const blocked = relations.rows[0].tutorials
      ? await client.query(`SELECT 1 FROM stash_collections collection
          LEFT JOIN stash_starter_tutorials tutorial ON tutorial.collection_id=collection.id
          WHERE collection.owner_note_id=ANY($1::uuid[])
            AND (tutorial.root_note_id IS NULL OR NOT tutorial.root_note_id=ANY($1::uuid[])) LIMIT 1`, [noteIds])
      : await client.query("SELECT 1 FROM stash_collections WHERE owner_note_id=ANY($1::uuid[]) LIMIT 1", [noteIds]);
    return blocked.rowCount ? "collection_owner_requires_relocation" : "allowed";
  }

  private async readWith(client: PostgresQueryable, memberId: string, noteId: string, lock=false): Promise<TutorialContribution|undefined> {
    const metadata = await this.metadata(client, memberId, noteId, lock); if (!metadata) return undefined;
    const collection = await this.collection(client, metadata.collection_id); const viewBlock = await this.view(client, metadata.view_block_id);
    const notes = await client.query<any>(`WITH RECURSIVE branch AS (SELECT id,title,content,parent_id,tree_position,ARRAY[tree_position] ordering FROM stash_notes WHERE id=$1
      AND archived_at IS NULL AND trashed_at IS NULL
      UNION ALL SELECT child.id,child.title,child.content,child.parent_id,child.tree_position,branch.ordering||child.tree_position FROM stash_notes child JOIN branch ON child.parent_id=branch.id
      WHERE child.archived_at IS NULL AND child.trashed_at IS NULL)
      SELECT id,title,content,parent_id FROM branch ORDER BY ordering,id`, [metadata.root_note_id]);
    const ids = notes.rows.map(({id}:any)=>id);
    if (!ids.includes(collection.ownerNoteId) || !ids.includes(viewBlock.ownerNoteId)) return undefined;
    const links = await client.query<any>(`SELECT id,source_note_id,target_note_id,label FROM stash_note_links
      WHERE source_note_id=ANY($1::uuid[]) AND target_note_id=ANY($1::uuid[]) ORDER BY id`, [ids]);
    return { workspaceId: metadata.workspace_id, rootNoteId: metadata.root_note_id,
      notes: notes.rows.map(({id,title,content,parent_id}:any)=>({id,title,content,...(parent_id?{parentId:parent_id}:{})})),
      links: links.rows.map(({id,source_note_id,target_note_id,label}:any)=>({id,sourceNoteId:source_note_id,targetNoteId:target_note_id,label})),
      collection, viewBlock };
  }

  private async metadata(client:PostgresQueryable, memberId:string, noteId:string, lock=false) {
    const result=await client.query<any>(`WITH RECURSIVE ancestors AS (SELECT id,parent_id,archived_at,trashed_at FROM stash_notes WHERE id=$1
      UNION ALL SELECT parent.id,parent.parent_id,parent.archived_at,parent.trashed_at FROM stash_notes parent JOIN ancestors child ON child.parent_id=parent.id)
      SELECT tutorial.* FROM ancestors selected JOIN stash_starter_tutorials tutorial ON tutorial.root_note_id=selected.id
      JOIN stash_workspaces workspace ON workspace.id=tutorial.workspace_id
      WHERE NOT EXISTS(SELECT 1 FROM ancestors WHERE archived_at IS NOT NULL OR trashed_at IS NOT NULL) AND (${member})${lock?" FOR UPDATE OF tutorial":""}`,
    [noteId,memberId]); return result.rows[0];
  }
  private async collection(client:PostgresQueryable,id:string):Promise<Collection>{
    const base=(await client.query<any>("SELECT * FROM stash_collections WHERE id=$1",[id])).rows[0];
    const properties=(await client.query<any>("SELECT id,name,property_type,position FROM stash_collection_properties WHERE collection_id=$1 ORDER BY position,id",[id])).rows;
    const records=(await client.query<any>(`SELECT record.id,record.position,COALESCE(jsonb_object_agg(value.property_id,value.value) FILTER(WHERE value.property_id IS NOT NULL),'{}'::jsonb) values
      FROM stash_collection_records record LEFT JOIN stash_collection_record_values value ON value.record_id=record.id WHERE record.collection_id=$1 GROUP BY record.id ORDER BY record.position,record.id`,[id])).rows;
    return {schema:"stash.collection.v1",id:base.id,workspaceId:base.workspace_id,ownerNoteId:base.owner_note_id,title:base.title,
      properties:properties.map((p:any)=>({id:p.id,name:p.name,type:p.property_type,position:p.position})),records:records.map((r:any)=>({id:r.id,position:r.position,values:r.values}))};
  }
  private async canonicalView(client: PostgresQueryable, id: string): Promise<CanonicalViewBlock> {
    const row = (await client.query<any>("SELECT * FROM stash_view_blocks WHERE id=$1", [id])).rows[0];
    const definition: ViewDefinition = row.definition ?? { source: { kind: "tasks", workspaceId: row.source_workspace_id },
      presentation: row.layout, filters: row.query?.titleContains ? [{ propertyId: "task:title", operator: "contains", value: row.query.titleContains }] : [],
      sorts: [], layout: {} };
    return { schema: "stash.view-block.v1", id: row.id, workspaceId: row.workspace_id, ownerNoteId: row.owner_note_id,
      blockId: row.block_id, title: row.title, definition };
  }
  private async view(client:PostgresQueryable,id:string):Promise<ViewBlock>{ return this.canonicalView(client,id); }
  private async branchIds(client:PostgresQueryable,root:string){return (await client.query<{id:string}>(`WITH RECURSIVE branch AS (SELECT id FROM stash_notes WHERE id=$1 UNION ALL SELECT child.id FROM stash_notes child JOIN branch ON child.parent_id=branch.id) SELECT id FROM branch`,[root])).rows.map(({id})=>id);}
  private async projection(client:PostgresQueryable,kind:string,id:string,schema:string,payload:object){await client.query(`INSERT INTO stash_portable_projection_outbox(object_kind,object_id,revision,projection_schema,payload)
    SELECT $1,$2,COALESCE(MAX(revision),0)+1,$3,$4::jsonb FROM stash_portable_projection_outbox WHERE object_kind=$1 AND object_id=$2`,[kind,id,schema,JSON.stringify(payload)]);}
}
