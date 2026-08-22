import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";

import { startInstance, type DatabaseProbe, type RunningInstance } from "../src/instance.js";
import { TaskService, taskEditDigest, type StructuredTaskEditRepository, type TaskEditBatch, type TaskEditConflict, type TaskPlanningReadModel } from "../src/tasks.js";
import type { MemberAccessResolver } from "../src/workspaces-projects.js";

const projectId = "22222222-2222-4222-8222-222222222222";
const operationA = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const operationB = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

class StructuredTaskFake implements DatabaseProbe, StructuredTaskEditRepository {
  task: TaskPlanningReadModel = { schema: "stash.task.v1", id: "33333333-3333-4333-8333-333333333333", workspaceId: "88888888-8888-4888-8888-888888888888",
    projectId, key: "STASH-12", title: "Plan release", status: { id: "44444444-4444-4444-8444-444444444444", name: "Backlog", category: "unstarted" },
    assigneeIds: [], priority: "none", labelNames: [], linkedNoteIds: [], dependencies: [], developmentLinks: [], sourceNoteIds: [],
    createdAt: "2026-08-22T08:00:00.000Z", createdBy: { localAccountId: "ada", displayName: "Ada Lovelace" }, dependencyWarnings: [] };
  revision = 1; fieldRevisions = new Map<string, number>(); receipts = new Map<string, { digest: string; outcome: any }>(); conflicts = new Map<string, TaskEditConflict>(); fail = false;
  async verifyConnection() {} async close() {}
  async applyStructuredTaskEdit(memberId: string, requestedProjectId: string, key: string, batch: TaskEditBatch) {
    if (this.fail) throw new Error("postgres://secret");
    if (memberId !== "ada" || requestedProjectId !== projectId || key !== "STASH-12") return { status: "not_found" as const };
    if (batch.baseRevision > this.revision) return { status: "invalid_revision" as const };
    const digest = taskEditDigest(batch); const receipt = this.receipts.get(batch.operationId);
    if (receipt) return receipt.digest === digest ? receipt.outcome : { status: "operation_identity_conflict" as const };
    const fields = Object.keys(batch.changes); const incompatible = fields.filter((field) => (this.fieldRevisions.get(field) ?? 0) > batch.baseRevision);
    if (incompatible.length) {
      const compatible = fields.filter((field) => !incompatible.includes(field));
      if (compatible.length) { this.revision++; for (const field of compatible) {
        Object.assign(this.task, { [field]: (batch.changes as Record<string, unknown>)[field] }); this.fieldRevisions.set(field, this.revision);
      } }
      const conflict: TaskEditConflict = { id: "99999999-9999-4999-8999-999999999999", taskId: this.task.id, baseRevision: batch.baseRevision,
        currentRevision: this.revision, fields: incompatible,
        contribution: Object.fromEntries(incompatible.map((field) => [field, (batch.changes as Record<string, unknown>)[field]])) as any,
        createdAt: "2026-08-23T09:00:00.000Z",
        createdBy: { displayName: memberId === "ada" ? "Ada Lovelace" : "Grace Hopper", attribution: "recorded" } };
      this.conflicts.set(conflict.id, conflict); const outcome = { status: "conflict_preserved" as const, conflict };
      this.receipts.set(batch.operationId, { digest, outcome }); return outcome;
    }
    this.revision++; Object.assign(this.task, batch.changes); for (const field of fields) this.fieldRevisions.set(field, this.revision);
    const outcome = { status: "applied" as const, task: structuredClone(this.task), revision: this.revision, appliedFields: fields };
    this.receipts.set(batch.operationId, { digest, outcome }); return outcome;
  }
  async listStructuredTaskConflicts(memberId: string, requestedProjectId: string, key: string) {
    return memberId === "ada" && requestedProjectId === projectId && key === "STASH-12"
      ? { status: "found" as const, revision: this.revision, conflicts: [...this.conflicts.values()].filter(({ resolvedAt }) => !resolvedAt) }
      : { status: "not_found" as const };
  }
  async resolveStructuredTaskConflict(memberId: string, requestedProjectId: string, key: string, conflictId: string, resolution: "keep_current" | "apply_contribution", expectedRevision: number) {
    if (memberId !== "ada" || requestedProjectId !== projectId || key !== "STASH-12") return { status: "not_found" as const };
    const conflict = this.conflicts.get(conflictId); if (!conflict) return { status: "conflict_not_found" as const };
    if (conflict.resolvedAt) return { status: "already_resolved" as const };
    if (expectedRevision !== this.revision) return { status: "conflict_changed" as const, conflict: { ...conflict, currentRevision: this.revision } };
    if (resolution === "apply_contribution") { this.revision++; Object.assign(this.task, conflict.contribution); }
    conflict.resolvedAt = "2026-08-23T09:05:00.000Z"; conflict.resolution = resolution;
    return { status: "resolved" as const, task: structuredClone(this.task), revision: this.revision,
      activity: { actor: { displayName: "Ada Lovelace" }, cause: { kind: "member" }, before: { conflictId }, after: { resolution } } };
  }
}

