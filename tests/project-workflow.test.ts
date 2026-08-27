import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";

import { startInstance, type DatabaseProbe, type RunningInstance } from "./support/start-test-instance.js";
import { initialWorkflowStatus, ProjectWorkflowService, type ProjectWorkflow, type ProjectWorkflowRepository } from "../src/project-workflows.js";
import { TaskService, type CreateTaskFromBlockDraft, type TaskPlanningReadModel } from "../src/tasks.js";
import type { PortableTaskProjection } from "../src/notes.js";
import type { MemberAccessResolver } from "../src/workspaces-projects.js";

const projectId = "22222222-2222-4222-8222-222222222222";
const backlogId = "55555555-5555-4555-8555-555555555555";
const readyId = "66666666-6666-4666-8666-666666666666";
const doneId = "99999999-9999-4999-8999-999999999999";
const otherProjectId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const noteId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const blockId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const sourceTaskId = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";

class WorkflowFake implements DatabaseProbe, ProjectWorkflowRepository {
  workflow: ProjectWorkflow = { schema: "stash.workflow.v1", projectId, revision: 1, statuses: [
    { id: backlogId, name: "Backlog", category: "unstarted", position: 0, archived: false },
    { id: readyId, name: "Ready", category: "unstarted", position: 1, archived: false },
    { id: doneId, name: "Done", category: "completed", position: 2, archived: false },
  ] };
  projections: ProjectWorkflow[] = [];
  taskSequence = 1;
  fail = false;
  async verifyConnection() {}
  async close() {}
  async findPortableMemberIdentity(memberId: string) {
    return memberId === "member" ? { localAccountId: memberId, displayName: "Ada Lovelace" } : undefined;
  }
  async findWorkflow(memberId: string, requestedProjectId: string) {
    if (requestedProjectId !== projectId || memberId === "outsider") return { status: "not_found" as const };
    if (memberId === "guest") return { status: "forbidden" as const };
    return { status: "found" as const, workflow: structuredClone(this.workflow) };
  }
  async replaceWorkflow(memberId: string, requestedProjectId: string, expectedRevision: number, statuses: ProjectWorkflow["statuses"], newStatusIds: ReadonlySet<string>) {
    if (this.fail) throw new Error("postgres://secret");
    if (requestedProjectId !== projectId || memberId === "outsider") return { status: "not_found" as const };
    if (memberId === "guest") return { status: "forbidden" as const };
    if (expectedRevision !== this.workflow.revision) return { status: "stale_status" as const };
    const existing = new Set(this.workflow.statuses.map(({ id }) => id));
    if (statuses.some(({ id }) => !existing.has(id) && !newStatusIds.has(id))) return { status: "stale_status" as const };
    const next = statuses.map((status, position) => ({ ...status, id: status.id!, position }));
    if (JSON.stringify(next) === JSON.stringify(this.workflow.statuses))
      return { status: "updated" as const, workflow: structuredClone(this.workflow) };
    this.workflow = { schema: "stash.workflow.v1", projectId, revision: this.workflow.revision + 1, statuses: next };
    this.projections.push(structuredClone(this.workflow));
    return { status: "updated" as const, workflow: structuredClone(this.workflow) };
  }
  async createTaskFromBlock(_memberId: string, requestedNoteId: string, requestedBlockId: string, draft: CreateTaskFromBlockDraft) {
    const task = this.#task(draft.id, `FLOW-${this.taskSequence++}`, draft.title, draft, initialWorkflowStatus(this.workflow));
    return { status: "created" as const, task, sourceBlock: { noteId: requestedNoteId, blockId: requestedBlockId } };
  }
  async moveTask(memberId: string, sourceProjectId: string, taskKey: string, destinationProjectId: string) {
    if (memberId !== "member" || sourceProjectId !== otherProjectId || destinationProjectId !== projectId || taskKey !== "SOURCE-1")
      return { status: "not_found" as const };
    const status = initialWorkflowStatus(this.workflow);
    const task = { ...this.#task(sourceTaskId, "FLOW-2", "Move me", {
      projectId, createdAt: "2026-08-23T10:00:00.000Z", createdBy: { localAccountId: "member", displayName: "Ada Lovelace" },
    }, status), revision: 1, dependencyWarnings: [] };
    return { status: "moved" as const, task, activity: {
      schema: "stash.activity.v1" as const, id: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee", workspaceId: task.workspaceId,
      action: "task_moved" as const, object: { kind: "Task" as const, id: task.id },
      actor: { localAccountId: "member", displayName: "Ada Lovelace" }, cause: { kind: "member" as const },
      occurredAt: "2026-08-23T10:00:00.000Z",
      before: { projectId: otherProjectId, key: "SOURCE-1", status: { id: backlogId, name: "Backlog", category: "unstarted" as const } },
      after: { projectId, key: task.key, status: task.status },
    } };
  }
  #task(id: string, key: string, title: string, draft: Pick<CreateTaskFromBlockDraft, "projectId" | "createdAt" | "createdBy">,
    status: ProjectWorkflow["statuses"][number]): PortableTaskProjection {
    return { schema: "stash.task.v1", id, workspaceId: "ffffffff-ffff-4fff-8fff-ffffffffffff", projectId: draft.projectId,
      key, title, status: { id: status.id, name: status.name, category: status.category }, sourceNoteIds: [],
      createdAt: draft.createdAt, createdBy: draft.createdBy };
  }
}

