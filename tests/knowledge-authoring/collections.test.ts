import { temporaryTestDirectory } from "../support/temporary-directory.js";

import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";

import { normalizeCollection, normalizeCollectionProperty, normalizeViewBlock, normalizeViewDefinition } from "../../packages/domain-types/src/collections.js";
import { createAuthenticationSecretCodec } from "../../src/authentication-secrets.js";
import { EmbeddedInstanceStore } from "../../src/embedded-instance-store.js";
import { CollectionService, InvalidCollectionInput, type CollectionRepository } from "../../src/knowledge-authoring/collections.js";
import { EmptyCollectionImpactInspector, NoteTreeService } from "../../src/knowledge-authoring/note-tree.js";
import { NoteService } from "../../src/notes.js";
import { WorkspaceProjectService } from "../../src/workspaces-projects.js";

const base = { id: "11111111-1111-4111-8111-111111111111", name: "Field", position: 1 };

describe("Collection contracts", () => {
  test("accepts only the agreed portable property vocabulary", () => {
    const properties = [
      { ...base, type: "text" },
      { ...base, type: "number" },
      { ...base, type: "checkbox" },
      { ...base, type: "date_time" },
      { ...base, type: "single_select", options: [{ id: "todo", name: "To do" }] },
      { ...base, type: "multi_select", options: [{ id: "research", name: "Research" }] },
      { ...base, type: "person" },
      { ...base, type: "url" },
      { ...base, type: "attachment" },
      { ...base, type: "relation", target: { kind: "collection_records", collectionId: "22222222-2222-4222-8222-222222222222" } },
      { ...base, type: "relation", target: { kind: "notes" } },
      { ...base, type: "relation", target: { kind: "tasks" } },
      { ...base, type: "relation", target: { kind: "projects" } },
    ];

    assert.deepEqual(properties.map((property) => normalizeCollectionProperty(property).type),
      ["text", "number", "checkbox", "date_time", "single_select", "multi_select", "person", "url", "attachment",
        "relation", "relation", "relation", "relation"]);
    for (const type of ["formula", "rollup", "generated", "location", "plugin", "unknown"])
      assert.throws(() => normalizeCollectionProperty({ ...base, type }), /invalid_collection_property/);
  });

  test("keeps stable relation identities with readable portable fallbacks", () => {
    const relatedProperty = { ...base, type: "relation" as const, target: { kind: "notes" as const } };
    const collection = normalizeCollection({ schema: "stash.collection.v1", id: "33333333-3333-4333-8333-333333333333",
      workspaceId: "44444444-4444-4444-8444-444444444444", ownerNoteId: "55555555-5555-4555-8555-555555555555",
      title: "Research", properties: [relatedProperty], records: [{ id: "66666666-6666-4666-8666-666666666666", position: 1,
        values: { [base.id]: [{ id: "77777777-7777-4777-8777-777777777777", fallback: "Prior name" }] } }] });

    assert.deepEqual(collection.records[0]?.values[base.id],
      [{ id: "77777777-7777-4777-8777-777777777777", fallback: "Prior name" }]);
    assert.throws(() => normalizeCollection({ ...collection, records: [{ ...collection.records[0],
      values: { [base.id]: [{ id: "not-an-id", fallback: "Unreadable" }] } }] }), /invalid_collection/);
  });

  test("normalizes reusable view state without mixing presentation into records", () => {
    const definition = normalizeViewDefinition({ source: { kind: "collection", collectionId: "33333333-3333-4333-8333-333333333333" },
      presentation: "board", filters: [{ propertyId: base.id, operator: "equals", value: "Ready" }],
      sorts: [{ propertyId: base.id, direction: "ascending" }], groupBy: base.id, layout: { density: "compact" },
      focused: { recordId: "66666666-6666-4666-8666-666666666666" } });

    assert.equal(definition.presentation, "board");
    assert.deepEqual(definition.focused, { recordId: "66666666-6666-4666-8666-666666666666" });
    assert.throws(() => normalizeViewDefinition({ ...definition, presentation: "gallery" }), /invalid_view_definition/);
    assert.throws(() => normalizeViewDefinition({ ...definition, records: [] }), /invalid_view_definition/);
    const view = normalizeViewBlock({ schema: "stash.view-block.v1", id: "88888888-8888-4888-8888-888888888888",
      workspaceId: "44444444-4444-4444-8444-444444444444", ownerNoteId: "55555555-5555-4555-8555-555555555555",
      blockId: "99999999-9999-4999-8999-999999999999", title: "Research lens", definition });
    assert.deepEqual(view.definition, definition);
  });

  test("creates canonical Collections through the capability seam and preserves client-generated record identities", async () => {
    const received: unknown[] = [];
    const repository = { async create(_memberId: string, collection: unknown) { received.push(collection); return { status: "created", collection }; },
      async readCollection() { return { status: "collection_not_found" as const }; } } as unknown as CollectionRepository;
    const service = new CollectionService(repository);
    const property = { ...base, type: "text" as const };
    const collection = { schema: "stash.collection.v1" as const, id: "33333333-3333-4333-8333-333333333333",
      workspaceId: "44444444-4444-4444-8444-444444444444", ownerNoteId: "55555555-5555-4555-8555-555555555555",
      title: "Research", properties: [property], records: [{ id: "66666666-6666-4666-8666-666666666666", position: 1,
        values: { [base.id]: "Map the constraints" } }] };

    const result = await service.create("member", collection.ownerNoteId, collection);

    assert.equal(result.status, "created");
    assert.equal((received[0] as typeof collection).records[0]?.id, "66666666-6666-4666-8666-666666666666");
    assert.throws(() => service.create("member", "77777777-7777-4777-8777-777777777777", collection), InvalidCollectionInput);
    assert.deepEqual(await service.read("member", collection.id), { status: "collection_not_found" });
  });

  test("creates an immediately useful Collection when no properties were supplied", async () => {
    let created: ReturnType<typeof normalizeCollection> | undefined;
    const repository = {
      async create(_memberId: string, collection: ReturnType<typeof normalizeCollection>) {
        created = collection;
        return { status: "created" as const, collection };
      },
    } as unknown as CollectionRepository;
    const service = new CollectionService(repository);

    const result = await service.create("member", "55555555-5555-4555-8555-555555555555", {
      schema: "stash.collection.v1", id: "33333333-3333-4333-8333-333333333333",
      workspaceId: "44444444-4444-4444-8444-444444444444", ownerNoteId: "55555555-5555-4555-8555-555555555555",
      title: "Untitled collection", properties: [], records: [],
    });

    assert.equal(result.status, "created");
    assert.equal(created?.properties.length, 1);
    assert.deepEqual(created?.properties[0] && { name: created.properties[0].name, type: created.properties[0].type,
      position: created.properties[0].position }, { name: "Name", type: "text", position: 1 });
    assert.match(created?.properties[0]?.id ?? "", /^[0-9a-f-]{36}$/i);
  });

  test("updates, reorders, and deletes properties atomically while reporting the affected canonical data", async () => {
    const store = await EmbeddedInstanceStore.open(await temporaryTestDirectory("stash-collection-properties-"),
      createAuthenticationSecretCodec(randomBytes(32).toString("base64")));
    try {
      const ownerId = "18181818-1818-4818-8818-181818181818";
      await store.database.createFirstOrganizationOwner({ organizationId: "19191919-1919-4919-8919-191919191919",
        organizationName: "Studio", ownerId, ownerName: "Ada", ownerEmail: "properties@example.test", passwordHash: "test-only", role: "Owner" });
      const workspace = await new WorkspaceProjectService(store.database.identityAccessRepositories()).createWorkspace(ownerId,
        { name: "Notebook", owner: { type: "personal" } });
      assert.equal(workspace.status, "created"); if (workspace.status !== "created") return;
      const note = await new NoteTreeService(store.database.noteTreeRepository(), new EmptyCollectionImpactInspector())
        .create(ownerId, workspace.workspace.id, { title: "Research" });
      assert.equal(note.status, "created"); if (note.status !== "created") return;
      const nameId = "20202020-2020-4020-8020-202020202020"; const statusId = "21212121-2121-4121-8121-212121212121";
      const collection = normalizeCollection({ schema: "stash.collection.v1", id: "22222222-2222-4222-8222-222222222222",
        workspaceId: workspace.workspace.id, ownerNoteId: note.node.id, title: "Research", properties: [
          { id: nameId, name: "Name", type: "text", position: 1 },
          { id: statusId, name: "Stage", type: "single_select", position: 2, options: [{ id: "open", name: "Open" }] },
        ], records: [{ id: "23232323-2323-4323-8323-232323232323", position: 1,
          values: { [nameId]: "Map constraints", [statusId]: "open" } }] });
      const service = new CollectionService(store.database.collectionRepository());
      assert.equal((await service.create(ownerId, note.node.id, collection)).status, "created");

      const renamed = await service.updateProperty(ownerId, collection.id, statusId, { name: "Status" });
      assert.equal(renamed.status, "updated");
      if (renamed.status === "updated") assert.equal(renamed.collection.properties[1]?.name, "Status");
      const reordered = await service.reorderProperties(ownerId, collection.id, { propertyIds: [statusId, nameId] });
      assert.equal(reordered.status, "updated");
      if (reordered.status === "updated") assert.deepEqual(reordered.collection.properties.map(({ id, position }) => [id, position]),
        [[statusId, 1], [nameId, 2]]);

      assert.deepEqual(await service.deleteProperty(ownerId, collection.id, nameId), { status: "primary_property_required" });
      const deleted = await service.deleteProperty(ownerId, collection.id, statusId);
      assert.equal(deleted.status, "updated");
      if (deleted.status === "updated") {
        assert.deepEqual(deleted.collection.properties.map(({ id, position }) => [id, position]), [[nameId, 1]]);
        assert.equal(Object.hasOwn(deleted.collection.records[0]!.values, statusId), false);
        assert.deepEqual(deleted.impact, { affectedValues: 1, affectedRelations: 0, affectedViews: 0 });
      }
    } finally { await store.close(); }
  });

  test("persists canonical Collections through the focused PGLite adapter and filters unauthorized reads before metadata", async () => {
    const store = await EmbeddedInstanceStore.open(await temporaryTestDirectory("stash-collections-"),
      createAuthenticationSecretCodec(randomBytes(32).toString("base64")));
    try {
      const ownerId = "88888888-8888-4888-8888-888888888888";
      await store.database.createFirstOrganizationOwner({ organizationId: "99999999-9999-4999-8999-999999999999",
        organizationName: "Studio", ownerId, ownerName: "Ada", ownerEmail: "ada@example.test", passwordHash: "test-only", role: "Owner" });
      const workspaceResult = await new WorkspaceProjectService(store.database.identityAccessRepositories()).createWorkspace(ownerId,
        { name: "Notebook", owner: { type: "personal" } });
      assert.equal(workspaceResult.status, "created"); if (workspaceResult.status !== "created") return;
      const noteResult = await new NoteTreeService(store.database.noteTreeRepository(), new EmptyCollectionImpactInspector())
        .create(ownerId, workspaceResult.workspace.id, { title: "Research" });
      assert.equal(noteResult.status, "created"); if (noteResult.status !== "created") return;
      const dashboardResult = await new NoteTreeService(store.database.noteTreeRepository(), new EmptyCollectionImpactInspector())
        .create(ownerId, workspaceResult.workspace.id, { title: "Dashboard" });
      assert.equal(dashboardResult.status, "created"); if (dashboardResult.status !== "created") return;
      const property = { ...base, type: "relation" as const, target: { kind: "notes" as const } };
      const collection = normalizeCollection({ schema: "stash.collection.v1", id: "33333333-3333-4333-8333-333333333333",
        workspaceId: workspaceResult.workspace.id, ownerNoteId: noteResult.node.id, title: "Research map", properties: [property],
        records: [{ id: "66666666-6666-4666-8666-666666666666", position: 1,
          values: { [base.id]: [{ id: noteResult.node.id, fallback: "Research" }] } }] });
      const service = new CollectionService(store.database.collectionRepository());

      assert.notEqual(store.database.collectionRepository(), store.database.tutorialContributionRepository(),
        "canonical Collection persistence must use a focused adapter, not the tutorial contribution adapter");

      assert.equal((await service.create(ownerId, noteResult.node.id, collection)).status, "created");
      assert.deepEqual(await service.read(ownerId, collection.id), { status: "found", collection });
      assert.equal((await service.rename(ownerId, collection.id, { title: "Renamed map" })).status, "updated");
      assert.equal((await service.rename(ownerId, collection.id, { propertyId: base.id, name: "Related Note" })).status, "updated");
      assert.equal((await service.moveRecord(ownerId, collection.id, collection.records[0]!.id, {})).status, "moved");
      const renamed = await service.read(ownerId, collection.id);
      assert.equal(renamed.status, "found");
      if (renamed.status === "found") {
        assert.equal(renamed.collection.title, "Renamed map");
        assert.equal(renamed.collection.properties[0]?.name, "Related Note");
        assert.deepEqual(renamed.collection.records[0]?.values[base.id], collection.records[0]?.values[base.id]);
        assert.equal(renamed.collection.records[0]?.id, collection.records[0]?.id);
      }
      const view = normalizeViewBlock({ schema: "stash.view-block.v1", id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        workspaceId: workspaceResult.workspace.id, ownerNoteId: dashboardResult.node.id,
        blockId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", title: "Research board", definition: {
          source: { kind: "collection", collectionId: collection.id }, presentation: "board", filters: [], sorts: [],
          groupBy: base.id, layout: { density: "comfortable" }, focused: { recordId: collection.records[0]!.id },
        } });
      assert.equal((await service.createView(ownerId, dashboardResult.node.id, view)).status, "created");
      const opened = await service.readView(ownerId, view.id);
      assert.equal(opened.status, "found");
      if (opened.status === "found" && opened.source.kind === "collection") {
        assert.equal(opened.view.ownerNoteId, dashboardResult.node.id);
        assert.equal(opened.source.collection.id, collection.id);
        assert.equal(opened.source.collection.records[0]?.id, collection.records[0]?.id);
      }
      assert.equal((await service.updateView(ownerId, view.id, { ...view.definition, presentation: "calendar", groupBy: undefined })).status, "updated");
      const collectionAfterViewChange = await service.read(ownerId, collection.id);
      assert.equal(collectionAfterViewChange.status, "found");
      if (collectionAfterViewChange.status === "found") assert.deepEqual(collectionAfterViewChange.collection.records,
        renamed.status === "found" ? renamed.collection.records : []);
      const impact = await service.previewRemoval(ownerId, noteResult.node.id);
      assert.equal(impact.status, "found");
      if (impact.status === "found") {
        assert.deepEqual(impact.impact.collections.map(({ id, recordCount }) => ({ id, recordCount })), [{ id: collection.id, recordCount: 1 }]);
        assert.deepEqual(impact.impact.viewBlocks.map(({ id }) => id), [view.id]);
        assert.ok(impact.impact.token.length > 10);
      }
      const noteTree = new NoteTreeService(store.database.noteTreeRepository(), store.database.tutorialContributionRepository());
      assert.equal((await noteTree.remove(ownerId, noteResult.node.id, "archived")).status, "updated");
      assert.equal((await service.read(ownerId, collection.id)).status, "found", "archive retains canonical structured data");
      assert.equal((await service.readView(ownerId, view.id)).status, "found", "archive retains reusable views in accessible Notes");
      assert.equal((await noteTree.restore(ownerId, noteResult.node.id)).status, "restored");
      assert.equal((await service.relocate(ownerId, noteResult.node.id,
        { destinationNoteId: dashboardResult.node.id, collectionIds: [collection.id] })).status, "relocated");
      assert.equal((await service.read(ownerId, collection.id) as { collection?: { ownerNoteId: string } }).collection?.ownerNoteId, dashboardResult.node.id);
      assert.equal((await noteTree.remove(ownerId, noteResult.node.id, "trashed")).status, "updated",
        "relocation removes the Collection ownership blocker");
      const forbidden = await service.read("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", collection.id);
      assert.deepEqual(forbidden, { status: "collection_not_found" });
      assert.doesNotMatch(JSON.stringify(forbidden), /Research map|Research/);
    } finally { await store.close(); }
  });

  test("deletes only after an exact confirmed impact preview and repairs relations, views, projections, and Note ownership", async () => {
    const store = await EmbeddedInstanceStore.open(await temporaryTestDirectory("stash-collection-deletion-"),
      createAuthenticationSecretCodec(randomBytes(32).toString("base64")));
    try {
      const ownerId = "10101010-1010-4010-8010-101010101010";
      await store.database.createFirstOrganizationOwner({ organizationId: "20202020-2020-4020-8020-202020202020", organizationName: "Studio",
        ownerId, ownerName: "Ada", ownerEmail: "delete@example.test", passwordHash: "test-only", role: "Owner" });
      const workspace = await new WorkspaceProjectService(store.database.identityAccessRepositories()).createWorkspace(ownerId, { name: "Notebook", owner: { type: "personal" } });
      assert.equal(workspace.status, "created"); if (workspace.status !== "created") return;
      const notes = new NoteTreeService(store.database.noteTreeRepository(), store.database.tutorialContributionRepository());
      const ownerNote = await notes.create(ownerId, workspace.workspace.id, { title: "Source" });
      const relationNote = await notes.create(ownerId, workspace.workspace.id, { title: "Relations" });
      const dashboardNote = await notes.create(ownerId, workspace.workspace.id, { title: "Dashboard" });
      assert.equal(ownerNote.status, "created"); assert.equal(relationNote.status, "created"); assert.equal(dashboardNote.status, "created");
      if (ownerNote.status !== "created" || relationNote.status !== "created" || dashboardNote.status !== "created") return;
      const service = new CollectionService(store.database.collectionRepository());
      const targetId = "30303030-3030-4030-8030-303030303030"; const targetRecordId = "40404040-4040-4040-8040-404040404040";
      const titlePropertyId = "50505050-5050-4050-8050-505050505050";
      const target = normalizeCollection({ schema: "stash.collection.v1", id: targetId, workspaceId: workspace.workspace.id,
        ownerNoteId: ownerNote.node.id, title: "Target", properties: [{ id: titlePropertyId, name: "Name", type: "text", position: 1 }],
        records: [{ id: targetRecordId, position: 1, values: { [titlePropertyId]: "Canonical target" } }] });
      const relationCollectionId = "60606060-6060-4060-8060-606060606060"; const relationPropertyId = "70707070-7070-4070-8070-707070707070";
      const relationRecordId = "80808080-8080-4080-8080-808080808080";
      const referrer = normalizeCollection({ schema: "stash.collection.v1", id: relationCollectionId, workspaceId: workspace.workspace.id,
        ownerNoteId: relationNote.node.id, title: "Referrer", properties: [{ id: relationPropertyId, name: "Target", type: "relation", position: 1,
          target: { kind: "collection_records", collectionId: targetId } }], records: [{ id: relationRecordId, position: 1,
            values: { [relationPropertyId]: [{ id: targetRecordId, fallback: "Canonical target" }] } }] });
      assert.equal((await service.create(ownerId, ownerNote.node.id, target)).status, "created");
      assert.equal((await service.create(ownerId, relationNote.node.id, referrer)).status, "created");
      const view = normalizeViewBlock({ schema: "stash.view-block.v1", id: "90909090-9090-4090-8090-909090909090",
        workspaceId: workspace.workspace.id, ownerNoteId: dashboardNote.node.id, blockId: "abababab-abab-4bab-8bab-abababababab", title: "Target view",
        definition: { source: { kind: "collection", collectionId: targetId }, presentation: "table", filters: [], sorts: [], layout: {} } });
      assert.equal((await service.createView(ownerId, dashboardNote.node.id, view)).status, "created");
      const preview = await service.previewRemoval(ownerId, ownerNote.node.id);
      assert.equal(preview.status, "found"); if (preview.status !== "found") return;
      assert.equal(preview.impact.collections[0]?.recordCount, 1); assert.equal(preview.impact.relations[0]?.referenceCount, 1);
      assert.deepEqual(preview.impact.viewBlocks.map(({ id }) => id), [view.id]);
      assert.equal((await service.delete(ownerId, ownerNote.node.id,
        { confirmed: true, impactToken: `${preview.impact.token}-stale`, collectionIds: [targetId] })).status, "impact_changed");

      const deleted = await service.delete(ownerId, ownerNote.node.id,
        { confirmed: true, impactToken: preview.impact.token, collectionIds: [targetId] });

      assert.deepEqual(deleted, { status: "deleted", collectionIds: [targetId] });
      assert.deepEqual(await service.read(ownerId, targetId), { status: "collection_not_found" });
      assert.deepEqual(await service.readView(ownerId, view.id), { status: "view_not_found" });
      const repaired = await service.read(ownerId, relationCollectionId); assert.equal(repaired.status, "found");
      if (repaired.status === "found") assert.deepEqual(repaired.collection.records[0]?.values[relationPropertyId], []);
      const staleProjections = await store.upgradeDatabase.query<{ count: number }>(`SELECT count(*)::int count FROM stash_portable_projection_outbox
        WHERE (object_kind='Collection' AND object_id=$1) OR (object_kind='ViewBlock' AND object_id=$2)`, [targetId, view.id]);
      assert.equal(staleProjections.rows[0]?.count, 0);
      assert.equal((await notes.remove(ownerId, ownerNote.node.id, "trashed")).status, "updated");
    } finally { await store.close(); }
  });

  test("removes forbidden relation identities and fallbacks before returning Collection or View metadata", async () => {
    const store = await EmbeddedInstanceStore.open(await temporaryTestDirectory("stash-collection-permissions-"),
      createAuthenticationSecretCodec(randomBytes(32).toString("base64")));
    try {
      const ownerId = "12121212-1212-4212-8212-121212121212"; const guestId = "13131313-1313-4313-8313-131313131313";
      const organizationId = "14141414-1414-4414-8414-141414141414";
      await store.database.createFirstOrganizationOwner({ organizationId, organizationName: "Studio", ownerId, ownerName: "Ada",
        ownerEmail: "permissions@example.test", passwordHash: "test-only", role: "Owner" });
      await store.upgradeDatabase.query("INSERT INTO stash_accounts(id,name,email,password_hash) VALUES($1,'Guest','guest-collection@example.test','test-only')", [guestId]);
      const workspaces = new WorkspaceProjectService(store.database.identityAccessRepositories());
      const workspace = await workspaces.createWorkspace(ownerId, { name: "Notebook", owner: { type: "organization", organizationId } });
      assert.equal(workspace.status, "created"); if (workspace.status !== "created") return;
      const project = await workspaces.createProject(ownerId, workspace.workspace.id, { name: "Shared", key: "SHARED" });
      assert.equal(project.status, "created"); if (project.status !== "created") return;
      const notes = new NoteTreeService(store.database.noteTreeRepository(), store.database.tutorialContributionRepository());
      const visible = await notes.create(ownerId, workspace.workspace.id, { title: "Visible" });
      const hidden = await notes.create(ownerId, workspace.workspace.id, { title: "Private roadmap" });
      assert.equal(visible.status, "created"); assert.equal(hidden.status, "created"); if (visible.status !== "created" || hidden.status !== "created") return;
      assert.equal((await new NoteService(store.database.knowledgeAuthoringRepositories()).triage(ownerId, workspace.workspace.id, visible.node.id,
        { action: "organize", projectId: project.project.id })).status, "updated");
      await store.upgradeDatabase.query("INSERT INTO stash_project_guests(project_id,account_id) VALUES($1,$2)", [project.project.id, guestId]);
      const relationPropertyId = "15151515-1515-4515-8515-151515151515"; const collectionId = "16161616-1616-4616-8616-161616161616";
      const collection = normalizeCollection({ schema: "stash.collection.v1", id: collectionId, workspaceId: workspace.workspace.id,
        ownerNoteId: visible.node.id, title: "Shared lens", properties: [{ id: relationPropertyId, name: "Notes", type: "relation", position: 1,
          target: { kind: "notes" } }], records: [{ id: "17171717-1717-4717-8717-171717171717", position: 1,
            values: { [relationPropertyId]: [{ id: visible.node.id, fallback: "Visible" }, { id: hidden.node.id, fallback: "Private roadmap" }] } }] });
      const service = new CollectionService(store.database.collectionRepository()); assert.equal((await service.create(ownerId, visible.node.id, collection)).status, "created");
      const guest = await service.read(guestId, collectionId); assert.equal(guest.status, "found");
      if (guest.status === "found") assert.deepEqual(guest.collection.records[0]?.values[relationPropertyId], [{ id: visible.node.id, fallback: "Visible" }]);
      assert.doesNotMatch(JSON.stringify(guest), new RegExp(`Private roadmap|${hidden.node.id}`));
    } finally { await store.close(); }
  });
});
