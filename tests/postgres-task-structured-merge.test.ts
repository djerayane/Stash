import assert from "node:assert/strict";
import { after, describe, it } from "node:test";
import { randomBytes, randomUUID } from "node:crypto";
import { Pool } from "pg";

import { createAuthenticationSecretCodec } from "../src/authentication-secrets.js";
import { startInstance, type RunningInstance } from "../src/instance.js";
import { NoteService } from "../src/notes.js";
import { OwnerBootstrapService } from "../src/owner-bootstrap.js";
import { PostgresDatabase } from "../src/postgres-database.js";
import { TaskService } from "../src/tasks.js";
import { WorkspaceProjectService } from "../src/workspaces-projects.js";

const databaseUrl = process.env.STASH_TEST_DATABASE_URL;

describe("PostgreSQL structured Task collaboration", { skip: !databaseUrl }, () => {
  let database: PostgresDatabase; let instance: RunningInstance;
  after(async () => { if (instance) await instance.close(); else await database?.close(); });

  it("persists merged fields, retry receipts, conflicts, attribution, and resolution through the running Instance", async () => {
    database = new PostgresDatabase(databaseUrl!, createAuthenticationSecretCodec(randomBytes(32).toString("base64")));
    const owner = await new OwnerBootstrapService(database).bootstrap({ organizationName: "Merge Test", ownerName: "Ada Lovelace",
      ownerEmail: `ada-${randomUUID()}@example.test`, password: "test-password-long-enough" }); assert.ok(owner);
    const workspaces = new WorkspaceProjectService(database);
    const workspace = await workspaces.createWorkspace(owner.ownerId, { name: "Portable", owner: { type: "personal" } }); assert.equal(workspace.status, "created");
    if (workspace.status !== "created") return;
    const project = await workspaces.createProject(owner.ownerId, workspace.workspace.id, { name: "Stash", key: "STASH" }); assert.equal(project.status, "created");
    if (project.status !== "created") return;
    const destination = await workspaces.createProject(owner.ownerId, workspace.workspace.id, { name: "Delivery", key: "SHIP" }); assert.equal(destination.status, "created");
    if (destination.status !== "created") return;
    const note = await new NoteService(database).capture(owner.ownerId, workspace.workspace.id, { content: "Plan release" }); assert.equal(note.status, "created");
    if (note.status !== "created") return;
    const tasks = new TaskService(database, database); const blockKey = note.note.document.blocks[0]!.blockKey!;
    const created = await tasks.createFromBlock(owner.ownerId, note.note.id, blockKey, { projectId: project.project.id, title: "Plan release" });
    assert.equal(created.status, "created"); if (created.status !== "created") return;
    const otherNote = await new NoteService(database).capture(owner.ownerId, workspace.workspace.id, { content: "Publish release" }); assert.equal(otherNote.status, "created");
    if (otherNote.status !== "created") return;
    const other = await tasks.createFromBlock(owner.ownerId, otherNote.note.id, otherNote.note.document.blocks[0]!.blockKey!, { projectId: project.project.id, title: "Publish release" });
    assert.equal(other.status, "created"); if (other.status !== "created") return;
    const createTask = async (title: string) => { const captured = await new NoteService(database).capture(owner.ownerId, workspace.workspace.id, { content: title });
      assert.equal(captured.status, "created"); if (captured.status !== "created") throw new Error("capture failed");
      const task = await tasks.createFromBlock(owner.ownerId, captured.note.id, captured.note.document.blocks[0]!.blockKey!, { projectId: project.project.id, title });
      assert.equal(task.status, "created"); if (task.status !== "created") throw new Error("task creation failed"); return task.task; };
    const differentTask = await createTask("Concurrent different fields"); const sameTask = await createTask("Concurrent same field");
    const retryTask = await createTask("Concurrent retry");
    const setup = new Pool({ connectionString: databaseUrl! });
    await setup.query(`CREATE OR REPLACE FUNCTION stash_test_delay_task_receipt() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN PERFORM pg_sleep(0.08); RETURN NEW; END $$;
      CREATE TRIGGER stash_test_delay_task_receipt BEFORE INSERT ON stash_task_edit_operations
      FOR EACH ROW EXECUTE FUNCTION stash_test_delay_task_receipt()`); await setup.end();
    instance = await startInstance({ database, host: "127.0.0.1", port: 0, instanceAdminToken: "admin", tasks,
      memberAccess: { async authenticateBearer(value) { return value === "Bearer test" ? { accountId: owner.ownerId, sessionId: "test" } : undefined; } } });
    const base = `${instance.url}/api/projects/${project.project.id}/tasks/${created.task.key}`;
    const taskBase = (key: string, selectedProjectId = project.project.id) => `${instance.url}/api/projects/${selectedProjectId}/tasks/${key}`;
    const concurrentEdit = (key: string, operationId: string, changes: unknown, revision = 1) => fetch(`${taskBase(key)}/edits`, { method: "POST",
      headers: { authorization: "Bearer test", "content-type": "application/json" }, body: JSON.stringify({ operationId, baseRevision: revision, changes }) });
    const different = await Promise.all([concurrentEdit(differentTask.key, randomUUID(), { title: "Changed concurrently" }),
      concurrentEdit(differentTask.key, randomUUID(), { priority: "high" })]); assert.deepEqual(different.map(({ status }) => status).sort(), [200, 200]);
    const differentRead = await (await fetch(taskBase(differentTask.key), { headers: { authorization: "Bearer test" } })).json() as any;
    assert.equal(differentRead.task.title, "Changed concurrently"); assert.equal(differentRead.task.priority, "high");
    const same = await Promise.all([concurrentEdit(sameTask.key, randomUUID(), { title: "Contribution A" }),
      concurrentEdit(sameTask.key, randomUUID(), { title: "Contribution B" })]); assert.deepEqual(same.map(({ status }) => status).sort(), [200, 409]);
    const sameConflict = await same.find(({ status }) => status === 409)!.json() as any; assert.equal(sameConflict.conflict.createdBy.displayName, "Ada Lovelace");
    const patchAndResolve = await Promise.all([fetch(taskBase(sameTask.key), { method: "PATCH", headers: { authorization: "Bearer test", "content-type": "application/json" },
      body: JSON.stringify({ priority: "low" }) }), fetch(`${taskBase(sameTask.key)}/conflicts/${sameConflict.conflict.id}`, { method: "PUT",
      headers: { authorization: "Bearer test", "content-type": "application/json" }, body: JSON.stringify({ resolution: "apply_contribution", expectedRevision: 2 }) })]);
    assert.equal(patchAndResolve[0].status, 200); assert.ok([200, 409].includes(patchAndResolve[1].status));
    const retryId = randomUUID(); const duplicate = await Promise.all([concurrentEdit(retryTask.key, retryId, { priority: "urgent" }),
      concurrentEdit(retryTask.key, retryId, { priority: "urgent" })]); assert.deepEqual(duplicate.map(({ status }) => status), [200, 200]);
    assert.deepEqual((await Promise.all(duplicate.map((response) => response.json() as Promise<any>))).map(({ revision }) => revision), [2, 2]);
    const patchAndEdit = await Promise.all([fetch(taskBase(retryTask.key), { method: "PATCH", headers: { authorization: "Bearer test", "content-type": "application/json" },
      body: JSON.stringify({ labelNames: ["parallel"] }) }), concurrentEdit(retryTask.key, randomUUID(), { title: "Parallel PATCH" }, 1)]);
    assert.deepEqual(patchAndEdit.map(({ status }) => status), [200, 200]);
    const overlapped = await (await fetch(taskBase(retryTask.key), { headers: { authorization: "Bearer test" } })).json() as any;
    assert.equal(overlapped.task.title, "Parallel PATCH"); assert.deepEqual(overlapped.task.labelNames, ["parallel"]);
    const graphAndMove = await Promise.all([fetch(taskBase(differentTask.key), { method: "PATCH", headers: { authorization: "Bearer test", "content-type": "application/json" },
      body: JSON.stringify({ dependencies: [{ taskId: sameTask.id, type: "depends_on" }] }) }),
    fetch(`${taskBase(sameTask.key)}/move`, { method: "POST", headers: { authorization: "Bearer test", "content-type": "application/json" },
      body: JSON.stringify({ destinationProjectId: destination.project.id }) })]);
    assert.deepEqual(graphAndMove.map(({ status }) => status), [200, 200]);
    const edit = (operationId: string, changes: unknown) => fetch(`${base}/edits`, { method: "POST", headers: { authorization: "Bearer test", "content-type": "application/json" },
      body: JSON.stringify({ operationId, baseRevision: 1, changes }) });
    const firstId = randomUUID(); const secondId = randomUUID();
    assert.equal((await edit(firstId, { title: "Published" })).status, 200);
    const merged = await edit(secondId, { priority: "urgent" }); assert.equal(merged.status, 200);
    const retry = await edit(secondId, { priority: "urgent" }); assert.equal(retry.status, 200); assert.equal((await retry.json() as any).revision, 3);
    const patched = await fetch(base, { method: "PATCH", headers: { authorization: "Bearer test", "content-type": "application/json" }, body: JSON.stringify({ priority: "low" }) });
    assert.equal(patched.status, 200);
    const collision = await fetch(`${base}/edits`, { method: "POST", headers: { authorization: "Bearer test", "content-type": "application/json" },
      body: JSON.stringify({ operationId: randomUUID(), baseRevision: 3, changes: { priority: "high" } }) }); assert.equal(collision.status, 409);
    const conflict = (await collision.json() as any).conflict; assert.equal(conflict.createdBy.displayName, "Ada Lovelace"); assert.equal(conflict.createdBy.localAccountId, undefined);
    assert.equal(conflict.currentRevision, 4);
    const probe = new Pool({ connectionString: databaseUrl! }); await probe.query("UPDATE stash_accounts SET name='Ada Changed' WHERE id=$1", [owner.ownerId]); await probe.end();
    const listed = await fetch(`${base}/conflicts`, { headers: { authorization: "Bearer test" } });
    assert.equal(((await listed.json() as any).conflicts[0]).createdBy.displayName, "Ada Lovelace");
    assert.equal((await fetch(base, { method: "PATCH", headers: { authorization: "Bearer test", "content-type": "application/json" }, body: JSON.stringify({ labelNames: ["release"] }) })).status, 200);
    const staleResolution = await fetch(`${base}/conflicts/${conflict.id}`, { method: "PUT", headers: { authorization: "Bearer test", "content-type": "application/json" },
      body: JSON.stringify({ resolution: "apply_contribution", expectedRevision: 4 }) }); assert.equal(staleResolution.status, 409);
    const resolution = await fetch(`${base}/conflicts/${conflict.id}`, { method: "PUT", headers: { authorization: "Bearer test", "content-type": "application/json" },
      body: JSON.stringify({ resolution: "apply_contribution", expectedRevision: 5 }) });
    assert.equal(resolution.status, 200); const resolved = await resolution.json() as any;
    assert.equal(resolved.task.title, "Published"); assert.equal(resolved.task.priority, "high"); assert.deepEqual(resolved.task.labelNames, ["release"]); assert.equal(resolved.activity.actor.displayName, "Ada Changed");
    assert.equal((await fetch(base, { method: "PATCH", headers: { authorization: "Bearer test", "content-type": "application/json" },
      body: JSON.stringify({ dependencies: [{ taskId: other.task.id, type: "depends_on" }] }) })).status, 200);
    const inverse = await fetch(`${instance.url}/api/projects/${project.project.id}/tasks/${other.task.key}/edits`, { method: "POST",
      headers: { authorization: "Bearer test", "content-type": "application/json" },
      body: JSON.stringify({ operationId: randomUUID(), baseRevision: 1, changes: { dependencies: [] } }) });
    assert.equal(inverse.status, 409); assert.deepEqual((await inverse.json() as any).conflict.fields, ["dependencies"]);
    const moved = await fetch(`${base}/move`, { method: "POST", headers: { authorization: "Bearer test", "content-type": "application/json" },
      body: JSON.stringify({ destinationProjectId: destination.project.id }) }); assert.equal(moved.status, 200); const movedTask = (await moved.json() as any).task;
    const staleStatus = await fetch(`${instance.url}/api/projects/${destination.project.id}/tasks/${movedTask.key}/edits`, { method: "POST",
      headers: { authorization: "Bearer test", "content-type": "application/json" },
      body: JSON.stringify({ operationId: randomUUID(), baseRevision: 7, changes: { statusId: created.task.status.id } }) });
    assert.equal(staleStatus.status, 409); assert.deepEqual((await staleStatus.json() as any).conflict.fields, ["statusId"]);
  });
});
