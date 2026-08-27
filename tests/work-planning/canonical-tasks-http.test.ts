import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { createAuthenticationSecretCodec } from "../../src/authentication-secrets.js";
import { createCapabilityRegistry } from "../../src/capability-registry.js";
import { EmbeddedInstanceStore } from "../../src/embedded-instance-store.js";
import { startInstance, type RunningInstance } from "../../src/instance.js";
import { canonicalTaskRoutes } from "../../src/work-planning/canonical-task-routes.js";
import { CanonicalTaskService } from "../../src/work-planning/canonical-tasks.js";
import { WorkspaceProjectService, type MemberAccessResolver } from "../../src/workspaces-projects.js";

let store: EmbeddedInstanceStore; let instance: RunningInstance; let workspaceId: string;
const ownerId = "61616161-6161-4161-8161-616161616161";
before(async () => {
  store = await EmbeddedInstanceStore.open(await mkdtemp(join(tmpdir(), "stash-task-http-")),
    createAuthenticationSecretCodec(randomBytes(32).toString("base64")));
  await store.database.createFirstOrganizationOwner({ organizationId: "62626262-6262-4262-8262-626262626262", organizationName: "Studio",
    ownerId, ownerName: "Ada", ownerEmail: "tasks-http@example.test", passwordHash: "test", role: "Owner" });
  const workspace = await new WorkspaceProjectService(store.database).createWorkspace(ownerId, { name: "Notebook", owner: { type: "personal" } });
  assert.equal(workspace.status, "created"); if (workspace.status !== "created") throw new Error("setup failed"); workspaceId = workspace.workspace.id;
  const access: MemberAccessResolver = { async authenticateBearer(header) { return header === "Bearer owner" ? { accountId: ownerId, sessionId: "session" } : undefined; } };
  instance = await startInstance({ database: store.database, host: "127.0.0.1", port: 0, instanceAdminToken: "admin", memberAccess: access,
    capabilities: createCapabilityRegistry([{ name: "work-planning", routes: () => [canonicalTaskRoutes(
      new CanonicalTaskService(store.database.canonicalTaskRepository()), access)] }]) });
});
after(async () => { await instance?.close(); await store?.close(); });
const call = (path: string, init: RequestInit = {}) => fetch(`${instance.url}${path}`, { ...init,
  headers: { authorization: "Bearer owner", "content-type": "application/json", ...init.headers } });

test("serves authenticated canonical Workspace Tasks with stable error semantics", async () => {
  assert.equal((await fetch(`${instance.url}/api/workspaces/${workspaceId}/canonical-tasks`)).status, 401);
  assert.equal((await call(`/api/workspaces/${workspaceId}/canonical-tasks`, { method: "POST", body: "{}" })).status, 422);
  const created = await call(`/api/workspaces/${workspaceId}/canonical-tasks`, { method: "POST", body: JSON.stringify({ title: "Projectless work" }) });
  assert.equal(created.status, 201); const task = (await created.json() as any).task;
  assert.deepEqual(task.projectAssociations, []); assert.equal(task.projectKeys.length, 0);
  const list = await call(`/api/workspaces/${workspaceId}/canonical-tasks`); assert.equal(list.status, 200);
  assert.equal((await list.json() as any).tasks[0].id, task.id);
  const workflow = await call(`/api/workspaces/${workspaceId}/workflow`); assert.equal(workflow.status, 200);
  const started = (await workflow.json() as any).workflow.statuses.find(({ category }: any) => category === "started");
  const moved = await call(`/api/canonical-tasks/${task.id}`, { method: "PATCH", body: JSON.stringify({ statusId: started.id }) });
  assert.equal(moved.status, 200); assert.equal((await moved.json() as any).task.status.id, started.id);
});
