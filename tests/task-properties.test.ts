import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";

import { startInstance, type DatabaseProbe, type RunningInstance } from "../src/instance.js";
import { TaskService, type TaskPlanningRepository, type TaskPlanningUpdate } from "../src/tasks.js";
import type { PortableTaskProjection } from "../src/notes.js";
import type { MemberAccessResolver } from "../src/workspaces-projects.js";

const projectId = "22222222-2222-4222-8222-222222222222";
const otherProjectId = "77777777-7777-4777-8777-777777777777";
const taskId = "33333333-3333-4333-8333-333333333333";
const statusId = "44444444-4444-4444-8444-444444444444";
const assigneeId = "55555555-5555-4555-8555-555555555555";

class TaskPlanningFake implements DatabaseProbe, TaskPlanningRepository {
  task: PortableTaskProjection = {
    schema: "stash.task.v1", id: taskId, workspaceId: "88888888-8888-4888-8888-888888888888", projectId,
    key: "STASH-12", title: "Plan release", status: { id: statusId, name: "Backlog", category: "unstarted" },
    assigneeIds: [], priority: "none", labelNames: [], sourceNoteIds: [], linkedNoteIds: [], dependencies: [], developmentLinks: [],
    createdAt: "2026-08-22T08:00:00.000Z", createdBy: { localAccountId: "ada", displayName: "Ada Lovelace" },
  };
  canRead = true;
  fail = false;
  async verifyConnection() {}
  async close() {}
  async findTaskByKey(memberId: string, requestedProjectId: string, key: string) {
    if (!this.canRead || memberId !== "ada" || requestedProjectId !== projectId || key.toUpperCase() !== this.task.key)
      return { status: "not_found" as const };
    return { status: "found" as const, task: structuredClone(this.task) };
  }
  async updateTaskByKey(memberId: string, requestedProjectId: string, key: string, update: TaskPlanningUpdate) {
    if (this.fail) throw new Error("postgres://secret");
    const found = await this.findTaskByKey(memberId, requestedProjectId, key);
    if (found.status === "not_found") return found;
    this.task = { ...this.task, ...update } as PortableTaskProjection;
    if (update.dueDate === null) delete this.task.dueDate;
    if (update.estimate === null) delete this.task.estimate;
    return { status: "updated" as const, task: structuredClone(this.task) };
  }
}

const access: MemberAccessResolver = { async authenticateBearer(value) {
  return value === "Bearer member-ada" ? { accountId: "ada", sessionId: "session" } : undefined;
} };

describe("planning Tasks through Project-scoped Task Keys", () => {
  let instance: RunningInstance | undefined;
  afterEach(async () => instance?.close());

  async function run() {
    const database = new TaskPlanningFake();
    instance = await startInstance({ database, host: "127.0.0.1", port: 0, instanceAdminToken: "admin",
      tasks: new TaskService(database, { async findPortableMemberIdentity() { return undefined; } }), memberAccess: access });
    const taskUrl = (project = projectId, key = "STASH-12") => `${instance!.url}/api/projects/${project}/tasks/${key}`;
    return { database, get: (project?: string, key?: string, token = "member-ada") => fetch(taskUrl(project, key), { headers: { authorization: `Bearer ${token}` } }),
      patch: (body: unknown, project?: string, key?: string, token = "member-ada") => fetch(taskUrl(project, key), { method: "PATCH",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify(body) }) };
  }

  it("reads a Task by its case-insensitive Project-scoped Task Key", async () => {
    const { get } = await run();
    const response = await get(projectId, "stash-12");
    assert.equal(response.status, 200);
    const body = await response.json() as { task: PortableTaskProjection };
    assert.equal(body.task.id, taskId);
    assert.equal(body.task.key, "STASH-12");
    assert.equal((await get(otherProjectId)).status, 404);
    assert.equal((await get(projectId, "STASH-12", "unknown")).status, 401);
  });

  it("updates all core planning properties without changing the Task identity or key", async () => {
    const { database, patch } = await run();
    const response = await patch({ title: "Ship release", statusId, assigneeIds: [assigneeId], priority: "high",
      labelNames: ["release", "backend"], dueDate: "2026-09-01", estimate: 5,
      linkedNoteIds: ["66666666-6666-4666-8666-666666666666"],
      dependencies: [{ taskId: "99999999-9999-4999-8999-999999999999", type: "depends_on" }],
      developmentLinks: [{ provider: "github", url: "https://github.com/acme/stash/pull/42", kind: "pull_request" }] });
    assert.equal(response.status, 200);
    const body = await response.json() as { task: PortableTaskProjection };
    assert.equal(body.task.id, taskId);
    assert.equal(body.task.key, "STASH-12");
    assert.equal(body.task.title, "Ship release");
    assert.deepEqual(body.task.assigneeIds, [assigneeId]);
    assert.equal(body.task.priority, "high");
    assert.deepEqual(body.task.labelNames, ["release", "backend"]);
    assert.equal(body.task.dueDate, "2026-09-01");
    assert.equal(body.task.estimate, 5);
    assert.equal(database.task.key, "STASH-12");
  });

  it("supports clearing optional properties and rejects invalid or unknown input atomically", async () => {
    const { database, patch } = await run();
    database.task.dueDate = "2026-09-01"; database.task.estimate = 3;
    assert.equal((await patch({ dueDate: null, estimate: null, assigneeIds: [], labelNames: [] })).status, 200);
    assert.equal(database.task.dueDate, undefined);
    assert.equal(database.task.estimate, undefined);
    const before = structuredClone(database.task);
    for (const body of [{ priority: "critical" }, { statusId: "bad" }, { estimate: -1 }, { dueDate: "09/01/2026" }, { dueDate: "2026-02-31" },
      { labelNames: ["ok", ""] }, { developmentLinks: [{ provider: "github", url: "javascript:alert(1)", kind: "pull_request" }] }, { unknown: true }])
      assert.equal((await patch(body)).status, 422);
    assert.deepEqual(database.task, before);
  });

  it("hides inaccessible Tasks and surfaces recoverable persistence failures without leaking details", async () => {
    const { database, get, patch } = await run();
    database.canRead = false;
    assert.equal((await get()).status, 404);
    assert.equal((await patch({ priority: "low" })).status, 404);
    database.canRead = true; database.fail = true;
    const failed = await patch({ priority: "low" });
    assert.equal(failed.status, 503);
    assert.doesNotMatch(await failed.text(), /postgres|secret/i);
  });
});
