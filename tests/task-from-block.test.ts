import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";

import { startInstance, type DatabaseProbe, type RunningInstance } from "../src/instance.js";
import { TaskService, type CreateTaskFromBlockDraft, type TaskFromBlockRepository } from "../src/tasks.js";
import type { PortableTaskProjection } from "../src/notes.js";
import type { MemberAccessResolver } from "../src/workspaces-projects.js";

const noteId = "11111111-1111-4111-8111-111111111111";
const projectId = "22222222-2222-4222-8222-222222222222";
const blockKey = "33333333-3333-4333-8333-333333333333";
const blockId = "44444444-4444-4444-8444-444444444444";

class TaskFromBlockFake implements DatabaseProbe, TaskFromBlockRepository {
  readonly source = { content: "Plan the release", revision: 1, blockId: undefined as string | undefined };
  readonly tasks: PortableTaskProjection[] = [];
  failure = false;
  revokeAtBoundRead = false;
  private canRead = true;
  private serial = Promise.resolve();
  async verifyConnection() {}
  async close() {}
  async createTaskFromBlock(memberId: string, sourceNoteId: string, sourceBlockKey: string, draft: CreateTaskFromBlockDraft) {
    let release!: () => void;
    const previous = this.serial;
    this.serial = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    try {
    if (this.failure) throw new Error("postgres://secret");
    if (memberId !== "ada" || sourceNoteId !== noteId) return { status: "note_not_found" as const };
    if (sourceBlockKey !== blockKey) return { status: "block_not_found" as const };
    if (draft.projectId !== projectId) return { status: "project_forbidden" as const };
    const stableBlockId = this.source.blockId ?? blockId;
    const task: PortableTaskProjection = { schema: "stash.task.v1", id: draft.id, workspaceId: "88888888-8888-4888-8888-888888888888",
      projectId, title: draft.title, key: `STASH-${this.tasks.length + 1}`,
      status: { id: "55555555-5555-4555-8555-555555555555", name: "Backlog", category: "unstarted" },
      sourceNoteIds: [noteId], sourceBlocks: [{ noteId, blockId: stableBlockId }], createdAt: draft.createdAt, createdBy: draft.createdBy };
    this.source.blockId = stableBlockId;
    this.tasks.push(task);
    return { status: "created" as const, task, sourceBlock: { noteId, blockId: stableBlockId } };
    } finally { release(); }
  }
  async listLinkedTasks(memberId: string, sourceNoteId: string) {
    if (this.revokeAtBoundRead) this.canRead = false;
    if (!this.canRead || memberId !== "ada" || sourceNoteId !== noteId) return { status: "note_not_found" as const };
    return { status: "found" as const, tasks: this.tasks.map((task) => ({ id: task.id, key: task.key, title: task.title,
      status: task.status, sourceBlock: task.sourceBlocks![0]! })) };
  }
}

const access: MemberAccessResolver = { async authenticateBearer(value) {
  return value === "Bearer member-ada" ? { accountId: "ada", sessionId: "session" } : undefined;
} };