const access: MemberAccessResolver = { async authenticateBearer(value) { return value === "Bearer member-ada" ? { accountId: "ada", sessionId: "session" } : undefined; } };

describe("field-level Task collaboration", () => {
  let instance: RunningInstance | undefined; afterEach(async () => instance?.close());
  async function run() { const database = new StructuredTaskFake(); instance = await startInstance({ database, host: "127.0.0.1", port: 0, instanceAdminToken: "admin",
    tasks: new TaskService(database, { async findPortableMemberIdentity(memberId) { return { localAccountId: memberId, displayName: memberId === "ada" ? "Ada Lovelace" : "Grace Hopper" }; } }), memberAccess: access });
    const base = `${instance.url}/api/projects/${projectId}/tasks/STASH-12`;
    const edit = (body: unknown, token = "member-ada") => fetch(`${base}/edits`, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify(body) });
    return { database, base, edit }; }

  it("merges stale edits to independent fields and returns the same outcome for a retry", async () => {
    const { database, edit } = await run();
    assert.equal((await edit({ operationId: operationA, baseRevision: 1, changes: { title: "Ship release" } })).status, 200);
    const second = await edit({ operationId: operationB, baseRevision: 1, changes: { priority: "high" } });
    assert.equal(second.status, 200); assert.equal(database.task.title, "Ship release"); assert.equal(database.task.priority, "high");
    const retry = await edit({ operationId: operationB, baseRevision: 1, changes: { priority: "high" } });
    assert.equal(retry.status, 200); assert.equal((await retry.json() as { revision: number }).revision, 3);
  });

  it("preserves an incompatible same-field contribution and resolves it explicitly", async () => {
    const { base, edit } = await run();
    await edit({ operationId: operationA, baseRevision: 1, changes: { title: "Published title" } });
    const collision = await edit({ operationId: operationB, baseRevision: 1, changes: { title: "Preserved title", priority: "urgent" } });
    assert.equal(collision.status, 409); const conflict = (await collision.json() as { conflict: TaskEditConflict }).conflict;
    assert.deepEqual(conflict.fields, ["title"]); assert.deepEqual(conflict.contribution, { title: "Preserved title" }); assert.equal((conflict.createdBy as any).localAccountId, undefined);
    assert.equal((await (await fetch(`${base}/conflicts`, { headers: { authorization: "Bearer member-ada" } })).json() as any).revision, 3);
    const listed = await fetch(`${base}/conflicts`, { headers: { authorization: "Bearer member-ada" } }); assert.equal(listed.status, 200);
    const resolved = await fetch(`${base}/conflicts/${conflict.id}`, { method: "PUT", headers: { authorization: "Bearer member-ada", "content-type": "application/json" },
      body: JSON.stringify({ resolution: "apply_contribution", expectedRevision: 3 }) });
    assert.equal(resolved.status, 200); const body = await resolved.json() as any; assert.equal(body.task.title, "Preserved title"); assert.equal(body.task.priority, "urgent"); assert.equal(body.activity.actor.displayName, "Ada Lovelace");
  });

  it("rejects reused identities, invalid input and unauthorized writes, and surfaces recoverable failures", async () => {
    const { database, edit } = await run(); await edit({ operationId: operationA, baseRevision: 1, changes: { priority: "low" } });
    assert.equal((await edit({ operationId: operationA, baseRevision: 1, changes: { priority: "high" } })).status, 409);
    assert.equal((await edit({ operationId: operationB, baseRevision: 0, changes: { priority: "high" } })).status, 422);
    assert.equal((await edit({ operationId: operationB, baseRevision: Number.MAX_SAFE_INTEGER, changes: { priority: "high" } })).status, 409);
    assert.equal((await edit({ operationId: operationB, baseRevision: 1, changes: { unknown: true } })).status, 422);
    assert.equal((await edit({ operationId: operationB, baseRevision: 1, changes: { priority: "high" } }, "unknown")).status, 401);
    database.fail = true; const failed = await edit({ operationId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc", baseRevision: 1, changes: { title: "Retry me" } });
    assert.equal(failed.status, 503); assert.doesNotMatch(await failed.text(), /postgres|secret/i);
  });
});
