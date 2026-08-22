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
    instance = await startInstance({ database, host: "127.0.0.1", port: 0, instanceAdminToken: "admin", tasks,
      memberAccess: { async authenticateBearer(value) { return value === "Bearer test" ? { accountId: owner.ownerId, sessionId: "test" } : undefined; } } });
    const base = `${instance.url}/api/projects/${project.project.id}/tasks/${created.task.key}`;
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
