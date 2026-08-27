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

test("preserves an offline canonical Task contribution across divergent synchronization",async()=>{
  const captured=await call(`/api/workspaces/${workspaceId}/canonical-tasks`,{method:"POST",body:JSON.stringify({title:"Offline captured Task"})});
  assert.equal(captured.status,201);const original=(await captured.json() as any).task;assert.equal(original.revision,1);
  const operationId="71717171-7171-4171-8171-717171717171";
  const localEnvelope={operationId,baseRevision:original.revision,changes:{title:"Offline local title"}};
  const serverEdit=await call(`/api/canonical-tasks/${original.id}`,{method:"PATCH",body:JSON.stringify({description:"Desktop detail"})});
  assert.equal(serverEdit.status,200);const divergent=(await serverEdit.json() as any).task;assert.equal(divergent.id,original.id);assert.equal(divergent.revision,2);
  const conflict=await call(`/api/canonical-tasks/${original.id}`,{method:"PATCH",body:JSON.stringify(localEnvelope)});
  assert.equal(conflict.status,409);const preserved=await conflict.json() as any;
  assert.equal(preserved.error,"revision_conflict");assert.equal(preserved.task.id,original.id);assert.equal(preserved.task.description,"Desktop detail");
  assert.deepEqual(preserved.changes,localEnvelope.changes);assert.equal(preserved.operationId,operationId);
  const duplicate=await call(`/api/canonical-tasks/${original.id}`,{method:"PATCH",body:JSON.stringify(localEnvelope)});
  assert.equal(duplicate.status,409);assert.deepEqual(await duplicate.json(),preserved,"retry keeps the same loss-preserving conflict");
  const reconciled=await call(`/api/canonical-tasks/${original.id}`,{method:"PATCH",body:JSON.stringify({operationId:"72727272-7272-4272-8272-727272727272",
    baseRevision:preserved.task.revision,changes:localEnvelope.changes})});
  assert.equal(reconciled.status,200);const finalTask=(await reconciled.json() as any).task;
  assert.equal(finalTask.id,original.id);assert.equal(finalTask.title,"Offline local title");assert.equal(finalTask.description,"Desktop detail");assert.equal(finalTask.revision,3);
});
