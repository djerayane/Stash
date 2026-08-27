import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";

import { createAuthenticationSecretCodec } from "../../src/authentication-secrets.js";
import { ActivityService } from "../../src/activity.js";
import { createCapabilityRegistry } from "../../src/capability-registry.js";
import { EmbeddedInstanceStore } from "../../src/embedded-instance-store.js";
import { DiscussionService } from "../../src/discussions.js";
import { startInstance, type RunningInstance } from "../support/start-test-instance.js";
import { EmptyCollectionImpactInspector, NoteTreeService } from "../../src/knowledge-authoring/note-tree.js";
import { noteTreeRoutes } from "../../src/knowledge-authoring/note-tree-routes.js";
import { relationshipRoutes } from "../../src/knowledge-authoring/relationship-routes.js";
import { visualizationRoutes } from "../../src/knowledge-authoring/visualization-routes.js";
import { RelationshipQueryService } from "../../src/knowledge-authoring/relationship-query.js";
import { VisualizationBlockService } from "../../src/knowledge-authoring/visualization-block.js";
import { NoteService } from "../../src/notes.js";
import { WorkspaceProjectService, type MemberAccessResolver } from "../../src/workspaces-projects.js";

describe("Note Tree HTTP", () => {
  const ownerId = "30303030-3030-4030-8030-303030303030";
  const guestId = "31313131-3131-4131-8131-313131313131";
  const organizationId = "40404040-4040-4040-8040-404040404040";
  let store: EmbeddedInstanceStore;
  let instance: RunningInstance;
  let workspaceId: string;

  before(async () => {
    store = await EmbeddedInstanceStore.open(await mkdtemp(join(tmpdir(), "stash-note-tree-http-")),
      createAuthenticationSecretCodec(randomBytes(32).toString("base64")));
    await store.database.createFirstOrganizationOwner({ organizationId, organizationName: "Studio", ownerId, ownerName: "Grace",
      ownerEmail: "grace@example.test", passwordHash: "test-only", role: "Owner" });
    await store.upgradeDatabase.query(`INSERT INTO stash_accounts (id, name, email, password_hash)
      VALUES ($1, 'Guest', 'guest@example.test', 'test-only')`, [guestId]);
    const workspace = await new WorkspaceProjectService(store.database).createWorkspace(ownerId,
      { name: "Notebook", owner: { type: "organization", organizationId } });
    assert.equal(workspace.status, "created");
    if (workspace.status !== "created") throw new Error("workspace setup failed");
    workspaceId = workspace.workspace.id;
    const access: MemberAccessResolver = { async authenticateBearer(header) {
      return header === "Bearer owner" ? { accountId: ownerId, sessionId: "owner-session" }
        : header === "Bearer guest" ? { accountId: guestId, sessionId: "guest-session" } : undefined;
    } };
    instance = await startInstance({ database: store.database, host: "127.0.0.1", port: 0, instanceAdminToken: "admin",
      activities: new ActivityService(store.database), discussions: new DiscussionService(store.database), memberAccess: access,
      capabilities: createCapabilityRegistry([{ name: "knowledge-authoring", routes: () => [noteTreeRoutes(new NoteTreeService(
        store.database.noteTreeRepository(), new EmptyCollectionImpactInspector()), access), relationshipRoutes(
          new RelationshipQueryService(store.database.relationshipQueryRepository()), access), visualizationRoutes(
          new VisualizationBlockService(store.database.visualizationBlockRepository()), access)] }]) });
  });

  after(async () => { await instance.close(); await store.close(); });

  async function request(path: string, init: RequestInit = {}) {
    return fetch(`${instance.url}${path}`, { ...init, headers: { authorization: "Bearer owner", "content-type": "application/json", ...init.headers } });
  }

  function guestRequest(path: string, init: RequestInit = {}) {
    return request(path, { ...init, headers: { authorization: "Bearer guest", ...init.headers } });
  }

  test("authenticated Members operate the complete branch lifecycle through HTTP", async () => {
    assert.equal((await request(`/api/workspaces/${workspaceId}/note-tree`)).status, 200);
    const created = await request(`/api/workspaces/${workspaceId}/note-tree`, { method: "POST", body: JSON.stringify({ title: "Field guide" }) });
    assert.equal(created.status, 201);
    const root = (await created.json() as any).node;
    const childResponse = await request(`/api/workspaces/${workspaceId}/note-tree`, { method: "POST",
      body: JSON.stringify({ title: "Observations", parentId: root.id }) });
    assert.equal(childResponse.status, 201);
    const child = (await childResponse.json() as any).node;

    const cycle = await request(`/api/notes/${root.id}/move`, { method: "POST", body: JSON.stringify({ parentId: child.id }) });
    assert.equal(cycle.status, 409);
    assert.equal((await cycle.json() as any).error, "note_tree_cycle");
    const context = await request(`/api/notes/${child.id}/context`);
    assert.deepEqual((await context.json() as any).breadcrumbs.map(({ title }: any) => title), ["Field guide", "Observations"]);
    const linked = await request(`/api/notes/${root.id}/context/links`, { method: "POST",
      body: JSON.stringify({ targetNoteId: child.id, label: "Evidence", relationshipType: "supports" }) });
    assert.equal(linked.status, 201);
    assert.equal((await request(`/api/notes/${root.id}/context`).then((response) => response.json()) as any).outgoingLinks[0].relationshipType, "supports");

    const preview = await request(`/api/notes/${root.id}/branch-preview`, { method: "POST", body: JSON.stringify({ action: "trash" }) });
    assert.equal(preview.status, 200);
    assert.equal((await preview.json() as any).impact.descendantCount, 1);
    for (const action of ["archive", "trash", "restore"]) {
      const unsafe = await request(`/api/notes/${root.id}/${action}`);
      assert.equal(unsafe.status, 405);
      assert.equal(unsafe.headers.get("allow"), "POST");
    }
    assert.equal((await request(`/api/notes/${root.id}/archive`, { method: "PUT" })).status, 405);
    assert.equal((await request(`/api/notes/${child.id}/context`)).status, 200);
    assert.equal((await request(`/api/notes/${root.id}/trash`, { method: "POST" })).status, 200);
    assert.equal((await request(`/api/notes/${child.id}/context`)).status, 404);
    const removed = await request(`/api/workspaces/${workspaceId}/note-tree/removed`);
    assert.equal(removed.status, 200);
    assert.deepEqual((await removed.json() as any).branches.map(({ id, state }: any) => ({ id, state })), [{ id: root.id, state: "trashed" }]);
    const restored = await request(`/api/notes/${root.id}/restore`, { method: "POST" });
    assert.equal(restored.status, 200);
    assert.deepEqual((await restored.json() as any).restoredIds, [root.id, child.id]);
  });

  test("rejects unauthenticated and malformed Note Tree requests", async () => {
    assert.equal((await fetch(`${instance.url}/api/workspaces/${workspaceId}/note-tree`)).status, 401);
    assert.equal((await request(`/api/workspaces/${workspaceId}/note-tree`, { method: "POST", body: JSON.stringify({ title: "" }) })).status, 422);
  });

  test("inherited Project Guests can read child Discussions but cannot mutate or discover inaccessible links", async () => {
    const projects = new WorkspaceProjectService(store.database);
    const project = await projects.createProject(ownerId, workspaceId, { name: "Launch", key: "LAUNCH" });
    assert.equal(project.status, "created");
    if (project.status !== "created") return;

    const rootResponse = await request(`/api/workspaces/${workspaceId}/note-tree`, { method: "POST",
      body: JSON.stringify({ title: "Launch brief" }) });
    assert.equal(rootResponse.status, 201);
    const root = (await rootResponse.json() as any).node;
    const childResponse = await request(`/api/workspaces/${workspaceId}/note-tree`, { method: "POST",
      body: JSON.stringify({ title: "Guest-visible child", parentId: root.id }) });
    assert.equal(childResponse.status, 201);
    const child = (await childResponse.json() as any).node;
    const privateResponse = await request(`/api/workspaces/${workspaceId}/note-tree`, { method: "POST",
      body: JSON.stringify({ title: "Private research" }) });
    assert.equal(privateResponse.status, 201);
    const privateNote = (await privateResponse.json() as any).node;

    assert.equal((await new NoteService(store.database.knowledgeAuthoringRepositories()).triage(ownerId, workspaceId, root.id, {
      action: "organize", projectId: project.project.id,
    })).status, "updated");
    await store.upgradeDatabase.query("INSERT INTO stash_project_guests(project_id,account_id) VALUES($1,$2)",
      [project.project.id, guestId]);
    assert.equal((await request(`/api/notes/${child.id}/context/links`, { method: "POST",
      body: JSON.stringify({ targetNoteId: privateNote.id, label: "Private source" }) })).status, 201);

    const created = await request("/api/discussions", { method: "POST",
      body: JSON.stringify({ target: { kind: "note", noteId: child.id }, message: "Visible review context" }) });
    assert.equal(created.status, 201);
    const discussion = (await created.json() as any).discussion;

    const listed = await guestRequest(`/api/notes/${child.id}/discussions`);
    assert.equal(listed.status, 200);
    const listedBody = await listed.json() as any;
    assert.equal(listedBody.access, "read");
    assert.deepEqual(listedBody.discussions.map(({ id, messages }: any) => ({ id, content: messages[0].content })),
      [{ id: discussion.id, content: "Visible review context" }]);
    const context = await guestRequest(`/api/notes/${child.id}/context`);
    assert.equal(context.status, 200);
    assert.deepEqual((await context.json() as any).outgoingLinks, []);

    assert.equal((await guestRequest("/api/discussions", { method: "POST",
      body: JSON.stringify({ target: { kind: "note", noteId: child.id }, message: "Guest write" }) })).status, 403);
    assert.equal((await guestRequest(`/api/discussions/${discussion.id}/messages`, { method: "POST",
      body: JSON.stringify({ content: "Guest reply" }) })).status, 403);
    assert.equal((await guestRequest(`/api/discussions/${discussion.id}/resolution`, { method: "PUT", body: "{}" })).status, 403);

    const history = await guestRequest(`/api/notes/${child.id}/history`);
    assert.equal(history.status, 200);
    const historyBody = await history.json() as any;
    assert.equal(historyBody.access, "read");
    assert.equal(historyBody.revisions.length >= 1, true);
    assert.equal((await guestRequest(`/api/notes/${child.id}/history/1/restore`, { method: "POST",
      body: JSON.stringify({ expectedRevision: 1, idempotencyKey: "32323232-3232-4232-8232-323232323232" }) })).status, 404);

    const guestBlockId = "34343434-3434-4434-8434-343434343434";
    const guestDefinition = { schema: "stash.visualization.v1", id: guestBlockId, kind: "local-graph",
      query: { kind: "relationship", input: { rootId: child.id, depth: 1, limit: 20, direction: "both", includeHierarchy: true } },
      filters: { relationTypes: [], direction: "both" }, layout: { kind: "focused", positions: {} },
      viewEdges: [{ id: "guest-visible-edge", sourceNoteId: child.id, targetNoteId: root.id }] };
    assert.equal((await request(`/api/notes/${child.id}/visualizations/${guestBlockId}`, { method: "PUT",
      body: JSON.stringify({ definition: guestDefinition, idempotencyKey: "36363636-3636-4636-8636-363636363636" }) })).status, 200);
    assert.equal((await guestRequest(`/api/notes/${child.id}/visualizations/${guestBlockId}`)).status, 200);
    assert.equal((await guestRequest(`/api/notes/${child.id}/visualizations/${guestBlockId}`, { method: "PUT",
      body: JSON.stringify({ definition: guestDefinition, idempotencyKey: "37373737-3737-4737-8737-373737373737" }) })).status, 404);
    assert.equal((await guestRequest(`/api/notes/${child.id}/visualizations/${guestBlockId}/view-edges/guest-visible-edge/promote`, { method: "POST",
      body: JSON.stringify({ idempotencyKey: "35353535-3535-4535-8535-353535353535" }) })).status, 404);
  });

  test("serves bounded relationship and portable Visualization Block operations", async () => {
    const rootResponse = await request(`/api/workspaces/${workspaceId}/note-tree`, { method: "POST", body: JSON.stringify({ title: "Relationship root" }) });
    const root = (await rootResponse.json() as any).node;
    const childResponse = await request(`/api/workspaces/${workspaceId}/note-tree`, { method: "POST",
      body: JSON.stringify({ title: "Related child", parentId: root.id }) });
    const child = (await childResponse.json() as any).node;
    assert.equal((await request(`/api/notes/${root.id}/context/links`, { method: "POST",
      body: JSON.stringify({ targetNoteId: child.id, label: "Supports", relationshipType: "supports" }) })).status, 201);

    const neighborhood = await request(`/api/notes/${root.id}/relationships?depth=1&limit=20&direction=outgoing&relationType=supports&includeHierarchy=false`);
    assert.equal(neighborhood.status, 200);
    const neighborhoodBody = await neighborhood.json() as any;
    assert.deepEqual(neighborhoodBody.nodes.map(({ title }: any) => title), ["Relationship root", "Related child"]);
    assert.equal(neighborhoodBody.edges[0].relationshipType, "supports");
    assert.equal((await request(`/api/notes/${root.id}/relationships?depth=99`)).status, 422);
    assert.equal((await request(`/api/notes/${root.id}/relationships?includeHierarchy=sometimes`)).status, 422);
    assert.equal((await request(`/api/workspaces/${workspaceId}/relationships/maintenance`)).status, 200);

    const blockId = "78787878-7878-4878-8878-787878787878";
    const definition = { schema: "stash.visualization.v1", id: blockId, kind: "local-graph",
      query: { kind: "relationship", input: { rootId: root.id, depth: 1, limit: 20, direction: "both", includeHierarchy: true } },
      filters: { relationTypes: [], direction: "both" }, layout: { kind: "focused", positions: {} },
      viewEdges: [{ id: "http-view-edge", sourceNoteId: child.id, targetNoteId: root.id, relationshipType: "questions" }] };
    const saved = await request(`/api/notes/${root.id}/visualizations/${blockId}`, { method: "PUT",
      body: JSON.stringify({ definition, idempotencyKey: "38383838-3838-4838-8838-383838383838" }) });
    assert.equal(saved.status, 200);
    assert.equal((await saved.json() as any).block.revision, 1);
    assert.equal((await request(`/api/notes/${root.id}/visualizations/${blockId}`, { method: "PUT",
      body: JSON.stringify({ definition }) })).status, 422);
    assert.equal((await request(`/api/notes/${root.id}/visualizations/79797979-7979-4979-8979-797979797979`, { method: "PUT",
      body: JSON.stringify({ definition, idempotencyKey: "39393939-3939-4939-8939-393939393939" }) })).status, 422);
    assert.equal((await request(`/api/notes/${root.id}/visualizations/${blockId}`)).status, 200);
    const promoted = await request(`/api/notes/${root.id}/visualizations/${blockId}/view-edges/http-view-edge/promote`, { method: "POST",
      body: JSON.stringify({ idempotencyKey: "89898989-8989-4989-8989-898989898989" }) });
    assert.equal(promoted.status, 201);
    const childContext = await request(`/api/notes/${child.id}/context`);
    assert.equal((await childContext.json() as any).outgoingLinks.some(({ noteId, relationshipType }: any) =>
      noteId === root.id && relationshipType === "questions"), true);
  });
});
