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
const inProgressStatusId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const assigneeId = "55555555-5555-4555-8555-555555555555";
const linkedNoteId = "66666666-6666-4666-8666-666666666666";
const dependencyTaskId = "99999999-9999-4999-8999-999999999999";
const thirdTaskId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";

class TaskPlanningFake implements DatabaseProbe, TaskPlanningRepository {
  task: PortableTaskProjection = {
    schema: "stash.task.v1", id: taskId, workspaceId: "88888888-8888-4888-8888-888888888888", projectId,
    key: "STASH-12", title: "Plan release", status: { id: statusId, name: "Backlog", category: "unstarted" },
    assigneeIds: [], priority: "none", labelNames: [], sourceNoteIds: [], linkedNoteIds: [], dependencies: [], developmentLinks: [],
    createdAt: "2026-08-22T08:00:00.000Z", createdBy: { localAccountId: "ada", displayName: "Ada Lovelace" },
  };
  readonly otherTasks: PortableTaskProjection[] = [
    { ...structuredClone(this.task), id: dependencyTaskId, key: "STASH-13", title: "Publish release" },
    { ...structuredClone(this.task), id: thirdTaskId, key: "STASH-14", title: "Announce release" },
  ];
  canRead = true;
  fail = false;
  async verifyConnection() {}
  async close() {}
  async findTaskByKey(memberId: string, requestedProjectId: string, key: string) {
    const task = [this.task, ...this.otherTasks].find((candidate) => candidate.key === key.toUpperCase());
    if (!this.canRead || !["ada", "grace"].includes(memberId) || requestedProjectId !== projectId || !task)
      return { status: "not_found" as const };
    return { status: "found" as const, task: structuredClone(task) };
  }
  async updateTaskByKey(memberId: string, requestedProjectId: string, key: string, update: TaskPlanningUpdate) {
    if (this.fail) throw new Error("postgres://secret");
    if (memberId !== "ada") return { status: "not_found" as const };
    const found = await this.findTaskByKey(memberId, requestedProjectId, key);
    if (found.status === "not_found") return found;
    if (update.statusId !== undefined && update.statusId !== inProgressStatusId
      || update.assigneeIds?.some((id) => id !== assigneeId)
      || update.linkedNoteIds?.some((id) => id !== linkedNoteId)
      || update.dependencies?.some(({ taskId: id }) => ![this.task, ...this.otherTasks].some((task) => task.id === id) || id === found.task.id))
      return { status: "invalid_reference" as const };
    const { statusId: nextStatusId, dueDate, estimate, ...properties } = update;
    const next = { ...found.task, ...properties,
      ...(nextStatusId ? { status: { id: nextStatusId, name: "In Progress", category: "started" as const } } : {}),
      ...(dueDate ? { dueDate } : {}), ...(estimate === null || estimate === undefined ? {} : { estimate }) };
    if (update.dependencies !== undefined) {
      const graph = new Map([this.task, ...this.otherTasks].map((task) => [task.id, task.id === next.id ? update.dependencies! : task.dependencies ?? []]));
      if (fakeHasCycle(graph)) return { status: "invalid_reference" as const };
    }
    if (update.dueDate === null) delete next.dueDate;
    if (update.estimate === null) delete next.estimate;
    if (next.id === this.task.id) this.task = next;
    else this.otherTasks.splice(this.otherTasks.findIndex(({ id }) => id === next.id), 1, next);
    return { status: "updated" as const, task: structuredClone(next) };
  }
}

function fakeHasCycle(graph: ReadonlyMap<string, NonNullable<PortableTaskProjection["dependencies"]>>): boolean {
  const outgoing = new Map<string, string[]>([...graph.keys()].map((id) => [id, []]));
  for (const [id, dependencies] of graph) for (const dependency of dependencies) {
    const source = dependency.type === "depends_on" ? id : dependency.taskId;
    const target = dependency.type === "depends_on" ? dependency.taskId : id;
    outgoing.get(source)!.push(target);
  }
  const active = new Set<string>(); const done = new Set<string>();
  const visit = (id: string): boolean => {
    if (active.has(id)) return true; if (done.has(id)) return false;
    active.add(id); for (const target of outgoing.get(id) ?? []) if (visit(target)) return true;
    active.delete(id); done.add(id); return false;
  };
  return [...outgoing.keys()].some(visit);
}

