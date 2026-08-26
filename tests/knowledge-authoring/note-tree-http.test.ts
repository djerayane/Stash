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
import { NoteTreeService } from "../../src/knowledge-authoring/note-tree.js";
import { noteTreeRoutes } from "../../src/knowledge-authoring/note-tree-routes.js";
import { WorkspaceProjectService, type MemberAccessResolver } from "../../src/workspaces-projects.js";

describe("Note Tree HTTP", () => {
  const ownerId = "30303030-3030-4030-8030-303030303030";
  const organizationId = "40404040-4040-4040-8040-404040404040";
  let store: EmbeddedInstanceStore;
  let instance: RunningInstance;
  let workspaceId: string;

  before(async () => {
    store = await EmbeddedInstanceStore.open(await mkdtemp(join(tmpdir(), "stash-note-tree-http-")),
      createAuthenticationSecretCodec(randomBytes(32).toString("base64")));
    await store.database.createFirstOrganizationOwner({ organizationId, organizationName: "Studio", ownerId, ownerName: "Grace",
      ownerEmail: "grace@example.test", passwordHash: "test-only", role: "Owner" });
    const workspace = await new WorkspaceProjectService(store.database).createWorkspace(ownerId,
      { name: "Notebook", owner: { type: "organization", organizationId } });
    assert.equal(workspace.status, "created");
    if (workspace.status !== "created") throw new Error("workspace setup failed");
    workspaceId = workspace.workspace.id;
    const access: MemberAccessResolver = { async authenticateBearer(header) {
      return header === "Bearer owner" ? { accountId: ownerId, sessionId: "session" } : undefined;
    } };
    instance = await startInstance({ database: store.database, host: "127.0.0.1", port: 0, instanceAdminToken: "admin",
      capabilities: createCapabilityRegistry([{ name: "knowledge-authoring", routes: () => [noteTreeRoutes(new NoteTreeService(store.database.noteTreeRepository()), access)] }]) });
  });

  after(async () => { await instance.close(); await store.close(); });

  async function request(path: string, init: RequestInit = {}) {
    return fetch(`${instance.url}${path}`, { ...init, headers: { authorization: "Bearer owner", "content-type": "application/json", ...init.headers } });
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

    const preview = await request(`/api/notes/${root.id}/branch-preview`, { method: "POST", body: JSON.stringify({ action: "trash" }) });
    assert.equal(preview.status, 200);
    assert.equal((await preview.json() as any).impact.descendantCount, 1);
    assert.equal((await request(`/api/notes/${root.id}/trash`, { method: "POST" })).status, 200);
    assert.equal((await request(`/api/notes/${child.id}/context`)).status, 404);
    const restored = await request(`/api/notes/${root.id}/restore`, { method: "POST" });
    assert.equal(restored.status, 200);
    assert.deepEqual((await restored.json() as any).restoredIds, [root.id, child.id]);
  });

  test("rejects unauthenticated and malformed Note Tree requests", async () => {
    assert.equal((await fetch(`${instance.url}/api/workspaces/${workspaceId}/note-tree`)).status, 401);
    assert.equal((await request(`/api/workspaces/${workspaceId}/note-tree`, { method: "POST", body: JSON.stringify({ title: "" }) })).status, 422);
  });
});
