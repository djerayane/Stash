import { temporaryTestDirectory } from "../support/temporary-directory.js";

import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";

import { createAuthenticationSecretCodec } from "../../src/authentication-secrets.js";
import { createCapabilityRegistry } from "../../src/capability-registry.js";
import { EmbeddedInstanceStore } from "../../src/embedded-instance-store.js";
import { startInstance, type RunningInstance } from "../support/start-test-instance.js";
import { CollectionService } from "../../src/knowledge-authoring/collections.js";
import { collectionRoutes } from "../../src/knowledge-authoring/collection-routes.js";
import { EmptyCollectionImpactInspector, NoteTreeService } from "../../src/knowledge-authoring/note-tree.js";
import { WorkspaceProjectService, type MemberAccessResolver } from "../../src/workspaces-projects.js";

describe("Collection HTTP capability", () => {
  const ownerId = "18181818-1818-4818-8818-181818181818"; let store: EmbeddedInstanceStore; let instance: RunningInstance;
  let workspaceId: string; let noteId: string; let dashboardId: string; let collectionService: CollectionService;
  before(async () => {
    store = await EmbeddedInstanceStore.open(await temporaryTestDirectory("stash-collections-http-"),
      createAuthenticationSecretCodec(randomBytes(32).toString("base64")));
    await store.database.createFirstOrganizationOwner({ organizationId: "19191919-1919-4919-8919-191919191919", organizationName: "Studio",
      ownerId, ownerName: "Ada", ownerEmail: "collections-http@example.test", passwordHash: "test-only", role: "Owner" });
    const workspace = await new WorkspaceProjectService(store.database.identityAccessRepositories()).createWorkspace(ownerId, { name: "Notebook", owner: { type: "personal" } });
    assert.equal(workspace.status, "created"); if (workspace.status !== "created") throw new Error("workspace setup failed"); workspaceId = workspace.workspace.id;
    const note = await new NoteTreeService(store.database.noteTreeRepository(), new EmptyCollectionImpactInspector())
      .create(ownerId, workspaceId, { title: "Research" });
    assert.equal(note.status, "created"); if (note.status !== "created") throw new Error("note setup failed"); noteId = note.node.id;
    const dashboard = await new NoteTreeService(store.database.noteTreeRepository(), new EmptyCollectionImpactInspector())
      .create(ownerId, workspaceId, { title: "Dashboard" });
    assert.equal(dashboard.status, "created"); if (dashboard.status !== "created") throw new Error("dashboard setup failed"); dashboardId = dashboard.node.id;
    const access: MemberAccessResolver = { async authenticateBearer(header) { return header === "Bearer owner"
      ? { accountId: ownerId, sessionId: "session" } : undefined; } };
    collectionService = new CollectionService(store.database.collectionRepository());
    instance = await startInstance({ database: store.database, host: "127.0.0.1", port: 0, instanceAdminToken: "admin",
      memberAccess: access, capabilities: createCapabilityRegistry([{ name: "knowledge-authoring", routes: () => [collectionRoutes(
        collectionService, access)] }]) });
  });
  after(async () => { await instance.close(); await store.close(); });
  const call = (path: string, init: RequestInit = {}) => fetch(`${instance.url}${path}`, { ...init,
    headers: { authorization: "Bearer owner", "content-type": "application/json", ...init.headers } });

  test("serves create, record, View Block, validation, and impact behavior without tutorial routes", async () => {
    assert.equal((await fetch(`${instance.url}/api/notes/${noteId}/collections`)).status, 401);
    const empty = await call(`/api/notes/${noteId}/collections`);
    assert.equal(empty.status, 200);
    assert.deepEqual(await empty.json(), { workspaceId, collections: [], availableCollections: [], availableCollectionNotes: {}, access: { read: true, edit: true },
      availableNotes: [{ id: dashboardId, title: "Dashboard" }, { id: noteId, title: "Research" }], selectionOptions: {
        members: [{ id: ownerId, label: "Ada" }], attachments: [],
        notes: [{ id: dashboardId, label: "Dashboard" }, { id: noteId, label: "Research" }], tasks: [], projects: [],
      }, views: [] });
    const propertyId = "20212223-2425-4627-8829-303132333435"; const collectionId = "30313233-3435-4637-8839-404142434445";
    const created = await call(`/api/notes/${noteId}/collections`, { method: "POST", body: JSON.stringify({ schema: "stash.collection.v1",
      id: collectionId, workspaceId, ownerNoteId: noteId, title: "Research", properties: [{ id: propertyId, name: "Idea", type: "text", position: 1 }], records: [] }) });
    assert.equal(created.status, 201); assert.equal((await created.json() as any).collection.id, collectionId);
    const numberPropertyId = "41414141-4141-4141-8141-414141414141";
    const addedProperty = await call(`/api/collections/${collectionId}/properties`, { method: "POST", body: JSON.stringify({
      id: numberPropertyId, name: "Priority", type: "number", position: 2 }) });
    assert.equal(addedProperty.status, 201);
    const renamedProperty = await call(`/api/collections/${collectionId}/properties/${numberPropertyId}`, { method: "PATCH",
      body: JSON.stringify({ name: "Score" }) });
    assert.equal(renamedProperty.status, 200);
    assert.equal((await renamedProperty.json() as any).collection.properties[1].name, "Score");
    const reordered = await call(`/api/collections/${collectionId}/properties/order`, { method: "PATCH",
      body: JSON.stringify({ propertyIds: [numberPropertyId, propertyId] }) });
    assert.equal(reordered.status, 200);
    assert.deepEqual((await reordered.json() as any).collection.properties.map(({ id, position }: any) => [id, position]),
      [[numberPropertyId, 1], [propertyId, 2]]);
    const protectedProperty = await call(`/api/collections/${collectionId}/properties/${propertyId}/impact`);
    assert.equal(protectedProperty.status, 409);
    assert.equal((await protectedProperty.json() as any).error, "primary_property_required");
    const propertyImpact = await call(`/api/collections/${collectionId}/properties/${numberPropertyId}/impact`);
    assert.equal(propertyImpact.status, 200); const propertyPreview = (await propertyImpact.json() as any).impact;
    assert.deepEqual({ affectedValues: propertyPreview.affectedValues, affectedRelations: propertyPreview.affectedRelations,
      affectedViews: propertyPreview.affectedViews }, { affectedValues: 0, affectedRelations: 0, affectedViews: 0 });
    assert.equal((await call(`/api/collections/${collectionId}/properties/${numberPropertyId}`, { method: "DELETE",
      body: JSON.stringify({ impactToken: `${propertyPreview.token}-stale` }) })).status, 409);
    const deletedProperty = await call(`/api/collections/${collectionId}/properties/${numberPropertyId}`, { method: "DELETE",
      body: JSON.stringify({ impactToken: propertyPreview.token }) });
    assert.equal(deletedProperty.status, 200);
    assert.deepEqual({ ...(await deletedProperty.json() as any).impact, token: undefined },
      { collectionId, propertyId: numberPropertyId, affectedValues: 0, affectedRelations: 0, affectedViews: 0, token: undefined });
    assert.equal((await call(`/api/notes/${noteId}/collections`, { method: "POST", body: JSON.stringify({ schema: "stash.collection.v1",
      id: "40414243-4445-4647-8849-505152535455", workspaceId, ownerNoteId: noteId, title: "Invalid",
      properties: [{ id: "50515253-5455-4657-8859-606162636465", name: "Formula", type: "formula", position: 1 }], records: [] }) })).status, 422);
    const recordId = "60616263-6465-4667-8869-707172737475";
    const createdRecord = await call(`/api/collections/${collectionId}/records`, { method: "POST", body: JSON.stringify({ id: recordId, position: 1,
      values: { [propertyId]: "Map constraints" } }) });
    assert.equal(createdRecord.status, 201); assert.equal((await createdRecord.json() as any).record.revision, 1);
    const operationId = "61616161-6161-4161-8161-616161616161";
    const applied = await call(`/api/collections/${collectionId}/records/${recordId}`, { method: "PATCH",
      body: JSON.stringify({ operationId, baseRevision: 1, values: { [propertyId]: "Map stable constraints" } }) });
    assert.equal(applied.status, 200); assert.equal((await applied.json() as any).record.revision, 2);
    const intervening = await call(`/api/collections/${collectionId}/records/${recordId}`, { method: "PATCH",
      body: JSON.stringify({ values: { [propertyId]: "Intervening edit" } }) });
    assert.equal(intervening.status, 200); assert.equal((await intervening.json() as any).record.revision, 3);
    const replay = await call(`/api/collections/${collectionId}/records/${recordId}`, { method: "PATCH",
      body: JSON.stringify({ operationId, baseRevision: 1, values: { [propertyId]: "Map stable constraints" } }) });
    assert.equal(replay.status, 200); assert.deepEqual((await replay.json() as any).record,
      { id: recordId, position: 1, revision: 2, values: { [propertyId]: "Map stable constraints" } });
    const afterReplay = await call(`/api/collections/${collectionId}`);
    assert.equal((await afterReplay.json() as any).collection.records[0].values[propertyId], "Intervening edit",
      "a replayed operation receipt must not overwrite a later canonical edit");
    const stale = await call(`/api/collections/${collectionId}/records/${recordId}`, { method: "PATCH",
      body: JSON.stringify({ operationId: "62626262-6262-4262-8262-626262626262", baseRevision: 2,
        values: { [propertyId]: "Stale offline edit" } }) });
    assert.equal(stale.status, 409); assert.deepEqual((await stale.json() as any).record,
      { id: recordId, position: 1, revision: 3, values: { [propertyId]: "Intervening edit" } });
    assert.equal((await call(`/api/collections/${collectionId}/records/${recordId}`, { method: "PATCH",
      body: JSON.stringify({ values: { [propertyId]: "Map stable constraints" } }) })).status, 200);
    const dashboardSources = await call(`/api/notes/${dashboardId}/collections`); assert.equal(dashboardSources.status, 200);
    assert.deepEqual((await dashboardSources.json() as any).availableCollections.map(({ id }: { id: string }) => id), [collectionId]);
    const viewId = "70717273-7475-4677-8879-808182838485";
    const view = await call(`/api/notes/${dashboardId}/view-blocks`, { method: "POST", body: JSON.stringify({ schema: "stash.view-block.v1",
      id: viewId, workspaceId, ownerNoteId: dashboardId, blockId: "80818283-8485-4687-8889-909192939495", title: "Research table",
      definition: { source: { kind: "collection", collectionId }, presentation: "table", filters: [], sorts: [], layout: {} } }) });
    assert.equal(view.status, 201);
    const opened = await call(`/api/view-blocks/${viewId}`); assert.equal(opened.status, 200);
    assert.equal((await opened.json() as any).source.collection.records[0].id, recordId);
    const impact = await call(`/api/notes/${noteId}/collections/impact`); assert.equal(impact.status, 200);
    const collectionImpact = (await impact.json() as any).impact;
    assert.equal(collectionImpact.viewBlocks.length, 1);
    const staleDelete = await call(`/api/notes/${noteId}/collections/delete`, { method: "POST", body: JSON.stringify({
      confirmed: true, impactToken: `${collectionImpact.token}-stale`, collectionIds: [collectionId],
    }) });
    assert.equal(staleDelete.status, 409);
    assert.equal((await staleDelete.json() as any).impact.token, collectionImpact.token);

    const relationPropertyId = "91919191-9191-4191-8191-919191919191";
    const referrerId = "92929292-9292-4292-8292-929292929292";
    const relationRecords = Array.from({ length: 420 }, (_, index) => ({
      id: `93939393-9393-4393-8393-${String(index + 1).padStart(12, "0")}`,
      position: index + 1,
      values: { [relationPropertyId]: [{ id: recordId, fallback: "Map stable constraints" }] },
    }));
    assert.equal((await collectionService.create(ownerId, dashboardId, { schema: "stash.collection.v1", id: referrerId,
      workspaceId, ownerNoteId: dashboardId, title: "Large relation map", properties: [{ id: relationPropertyId,
        name: "Research", type: "relation", position: 1, target: { kind: "collection_records", collectionId } }],
      records: relationRecords })).status, "created");
    const largeImpactResponse = await call(`/api/notes/${noteId}/collections/impact`);
    assert.equal(largeImpactResponse.status, 200);
    const largeImpact = (await largeImpactResponse.json() as any).impact;
    assert.equal(largeImpact.relations.length, 420);
    assert.ok(Buffer.byteLength(largeImpact.token, "utf8") <= 100);
    const largeDelete = await call(`/api/notes/${noteId}/collections/delete`, { method: "POST", body: JSON.stringify({
      confirmed: true, impactToken: largeImpact.token, collectionIds: [collectionId],
    }) });
    assert.equal(largeDelete.status, 200, "a valid large-impact confirmation must stay below the HTTP request limit");
  });
});
