import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";

import { startInstance, type DatabaseProbe, type RunningInstance } from "./support/start-test-instance.js";
import {
  NoteService,
  type NoteRecord,
  type NoteRepository,
  type NoteTriageChange,
  type NoteTriageResult,
  type PortableNoteProjection,
} from "../src/notes.js";
import type { MemberAccessResolver } from "../src/workspaces-projects.js";

const workspaceId = "11111111-1111-4111-8111-111111111111";
const projectId = "22222222-2222-4222-8222-222222222222";
const noteId = "33333333-3333-4333-8333-333333333333";
const targetNoteId = "44444444-4444-4444-8444-444444444444";

class ProtocolCompatibleInboxDatabase implements DatabaseProbe, NoteRepository {
  readonly note: NoteRecord = {
    id: noteId, workspaceId, content: "Turn the release idea into work.", tags: [],
    document: { type: "doc", blocks: [{ type: "paragraph", content: [{ text: "Turn the release idea into work." }] }] },
    revision: 1,
    createdByMemberId: "grace", createdAt: "2026-08-22T10:00:00.000Z",
  };
  readonly projections: object[] = [];
  archived = false;
  nextTaskNumber = 1;
  readonly workflowStatuses = [
    { id: "55555555-5555-4555-8555-555555555555", name: "Backlog", category: "unstarted", position: 0 },
    { id: "66666666-6666-4666-8666-666666666666", name: "Ready", category: "unstarted", position: 1 },
    { id: "77777777-7777-4777-8777-777777777777", name: "In Progress", category: "started", position: 2 },
    { id: "88888888-8888-4888-8888-888888888888", name: "In Review", category: "started", position: 3 },
    { id: "99999999-9999-4999-8999-999999999999", name: "Done", category: "completed", position: 4 },
  ] as const;
  failure: Error | undefined;

  async verifyConnection() {}
  async close() {}
  async findPortableMemberIdentity(memberId: string) {
    return memberId === "grace"
      ? { localAccountId: "grace", displayName: "Grace Hopper" }
      : { localAccountId: "ada", displayName: "Ada Lovelace" };
  }
  async createNote(_memberId: string, _note: NoteRecord, _projection: PortableNoteProjection) { return "created" as const; }
  async findNoteForMember() { return undefined; }
  async applyNoteOperations() { return { status: "not_found" as const }; }
  async listNoteEditConflicts() { return { status: "not_found" as const }; }
  async resolveNoteEditConflict() { return { status: "not_found" as const }; }
  async listInboxNotes(memberId: string, requestedWorkspaceId: string) {
    if (memberId !== "ada" || requestedWorkspaceId !== workspaceId) return { status: "workspace_forbidden" as const };
    return { status: "found" as const, notes: this.archived || this.note.projectId ? [] : [this.note] };
  }
  async triageNote(memberId: string, requestedWorkspaceId: string, requestedNoteId: string, change: NoteTriageChange) {
    if (this.failure) throw this.failure;
    if (memberId !== "ada" || requestedWorkspaceId !== workspaceId) return { status: "workspace_forbidden" as const };
    if (requestedNoteId !== noteId) return { status: "note_not_found" as const };
    if (change.kind === "organized") {
      if (change.note.projectId !== projectId) return { status: "project_forbidden" as const };
      Object.assign(this.note, change.note);
    } else if (change.kind === "archived") this.archived = true;
    const result: NoteTriageResult = change.kind === "task_created" ? (() => {
      const task = { ...change.task, schema: "stash.task.v1" as const, key: `REL-${this.nextTaskNumber++}`,
        status: { id: "55555555-5555-4555-8555-555555555555", name: "Backlog", category: "unstarted" as const } };
      return { kind: "task_created" as const, task, projections: [task] };
    })() : change;
    this.projections.push(...result.projections);
    return { status: "updated" as const, result };
  }
}

const access: MemberAccessResolver = {
  async authenticateBearer(header) {
    return header === "Bearer member-ada" ? { accountId: "ada", sessionId: "session-ada" } : undefined;
  },
};