const access: MemberAccessResolver = { async authenticateBearer(header) {
  const accountId = header?.replace("Bearer ", "");
  return accountId && ["member", "guest", "outsider"].includes(accountId) ? { accountId, sessionId: "session" } : undefined;
} };

describe("Project Workflow configuration", () => {
  let instance: RunningInstance | undefined;
  afterEach(async () => { await instance?.close(); instance = undefined; });
  async function run() {
    const database = new WorkflowFake();
    instance = await startInstance({ database, host: "127.0.0.1", port: 0, instanceAdminToken: "admin",
      projectWorkflows: new ProjectWorkflowService(database), tasks: new TaskService(database, database), memberAccess: access });
    const request = (method: string, body?: unknown, token = "member", id = projectId) => fetch(`${instance!.url}/api/projects/${id}/workflow`, {
      method, headers: { authorization: `Bearer ${token}`, ...(body === undefined ? {} : { "content-type": "application/json" }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { database, request };
  }

  it("renames, reorders, adds, archives, and changes categories without changing existing status identities", async () => {
    const { database, request } = await run();
    const response = await request("PUT", { expectedRevision: 1, statuses: [
      { id: readyId, name: "Queued", category: "unstarted" },
      { name: "Verifying", category: "started" },
      { id: doneId, name: "Shipped", category: "completed" },
      { id: backlogId, name: "Backlog", category: "unstarted", archived: true },
    ] });
    assert.equal(response.status, 200);
    const workflow = (await response.json() as { workflow: ProjectWorkflow }).workflow;
    assert.deepEqual(workflow.statuses.map(({ name, category, position, archived }) => ({ name, category, position, archived })), [
      { name: "Queued", category: "unstarted", position: 0, archived: false },
      { name: "Verifying", category: "started", position: 1, archived: false },
      { name: "Shipped", category: "completed", position: 2, archived: false },
      { name: "Backlog", category: "unstarted", position: 3, archived: true },
    ]);
    assert.equal(workflow.statuses[0]!.id, readyId);
    assert.equal(workflow.statuses[2]!.id, doneId);
    assert.match(workflow.statuses[1]!.id, /^[0-9a-f-]{36}$/);
    assert.deepEqual(database.projections, [workflow]);
    assert.deepEqual((await (await request("GET")).json() as { workflow: ProjectWorkflow }).workflow, workflow);
  });

  it("is idempotent when the resulting Workflow is submitted again", async () => {
    const { database, request } = await run();
    const first = await request("PUT", { expectedRevision: 1, statuses: database.workflow.statuses.map(({ position: _, ...status }, index) =>
      index === 0 ? { ...status, name: "Ideas" } : status) });
    const workflow = (await first.json() as { workflow: ProjectWorkflow }).workflow;
    const second = await request("PUT", { expectedRevision: workflow.revision, statuses: workflow.statuses.map(({ position: _, ...status }) => status) });
    assert.equal(second.status, 200);
    assert.deepEqual((await second.json() as { workflow: ProjectWorkflow }).workflow, workflow);
    assert.equal(database.projections.length, 1);
  });

  it("makes permissions, invalid input, stale identities, and recoverable failures visible without partial changes", async () => {
    const { database, request } = await run();
    assert.equal((await request("GET", undefined, "missing")).status, 401);
    assert.equal((await request("GET", undefined, "guest")).status, 403);
    assert.equal((await request("GET", undefined, "outsider")).status, 404);
    const before = structuredClone(database.workflow);
    for (const body of [
      { expectedRevision: 1, statuses: [] },
      { expectedRevision: 1, statuses: [{ id: backlogId, name: "  ", category: "unstarted" }] },
      { expectedRevision: 1, statuses: [{ id: backlogId, name: "Same", category: "unstarted" }, { id: readyId, name: "same", category: "started" }] },
      { expectedRevision: 1, statuses: [{ id: backlogId, name: "Maybe", category: "unknown" }] },
      { expectedRevision: 1, statuses: [{ id: backlogId, name: "Gone", category: "unstarted", archived: true }] },
    ]) assert.equal((await request("PUT", body)).status, 422);
    assert.deepEqual(database.workflow, before);
    const stale = await request("PUT", { expectedRevision: 1, statuses: [{ id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", name: "Backlog", category: "unstarted" }] });
    assert.equal(stale.status, 409);
    database.fail = true;
    const unavailable = await request("PUT", { expectedRevision: 1, statuses: before.statuses.map(({ position: _, ...status }) => status) });
    assert.equal(unavailable.status, 503);
    assert.doesNotMatch(await unavailable.text(), /postgres|secret/i);
    assert.deepEqual(database.workflow, before);
  });

  it("rejects the second concurrent edit at the same revision", async () => {
    const { database, request } = await run();
    const statuses = database.workflow.statuses.map(({ position: _, ...status }) => status);
    const [first, second] = await Promise.all([
      request("PUT", { expectedRevision: 1, statuses: statuses.map((status, index) => index ? status : { ...status, name: "Ideas" }) }),
      request("PUT", { expectedRevision: 1, statuses: statuses.map((status, index) => index ? status : { ...status, name: "Proposed" }) }),
    ]);
    assert.deepEqual([first.status, second.status].sort(), [200, 409]);
    assert.equal(database.workflow.revision, 2);
  });

  it("selects the first active unstarted status after rename, reorder, and archival", () => {
    const workflow: ProjectWorkflow = { schema: "stash.workflow.v1", projectId, revision: 4, statuses: [
      { id: doneId, name: "Shipped", category: "completed", position: 0, archived: false },
      { id: backlogId, name: "Old queue", category: "unstarted", position: 1, archived: true },
      { id: readyId, name: "Next", category: "unstarted", position: 2, archived: false },
    ] };
    assert.equal(initialWorkflowStatus(workflow).id, readyId);
  });

  it("creates and moves Tasks into the first active unstarted status after Workflow customization", async () => {
    const { request } = await run();
    const customized = await request("PUT", { expectedRevision: 1, statuses: [
      { id: doneId, name: "Shipped", category: "completed" },
      { id: backlogId, name: "Former inbox", category: "unstarted", archived: true },
      { id: readyId, name: "Next", category: "unstarted" },
    ] });
    assert.equal(customized.status, 200);

    const created = await fetch(`${instance!.url}/api/notes/${noteId}/blocks/${blockId}/tasks`, {
      method: "POST", headers: { authorization: "Bearer member", "content-type": "application/json" },
      body: JSON.stringify({ projectId, title: "Created after customization" }),
    });
    assert.equal(created.status, 201);
    const createdTask = (await created.json() as { task: PortableTaskProjection }).task;
    assert.deepEqual(createdTask.status, { id: readyId, name: "Next", category: "unstarted" });

    const moved = await fetch(`${instance!.url}/api/projects/${otherProjectId}/tasks/SOURCE-1/move`, {
      method: "POST", headers: { authorization: "Bearer member", "content-type": "application/json" },
      body: JSON.stringify({ destinationProjectId: projectId }),
    });
    assert.equal(moved.status, 200);
    const movedTask = (await moved.json() as { task: TaskPlanningReadModel }).task;
    assert.deepEqual(movedTask.status, { id: readyId, name: "Next", category: "unstarted" });
  });
});