describe("creating a Task from a stable Note Block", () => {
  let instance: RunningInstance | undefined;
  afterEach(async () => instance?.close());

  async function run() {
    const database = new TaskFromBlockFake();
    instance = await startInstance({ database, host: "127.0.0.1", port: 0, instanceAdminToken: "admin",
      tasks: new TaskService(database, { async findPortableMemberIdentity(memberId) {
        return memberId === "ada" ? { localAccountId: "ada", displayName: "Ada Lovelace" } : undefined;
      } }), memberAccess: access });
    const create = (key: string, body: unknown, token = "member-ada") => fetch(`${instance!.url}/api/notes/${noteId}/blocks/${key}/tasks`, {
      method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify(body),
    });
    const linked = (token = "member-ada") => fetch(`${instance!.url}/api/notes/${noteId}/linked-tasks`, {
      headers: { authorization: `Bearer ${token}` },
    });
    return { database, create, linked };
  }

  it("creates independent canonical Tasks while preserving one sparse Block identity and source content", async () => {
    const { database, create } = await run();
    const before = { ...database.source };
    const first = await create(blockKey, { projectId, title: "Ship release notes" });
    assert.equal(first.status, 201);
    const firstBody = await first.json() as { task: PortableTaskProjection; sourceBlock: { noteId: string; blockId: string } };
    assert.equal(firstBody.task.key, "STASH-1");
    assert.equal(firstBody.task.status.name, "Backlog");
    assert.deepEqual(firstBody.task.sourceBlocks, [{ noteId, blockId }]);
    assert.deepEqual(firstBody.sourceBlock, { noteId, blockId });
    assert.equal(database.source.content, before.content);
    assert.equal(database.source.blockId, blockId);

    const second = await create(blockKey, { projectId, title: "Publish release notes" });
    assert.equal(second.status, 201);
    const secondBody = await second.json() as { task: PortableTaskProjection };
    assert.notEqual(secondBody.task.id, firstBody.task.id);
    assert.deepEqual(secondBody.task.sourceBlocks, [{ noteId, blockId }]);
    assert.equal(database.tasks.length, 2);
  });

  it("serializes simultaneous first links onto one stable Block identity", async () => {
    const { database, create } = await run();
    const [first, second] = await Promise.all([
      create(blockKey, { projectId, title: "Ship release notes" }),
      create(blockKey, { projectId, title: "Publish release notes" }),
    ]);
    assert.deepEqual([first.status, second.status], [201, 201]);
    const bodies = await Promise.all([first.json(), second.json()]) as Array<{ task: PortableTaskProjection; sourceBlock: { noteId: string; blockId: string } }>;
    assert.deepEqual(new Set(bodies.map(({ sourceBlock }) => sourceBlock.blockId)), new Set([blockId]));
    assert.deepEqual(new Set(bodies.map(({ task }) => task.key)), new Set(["STASH-1", "STASH-2"]));
    assert.equal(database.tasks.length, 2);
    assert.equal(database.tasks.every((task) => task.sourceBlocks?.[0]?.blockId === blockId), true);
  });

  it("reads permission-aware linked Tasks with live canonical Workflow status", async () => {
    const { database, create, linked } = await run();
    await create(blockKey, { projectId, title: "Ship release notes" });
    database.tasks[0]!.status = { id: "99999999-9999-4999-8999-999999999999", name: "In Progress", category: "started" };
    const response = await linked();
    assert.equal(response.status, 200);
    const body = await response.json() as { tasks: Array<{ key: string; status: { name: string }; sourceBlock: { blockId: string } }> };
    assert.equal(body.tasks[0]?.status.name, "In Progress");
    assert.equal(body.tasks[0]?.sourceBlock.blockId, blockId);
    assert.equal((await linked("unknown")).status, 401);
  });

  it("returns no linked Task data when access is revoked at the authorization-bound read seam", async () => {
    const { database, create, linked } = await run();
    await create(blockKey, { projectId, title: "Secret release title" });
    database.revokeAtBoundRead = true;
    const response = await linked();
    assert.equal(response.status, 404);
    const body = await response.text();
    assert.doesNotMatch(body, /Secret release title|STASH-1|Backlog/);
    assert.match(body, /note_not_found/);
  });

  it("surfaces authorization, invalid references, input, and failures without partial state", async () => {
    const { database, create } = await run();
    assert.equal((await create(blockKey, { projectId, title: "Private" }, "unknown")).status, 401);
    assert.equal((await create("66666666-6666-4666-8666-666666666666", { projectId, title: "Missing" })).status, 404);
    assert.equal((await create(blockKey, { projectId: "77777777-7777-4777-8777-777777777777", title: "Forbidden" })).status, 403);
    for (const body of [{}, { projectId, title: " " }, { projectId: "bad", title: "Task" }, { projectId, title: "Task", extra: true }])
      assert.equal((await create(blockKey, body)).status, 422);
    database.failure = true;
    const failed = await create(blockKey, { projectId, title: "Retry me" });
    assert.equal(failed.status, 503);
    assert.doesNotMatch(await failed.text(), /postgres|secret/i);
    assert.equal(database.tasks.length, 0);
    assert.equal(database.source.blockId, undefined);
    assert.equal(database.source.content, "Plan the release");
  });
});
