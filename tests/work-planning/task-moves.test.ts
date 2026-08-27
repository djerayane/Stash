import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";

import { startInstance, type DatabaseProbe, type RunningInstance } from "../support/start-test-instance.js";
import type { PortableTaskProjection } from "../../src/notes.js";
import { TaskService, type TaskMoveActivity, type TaskMoveRepository, type TaskPlanningReadModel } from "../../src/tasks.js";
import type { MemberAccessResolver } from "../../src/workspaces-projects.js";

const sourceProjectId = "22222222-2222-4222-8222-222222222222";
const destinationProjectId = "77777777-7777-4777-8777-777777777777";
const forbiddenProjectId = "99999999-9999-4999-8999-999999999999";

class TaskMoveFake implements DatabaseProbe, TaskMoveRepository {
  task: TaskPlanningReadModel = { revision: 1,
    schema: "stash.task.v1", id: "33333333-3333-4333-8333-333333333333",
    workspaceId: "88888888-8888-4888-8888-888888888888", projectId: sourceProjectId,
    key: "SOURCE-4", keyAliases: [], title: "Move release work",
    status: { id: "44444444-4444-4444-8444-444444444444", name: "In Progress", category: "started" },
    sourceNoteIds: [], assigneeIds: [], priority: "none", labelNames: [], linkedNoteIds: [], dependencies: [], developmentLinks: [],
    createdAt: "2026-08-22T08:00:00.000Z", createdBy: { localAccountId: "ada", displayName: "Ada Lovelace" }, dependencyWarnings: [],
  };
  readonly nextNumbers = new Map([[sourceProjectId, 5], [destinationProjectId, 9]]);
  readonly projectKeys = new Map([[sourceProjectId, "SOURCE"], [destinationProjectId, "DEST"]]);
  activities: TaskMoveActivity[] = [];
  fail = false;
  private moveQueue: Promise<void> = Promise.resolve();
  async verifyConnection() {}
  async close() {}
  async findTaskByKey(memberId: string, projectId: string, taskKey: string) {
    const resolves = (this.task.projectId === projectId && this.task.key === taskKey)
      || this.task.keyAliases?.some((alias) => alias.projectId === projectId && alias.key === taskKey);
    return memberId === "ada" && resolves ? { status: "found" as const, task: structuredClone(this.task) }
      : { status: "not_found" as const };
  }
  async moveTask(memberId: string, projectId: string, taskKey: string, nextProjectId: string) {
    const previous = this.moveQueue;
    let release!: () => void;
    this.moveQueue = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    try {
      if (this.fail) throw new Error("postgres://secret");
      const found = await this.findTaskByKey(memberId, projectId, taskKey);
      if (found.status === "not_found") return found;
      if (nextProjectId === forbiddenProjectId || memberId !== "ada") return { status: "destination_forbidden" as const };
      if (nextProjectId === this.task.projectId) return { status: "same_project" as const };
      const before = { projectId: this.task.projectId, key: this.task.key, status: structuredClone(this.task.status) };
      const number = this.nextNumbers.get(nextProjectId)!;
      this.nextNumbers.set(nextProjectId, number + 1);
      this.task = { ...this.task, projectId: nextProjectId, key: `${this.projectKeys.get(nextProjectId)}-${number}`,
        keyAliases: [...(this.task.keyAliases ?? []), { projectId: before.projectId, key: before.key }],
        status: { id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", name: "Backlog", category: "unstarted" } };
      const activity: TaskMoveActivity = { schema: "stash.activity.v1", id: `activity-${this.activities.length + 1}`,
        workspaceId: this.task.workspaceId, action: "task_moved", object: { kind: "Task", id: this.task.id },
        actor: { localAccountId: memberId, displayName: "Ada Lovelace" }, cause: { kind: "member" },
        occurredAt: "2026-08-23T00:00:00.000Z", before,
        after: { projectId: this.task.projectId, key: this.task.key, status: structuredClone(this.task.status) } };
      this.activities.push(activity);
      return { status: "moved" as const, task: structuredClone(this.task), activity: structuredClone(activity) };
    } finally { release(); }
  }
}

const access: MemberAccessResolver = { async authenticateBearer(value) {
  return value === "Bearer member-ada" ? { accountId: "ada", sessionId: "session" } : undefined;
} };

describe("moving Tasks while preserving Task Key aliases", () => {
  let instance: RunningInstance | undefined;
  afterEach(async () => instance?.close());

  async function run() {
    const database = new TaskMoveFake();
    instance = await startInstance({ database, host: "127.0.0.1", port: 0, instanceAdminToken: "admin", memberAccess: access,
      tasks: new TaskService(database, { async findPortableMemberIdentity() { return undefined; } }) });
    const taskUrl = (projectId: string, key: string) => `${instance!.url}/api/projects/${projectId}/tasks/${key}`;
    const move = (fromProject = sourceProjectId, key = "SOURCE-4", destinationProject = destinationProjectId, token = "member-ada") =>
      fetch(`${taskUrl(fromProject, key)}/move`, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify({ destinationProjectId: destinationProject }) });
    const get = (projectId: string, key: string) => fetch(taskUrl(projectId, key), { headers: { authorization: "Bearer member-ada" } });
    return { database, move, get };
  }

  it("assigns a destination key and keeps every former Project key resolving permanently", async () => {
    const { database, move, get } = await run();
    const first = await move();
    assert.equal(first.status, 200);
    const firstBody = await first.json() as { task: PortableTaskProjection; activity: TaskMoveActivity };
    const firstTask = firstBody.task;
    assert.equal(firstTask.id, "33333333-3333-4333-8333-333333333333");
    assert.equal(firstTask.projectId, destinationProjectId);
    assert.equal(firstTask.key, "DEST-9");
    assert.deepEqual(firstTask.keyAliases, [{ projectId: sourceProjectId, key: "SOURCE-4" }]);
    assert.deepEqual(firstBody.activity.before, { projectId: sourceProjectId, key: "SOURCE-4",
      status: { id: "44444444-4444-4444-8444-444444444444", name: "In Progress", category: "started" } });
    assert.deepEqual(firstBody.activity.after, { projectId: destinationProjectId, key: "DEST-9",
      status: { id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", name: "Backlog", category: "unstarted" } });
    assert.deepEqual(firstBody.activity.actor, { localAccountId: "ada", displayName: "Ada Lovelace" });
    assert.equal((await get(sourceProjectId, "SOURCE-4")).status, 200);

    const second = await move(destinationProjectId, "DEST-9", sourceProjectId);
    assert.equal(second.status, 200);
    const secondTask = (await second.json() as { task: PortableTaskProjection }).task;
    assert.equal(secondTask.key, "SOURCE-5");
    assert.deepEqual(secondTask.keyAliases, [
      { projectId: sourceProjectId, key: "SOURCE-4" }, { projectId: destinationProjectId, key: "DEST-9" },
    ]);
    assert.equal((await get(sourceProjectId, "SOURCE-4")).status, 200);
    assert.equal((await get(destinationProjectId, "DEST-9")).status, 200);
    assert.equal(database.activities.length, 2);
  });

  it("does not mutate when the destination is forbidden or the move is invalid", async () => {
    const { database, move } = await run();
    const before = structuredClone(database.task);
    assert.equal((await move(sourceProjectId, "SOURCE-4", forbiddenProjectId)).status, 403);
    assert.deepEqual(database.task, before);
    assert.equal(database.activities.length, 0);
    assert.equal((await move(sourceProjectId, "SOURCE-4", sourceProjectId)).status, 409);
    assert.deepEqual(database.task, before);
    assert.equal((await move(sourceProjectId, "SOURCE-4", "not-a-uuid")).status, 422);
    assert.deepEqual(database.task, before);
    assert.equal((await move(sourceProjectId, "SOURCE-4", destinationProjectId, "missing")).status, 401);
  });

  it("hides unavailable source Tasks and surfaces retryable failures without leaking details", async () => {
    const { database, move } = await run();
    assert.equal((await move(sourceProjectId, "MISSING-1")).status, 404);
    database.fail = true;
    const failed = await move();
    assert.equal(failed.status, 503);
    assert.doesNotMatch(await failed.text(), /postgres|secret/i);
    assert.equal(database.activities.length, 0);
  });

  it("serializes concurrent moves so one source key cannot move the Task twice", async () => {
    const { database, move } = await run();
    const responses = await Promise.all([move(), move()]);
    assert.deepEqual(responses.map(({ status }) => status).sort(), [200, 409]);
    assert.equal(database.task.key, "DEST-9");
    assert.deepEqual(database.task.keyAliases, [{ projectId: sourceProjectId, key: "SOURCE-4" }]);
    assert.equal(database.activities.length, 1);
  });
});