const access: MemberAccessResolver = { async authenticateBearer(value) {
  if (value === "Bearer member-ada") return { accountId: "ada", sessionId: "session" };
  if (value === "Bearer guest-grace") return { accountId: "grace", sessionId: "guest-session" };
  return undefined;
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
    assert.equal((await get(projectId, "STASH-12", "guest-grace")).status, 200);
    assert.equal((await get(otherProjectId)).status, 404);
    assert.equal((await get(projectId, "STASH-12", "unknown")).status, 401);
  });

  it("updates all core planning properties without changing the Task identity or key", async () => {
    const { database, patch } = await run();
    const response = await patch({ title: "Ship release", statusId: inProgressStatusId, assigneeIds: [assigneeId], priority: "high",
      labelNames: ["release", "backend"], dueDate: "2026-09-01", estimate: 5,
      linkedNoteIds: [linkedNoteId],
      dependencies: [{ taskId: dependencyTaskId, type: "depends_on" }],
      developmentLinks: [{ provider: "github", url: "https://github.com/acme/stash/pull/42", kind: "pull_request" }] });
    assert.equal(response.status, 200);
    const body = await response.json() as { task: PortableTaskProjection };
    assert.equal(body.task.id, taskId);
    assert.equal(body.task.key, "STASH-12");
    assert.equal(body.task.title, "Ship release");
    assert.deepEqual(body.task.status, { id: inProgressStatusId, name: "In Progress", category: "started" });
    assert.deepEqual(body.task.assigneeIds, [assigneeId]);
    assert.equal(body.task.priority, "high");
    assert.deepEqual(body.task.labelNames, ["release", "backend"]);
    assert.equal(body.task.dueDate, "2026-09-01");
    assert.equal(body.task.estimate, 5);
    assert.deepEqual(body.task.linkedNoteIds, [linkedNoteId]);
    assert.deepEqual(body.task.dependencies, [{ taskId: dependencyTaskId, type: "depends_on" }]);
    assert.deepEqual(body.task.developmentLinks, [{ provider: "github", url: "https://github.com/acme/stash/pull/42", kind: "pull_request" }]);
    assert.equal("statusId" in body.task, false);
    assert.equal(database.task.key, "STASH-12");
  });

  it("rejects unavailable planning references atomically", async () => {
    const { database, patch } = await run();
    const unavailable = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    for (const body of [{ title: "Partial status", statusId }, { title: "Partial assignee", assigneeIds: [unavailable] },
      { title: "Partial Note", linkedNoteIds: [unavailable] },
      { title: "Partial dependency", dependencies: [{ taskId: unavailable, type: "depends_on" }] }]) {
      const before = structuredClone(database.task);
      const response = await patch(body);
      assert.equal(response.status, 422);
      assert.deepEqual(database.task, before);
    }
  });

  it("rejects a two-Task Dependency cycle without applying the rest of the update", async () => {
    const { database, patch } = await run();
    assert.equal((await patch({ dependencies: [{ taskId: dependencyTaskId, type: "depends_on" }] })).status, 200);
    const before = structuredClone(database.otherTasks[0]);
    const response = await patch({ title: "Must not persist", dependencies: [{ taskId, type: "depends_on" }] }, projectId, "STASH-13");
    assert.equal(response.status, 422);
    assert.deepEqual(database.otherTasks[0], before);
    assert.equal(database.task.title, "Plan release");
  });

  it("rejects a longer cycle that mixes Depends on and Required by semantics", async () => {
    const { database, patch } = await run();
    assert.equal((await patch({ dependencies: [{ taskId: dependencyTaskId, type: "depends_on" }] })).status, 200);
    const before = structuredClone(database.otherTasks[1]);
    const response = await patch({ title: "Must not persist", dependencies: [
      { taskId: dependencyTaskId, type: "required_by" },
      { taskId, type: "depends_on" },
    ] }, projectId, "STASH-14");
    assert.equal(response.status, 422);
    assert.deepEqual(database.otherTasks[1], before);
  });

  it("allows selected Project Guests to read but not mutate a Task", async () => {
    const { database, get, patch } = await run();
    assert.equal((await get(projectId, "STASH-12", "guest-grace")).status, 200);
    const before = structuredClone(database.task);
    assert.equal((await patch({ priority: "high" }, projectId, "STASH-12", "guest-grace")).status, 404);
    assert.deepEqual(database.task, before);
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