describe("Inbox triage", () => {
  let instance: RunningInstance | undefined;
  afterEach(async () => { await instance?.close(); instance = undefined; });

  async function run() {
    const database = new ProtocolCompatibleInboxDatabase();
    instance = await startInstance({ database, host: "127.0.0.1", port: 0,
      instanceAdminToken: "admin", notes: new NoteService(database), memberAccess: access });
    return { database, baseUrl: instance.url };
  }

  async function triage(baseUrl: string, body: unknown, id = noteId, token = "member-ada") {
    return fetch(`${baseUrl}/api/workspaces/${workspaceId}/inbox/${id}/triage`, {
      method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  it("lists only unorganized active Notes in a Member's Workspace Inbox", async () => {
    const { baseUrl, database } = await run();
    const response = await fetch(`${baseUrl}/api/workspaces/${workspaceId}/inbox`, {
      headers: { authorization: "Bearer member-ada" },
    });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { notes: [{
      id: noteId, workspaceId, content: "Turn the release idea into work.", tags: [],
      document: { type: "doc", blocks: [{ type: "paragraph", content: [{ text: "Turn the release idea into work." }] }] },
      revision: 1,
      createdAt: "2026-08-22T10:00:00.000Z",
    }] });
  });

  it("organizes an Inbox Note without changing its identity or content", async () => {
    const { baseUrl, database } = await run();
    const response = await triage(baseUrl, { action: "organize", projectId, tags: ["release", "release"] });
    assert.equal(response.status, 200);
    const body = await response.json() as any;
    assert.equal(body.note.id, noteId);
    assert.equal(body.note.content, "Turn the release idea into work.");
    assert.equal(body.note.projectId, projectId);
    assert.deepEqual(body.note.tags, ["release"]);
    assert.equal(database.projections.length, 1);
    assert.equal((database.projections[0] as any).schema, "stash.note.v2");
    assert.deepEqual((database.projections[0] as any).createdBy, {
      localAccountId: "grace", displayName: "Grace Hopper",
    });
  });

  it("archives, links, and creates actionable work while preserving the source Note", async () => {
    for (const [request, expectedKind] of [
      [{ action: "archive" }, "archived"],
      [{ action: "link", targetNoteId }, "linked"],
      [{ action: "create_task", projectId, title: "Ship the release" }, "task_created"],
    ] as const) {
      const { baseUrl, database } = await run();
      const response = await triage(baseUrl, request);
      assert.equal(response.status, 200);
      const body = await response.json() as any;
      assert.equal(body.result, expectedKind);
      assert.equal(database.note.content, "Turn the release idea into work.");
      assert.ok(database.projections.length >= 1);
      if (expectedKind === "task_created") {
        assert.equal(body.task.key, "REL-1");
        assert.deepEqual(body.task.status, {
          id: "55555555-5555-4555-8555-555555555555", name: "Backlog", category: "unstarted",
        });
        assert.deepEqual(body.task.createdBy, { localAccountId: "ada", displayName: "Ada Lovelace" });
      }
      await instance?.close(); instance = undefined;
    }
  });

  it("concurrently allocates Task Keys and initializes the complete default Workflow once", async () => {
    const { baseUrl, database } = await run();
    const [first, second] = await Promise.all([
      triage(baseUrl, { action: "create_task", projectId, title: "Ship release" }),
      triage(baseUrl, { action: "create_task", projectId, title: "Publish notes" }),
    ]);
    assert.equal(first.status, 200);
    assert.equal(second.status, 200);
    const keys = [((await first.json()) as any).task.key, ((await second.clone().json()) as any).task.key].sort();
    assert.deepEqual(keys, ["REL-1", "REL-2"]);
    const secondTask = (await second.json() as any).task;
    assert.deepEqual(secondTask.status, {
      id: "55555555-5555-4555-8555-555555555555", name: "Backlog", category: "unstarted",
    });
    assert.deepEqual(database.workflowStatuses.map(({ name, category, position }) => ({ name, category, position })), [
      { name: "Backlog", category: "unstarted", position: 0 },
      { name: "Ready", category: "unstarted", position: 1 },
      { name: "In Progress", category: "started", position: 2 },
      { name: "In Review", category: "started", position: 3 },
      { name: "Done", category: "completed", position: 4 },
    ]);
  });

  it("exposes authorization, invalid input, missing objects, and recoverable failures without partial changes", async () => {
    const { baseUrl, database } = await run();
    assert.equal((await triage(baseUrl, { action: "archive" }, noteId, "unknown")).status, 401);
    assert.equal((await triage(baseUrl, { action: "organize", projectId: "bad" })).status, 422);
    assert.equal((await triage(baseUrl, { action: "archive" }, targetNoteId)).status, 404);
    assert.equal((await triage(baseUrl, { action: "organize", projectId: targetNoteId })).status, 403);
    database.failure = new Error("postgres://secret");
    const unavailable = await triage(baseUrl, { action: "archive" });
    assert.equal(unavailable.status, 503);
    assert.doesNotMatch(await unavailable.text(), /postgres|secret/i);
    assert.equal(database.archived, false);
    assert.deepEqual(database.projections, []);
  });
});
