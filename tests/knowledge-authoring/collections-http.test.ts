import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";

import { createAuthenticationSecretCodec } from "../../src/authentication-secrets.js";
import { createCapabilityRegistry } from "../../src/capability-registry.js";
import { EmbeddedInstanceStore } from "../../src/embedded-instance-store.js";
import { startInstance, type RunningInstance } from "../../src/instance.js";
import { CollectionService } from "../../src/knowledge-authoring/collections.js";
import { collectionRoutes } from "../../src/knowledge-authoring/collection-routes.js";
import { EmptyCollectionImpactInspector, NoteTreeService } from "../../src/knowledge-authoring/note-tree.js";
import { WorkspaceProjectService, type MemberAccessResolver } from "../../src/workspaces-projects.js";

describe("Collection HTTP capability", () => {
  const ownerId = "18181818-1818-4818-8818-181818181818"; let store: EmbeddedInstanceStore; let instance: RunningInstance;
  let workspaceId: string; let noteId: string; let dashboardId: string;
  before(async () => {
    store = await EmbeddedInstanceStore.open(await mkdtemp(join(tmpdir(), "stash-collections-http-")),
      createAuthenticationSecretCodec(randomBytes(32).toString("base64")));
    await store.database.createFirstOrganizationOwner({ organizationId: "19191919-1919-4919-8919-191919191919", organizationName: "Studio",
      ownerId, ownerName: "Ada", ownerEmail: "collections-http@example.test", passwordHash: "test-only", role: "Owner" });
    const workspace = await new WorkspaceProjectService(store.database).createWorkspace(ownerId, { name: "Notebook", owner: { type: "personal" } });
    assert.equal(workspace.status, "created"); if (workspace.status !== "created") throw new Error("workspace setup failed"); workspaceId = workspace.workspace.id;
    const note = await new NoteTreeService(store.database.noteTreeRepository(), new EmptyCollectionImpactInspector())
      .create(ownerId, workspaceId, { title: "Research" });
    assert.equal(note.status, "created"); if (note.status !== "created") throw new Error("note setup failed"); noteId = note.node.id;
    const dashboard = await new NoteTreeService(store.database.noteTreeRepository(), new EmptyCollectionImpactInspector())
      .create(ownerId, workspaceId, { title: "Dashboard" });
    assert.equal(dashboard.status, "created"); if (dashboard.status !== "created") throw new Error("dashboard setup failed"); dashboardId = dashboard.node.id;
    const access: MemberAccessResolver = { async authenticateBearer(header) { return header === "Bearer owner"
      ? { accountId: ownerId, sessionId: "session" } : undefined; } };
    instance = await startInstance({ database: store.database, host: "127.0.0.1", port: 0, instanceAdminToken: "admin",
      memberAccess: access, capabilities: createCapabilityRegistry([{ name: "knowledge-authoring", routes: () => [collectionRoutes(
        new CollectionService(store.database.collectionRepository()), access)] }]) });
  });
  after(async () => { await instance.close(); await store.close(); });
  const call = (path: string, init: RequestInit = {}) => fetch(`${instance.url}${path}`, { ...init,
    headers: { authorization: "Bearer owner", "content-type": "application/json", ...init.headers } });

  test("serves create, record, View Block, validation, and impact behavior without tutorial routes", async () => {
    assert.equal((await fetch(`${instance.url}/api/notes/${noteId}/collections`)).status, 401);
    const empty = await call(`/api/notes/${noteId}/collections`);
    assert.equal(empty.status, 200);
    assert.deepEqual(await empty.json(), { workspaceId, collections: [], availableCollections: [], views: [] });
    const propertyId = "20212223-2425-4627-8829-303132333435"; const collectionId = "30313233-3435-4637-8839-404142434445";
    const created = await call(`/api/notes/${noteId}/collections`, { method: "POST", body: JSON.stringify({ schema: "stash.collection.v1",
      id: collectionId, workspaceId, ownerNoteId: noteId, title: "Research", properties: [{ id: propertyId, name: "Idea", type: "text", position: 1 }], records: [] }) });
    assert.equal(created.status, 201); assert.equal((await created.json() as any).collection.id, collectionId);
    assert.equal((await call(`/api/notes/${noteId}/collections`, { method: "POST", body: JSON.stringify({ schema: "stash.collection.v1",
      id: "40414243-4445-4647-8849-505152535455", workspaceId, ownerNoteId: noteId, title: "Invalid",
      properties: [{ id: "50515253-5455-4657-8859-606162636465", name: "Formula", type: "formula", position: 1 }], records: [] }) })).status, 422);
    const recordId = "60616263-6465-4667-8869-707172737475";
    assert.equal((await call(`/api/collections/${collectionId}/records`, { method: "POST", body: JSON.stringify({ id: recordId, position: 1,
      values: { [propertyId]: "Map constraints" } }) })).status, 201);
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
    assert.equal((await impact.json() as any).impact.viewBlocks.length, 1);
  });
});
