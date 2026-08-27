import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";

import { DiscussionService, type CreateDiscussionWorkDraft, type DiscussionDraft, type DiscussionRecord, type DiscussionRepository, type DiscussionWorkActivity, type DiscussionWorkOutcome, type DiscussionWorkProjection, type PortableDiscussionProjection, type PortableDiscussionWorkLinkProjection } from "../../src/discussions.js";
import { startInstance, type DatabaseProbe, type RunningInstance } from "../support/start-test-instance.js";
import type { MemberAccessResolver, PortableIdentity } from "../../src/workspaces-projects.js";

const noteId = "11111111-1111-4111-8111-111111111111";
const blockKey = "22222222-2222-4222-8222-222222222222";
const blockId = "33333333-3333-4333-8333-333333333333";
const taskId = "44444444-4444-4444-8444-444444444444";
const workspaceNoteId = "55555555-5555-4555-8555-555555555555";
const secretNoteId = "66666666-6666-4666-8666-666666666666";
const secretTaskId = "77777777-7777-4777-8777-777777777777";

class DiscussionFake implements DatabaseProbe, DiscussionRepository {
  readonly discussions: DiscussionRecord[] = [];
  readonly projections: PortableDiscussionProjection[] = [];
  readonly createdWork: Array<Extract<DiscussionWorkOutcome, { status: "created" }>> = [];
  readonly workRequests = new Map<string, { fingerprint: string; outcome: Extract<DiscussionWorkOutcome, { status: "created" }> }>();
  readonly workActivities: DiscussionWorkActivity[] = [];
  readonly workQueues = new Map<string, Promise<void>>();
  workProjectionFailure = false;
  blockPresent = true;
  duplicateBlock = false;
  fail = false;
  revoked = false;
  async verifyConnection() {}
  async close() {}
  async findPortableMemberIdentity(memberId: string): Promise<PortableIdentity | undefined> {
    if (memberId === "ada") return { localAccountId: "ada", displayName: "Ada Lovelace" };
    return memberId === "grace" ? { localAccountId: "grace", displayName: "Grace Hopper" } : undefined;
  }
  async createDiscussion(memberId: string, draft: DiscussionDraft) {
    if (this.fail) throw new Error("postgres://discussion-secret");
    if (this.revoked) return { status: "target_not_found" as const };
    if (memberId === "grace") return this.canGuestReadDraft(draft) ? { status: "forbidden" as const } : { status: "target_not_found" as const };
    if (memberId !== "ada") return { status: "target_not_found" as const };
    if (draft.target.kind === "note" && ![noteId, workspaceNoteId, secretNoteId].includes(draft.target.noteId)) return { status: "target_not_found" as const };
    if (draft.target.kind === "task" && ![taskId, secretTaskId].includes(draft.target.taskId)) return { status: "target_not_found" as const };
    if (draft.target.kind === "block") {
      if (draft.target.noteId !== noteId || draft.target.blockKey !== blockKey || !this.blockPresent)
        return { status: "target_not_found" as const };
      if (this.duplicateBlock) return { status: "ambiguous_block" as const };
    }
    const target: DiscussionRecord["target"] = draft.target.kind === "block"
      ? { kind: "block", noteId, blockId }
      : draft.target;
    const discussion: DiscussionRecord = { ...draft, target };
    const projection: PortableDiscussionProjection = { schema: "stash.discussion.v1", id: draft.id, workspaceId: draft.workspaceId,
      target: structuredClone(target), messages: structuredClone(draft.messages), createdAt: draft.createdAt };
    this.discussions.push(discussion);
    this.projections.push(structuredClone(projection));
    return { status: "created" as const, discussion: structuredClone(discussion), projection: structuredClone(projection) };
  }
  async findDiscussion(memberId: string, discussionId: string) {
    if (this.revoked) return { status: "not_found" as const };
    const discussion = this.discussions.find(({ id }) => id === discussionId);
    if (!discussion) return { status: "not_found" as const };
    if (memberId !== "ada" && !(memberId === "grace" && this.canGuestRead(discussion))) return { status: "not_found" as const };
    const copy = structuredClone(discussion);
    if (copy.target.kind === "block") copy.target.state = this.duplicateBlock ? "ambiguous" : this.blockPresent ? "attached" : "block_missing";
    return { status: "found" as const, discussion: copy };
  }
  async listNoteDiscussions(memberId: string, sourceNoteId: string) {
    if (this.revoked || ![noteId, workspaceNoteId, secretNoteId].includes(sourceNoteId)
      || memberId !== "ada" && !(memberId === "grace" && sourceNoteId === noteId)) return { status: "not_found" as const };
    const discussions: DiscussionRecord[] = [];
    for (const discussion of this.discussions.filter(({ target }) => target.kind !== "task" && target.noteId === sourceNoteId)) {
      const found = await this.findDiscussion(memberId, discussion.id);
      if (found.status === "found") discussions.push(found.discussion);
    }
    return { status: "found" as const, access: memberId === "ada" ? "edit" as const : "read" as const, discussions };
  }
  async listBlockDiscussions(memberId: string, sourceNoteId: string, sourceBlockKey: string) {
    if (sourceNoteId !== noteId || sourceBlockKey !== blockKey || !this.blockPresent) return { status: "not_found" as const };
    const listed = await this.listNoteDiscussions(memberId, sourceNoteId);
    if (listed.status !== "found") return listed;
    return { status: "found" as const, access: listed.access,
      discussions: listed.discussions.filter(({ target }) => target.kind === "block" && target.blockId === blockId) };
  }
  async listTaskDiscussions(memberId: string, sourceTaskId: string) {
    if (this.revoked || ![taskId, secretTaskId].includes(sourceTaskId)
      || memberId !== "ada" && !(memberId === "grace" && sourceTaskId === taskId)) return { status: "not_found" as const };
    return { status: "found" as const, access: memberId === "ada" ? "edit" as const : "read" as const, discussions: this.discussions
      .filter(({ target }) => target.kind === "task" && target.taskId === sourceTaskId)
      .map((discussion) => structuredClone(discussion)) };
  }
  async addMessage(memberId: string, discussionId: string, message: DiscussionRecord["messages"][number]) {
    if (this.fail) throw new Error("postgres://discussion-secret");
    const found = await this.findDiscussion(memberId, discussionId);
    if (found.status === "not_found") return found;
    if (memberId !== "ada") return { status: "forbidden" as const };
    const discussion = this.discussions.find(({ id }) => id === discussionId)!;
    if (discussion.resolvedAt) return { status: "resolved" as const };
    discussion.messages.push(message);
    const projection = { schema: "stash.discussion.v1" as const, id: discussion.id, workspaceId: discussion.workspaceId,
      target: structuredClone(discussion.target), messages: structuredClone(discussion.messages), createdAt: discussion.createdAt };
    this.projections.push(structuredClone(projection));
    return { status: "updated" as const, discussion: structuredClone(discussion), projection };
  }
  async resolveDiscussion(memberId: string, discussionId: string, resolvedAt: string) {
    if (this.fail) throw new Error("postgres://discussion-secret");
    const found = await this.findDiscussion(memberId, discussionId);
    if (found.status === "not_found") return found;
    if (memberId !== "ada") return { status: "forbidden" as const };
    const discussion = this.discussions.find(({ id }) => id === discussionId)!;
    if (discussion.resolvedAt) return { status: "already_resolved" as const, discussion: structuredClone(discussion) };
    discussion.resolvedAt = resolvedAt;
    const projection = { schema: "stash.discussion.v1" as const, id: discussion.id, workspaceId: discussion.workspaceId,
      target: structuredClone(discussion.target), messages: structuredClone(discussion.messages), createdAt: discussion.createdAt, resolvedAt };
    this.projections.push(structuredClone(projection));
    return { status: "resolved" as const, discussion: structuredClone(discussion), projection };
  }
  async createWorkFromMessages(memberId: string, discussionId: string, draft: CreateDiscussionWorkDraft): Promise<DiscussionWorkOutcome> {
    const found = await this.findDiscussion(memberId, discussionId);
    if (found.status === "not_found") return found;
    if (memberId !== "ada") return { status: "forbidden" };
    return this.serializeWorkKey(draft.idempotencyKey, async () => {
    const fingerprint = JSON.stringify({ discussionId, kind: draft.kind, messageIds: draft.messageIds,
      ...(draft.kind === "task" ? { projectId: draft.projectId, title: draft.title } : {}) });
    const prior = this.workRequests.get(draft.idempotencyKey);
    if (prior) return prior.fingerprint === fingerprint
      ? { ...structuredClone(prior.outcome), status: "duplicate" }
      : { status: "idempotency_conflict" };
    const selected = found.discussion.messages.filter((message) => draft.messageIds.includes(message.id));
    if (selected.length !== draft.messageIds.length) return { status: "message_not_found" };
    if (draft.kind === "task" && draft.projectId !== "88888888-8888-4888-8888-888888888888") return { status: "project_forbidden" };
    if (this.workProjectionFailure) throw new Error("portable outbox unavailable");
    const source = { discussionId, messageIds: selected.map(({ id }) => id) };
    const work = draft.kind === "note"
      ? { kind: "note" as const, id: draft.workId, workspaceId: found.discussion.workspaceId,
        content: selected.map(({ content }) => content).join("\n\n"), source }
      : { kind: "task" as const, id: draft.workId, workspaceId: found.discussion.workspaceId,
        projectId: draft.projectId, title: draft.title, key: "LAUNCH-1", source };
    const projections: DiscussionWorkProjection[] = [
      { schema: draft.kind === "note" ? "stash.note.v1" : "stash.task.v1" },
      { schema: "stash.discussion-work-link.v1", id: draft.linkId, workspaceId: found.discussion.workspaceId,
        discussionId, work: { kind: work.kind, id: work.id }, selectedMessages: selected, createdAt: draft.createdAt, createdBy: draft.createdBy },
    ];
    const activity: DiscussionWorkActivity = { schema: "stash.activity.v1", id: `activity-${this.workActivities.length + 1}`,
      workspaceId: found.discussion.workspaceId, action: "discussion_work_created",
      object: { kind: work.kind === "note" ? "Note" : "Task", id: work.id }, actor: draft.createdBy,
      cause: { kind: "member" }, occurredAt: draft.createdAt,
      before: { discussionId, selectedMessageIds: selected.map(({ id }) => id) }, after: structuredClone(work) };
    projections.push(activity);
    const outcome: Extract<DiscussionWorkOutcome, { status: "created" }> = { status: "created", work, activity, projections };
    this.createdWork.push(structuredClone(outcome));
    this.workActivities.push(structuredClone(activity));
    this.workRequests.set(draft.idempotencyKey, { fingerprint, outcome: structuredClone(outcome) });
    return structuredClone(outcome);
    });
  }
  private async serializeWorkKey<T>(key: string, action: () => Promise<T>): Promise<T> {
    const previous = this.workQueues.get(key) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => { release = resolve; });
    this.workQueues.set(key, current);
    await previous;
    try { return await action(); }
    finally { release(); if (this.workQueues.get(key) === current) this.workQueues.delete(key); }
  }
  private canGuestReadDraft(draft: DiscussionDraft) {
    return draft.target.kind === "task" ? draft.target.taskId === taskId
      : draft.target.noteId === noteId;
  }
  private canGuestRead(discussion: DiscussionRecord) {
    return discussion.target.kind === "task" ? discussion.target.taskId === taskId
      : discussion.target.noteId === noteId;
  }
}

const access: MemberAccessResolver = { async authenticateBearer(value) {
  if (value === "Bearer member-ada") return { accountId: "ada", sessionId: "session" };
  return value === "Bearer guest-grace" ? { accountId: "grace", sessionId: "guest-session" } : undefined;
} };

describe("portable Discussions", () => {
  let instance: RunningInstance | undefined;
  afterEach(async () => instance?.close());

  async function run() {
    const database = new DiscussionFake();
    instance = await startInstance({ database, host: "127.0.0.1", port: 0, instanceAdminToken: "admin",
      discussions: new DiscussionService(database), memberAccess: access });
    const request = (path: string, method = "GET", body?: unknown, token = "member-ada") => fetch(`${instance!.url}${path}`, {
      method, headers: { authorization: `Bearer ${token}`, ...(body === undefined ? {} : { "content-type": "application/json" }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { database, request };
  }

  it("holds Discussions on Notes, Blocks, and Tasks with portable attribution", async () => {
    const { database, request } = await run();
    const targets = [
      { kind: "note", noteId },
      { kind: "block", noteId, blockKey },
      { kind: "task", taskId },
    ];
    for (const [index, target] of targets.entries()) {
      const response = await request("/api/discussions", "POST", { target, message: `Message ${index + 1}` });
      assert.equal(response.status, 201);
      const body = await response.json() as { discussion: DiscussionRecord; projection: { status: string } };
      assert.equal(body.discussion.messages[0]?.author.displayName, "Ada Lovelace");
      assert.equal(body.projection.status, "recorded");
    }
    assert.deepEqual(database.discussions[1]?.target, { kind: "block", noteId, blockId });
    assert.equal(database.projections.every(({ schema }) => schema === "stash.discussion.v1"), true);
    assert.equal((await (await request(`/api/notes/${noteId}/discussions`)).json() as { discussions: DiscussionRecord[] }).discussions.length, 2);
    const blockResponse = await request(`/api/notes/${noteId}/blocks/${blockKey}/discussions`);
    assert.equal(blockResponse.status, 200);
    const blockDiscussions = (await blockResponse.json() as { discussions: DiscussionRecord[] }).discussions;
    assert.deepEqual(blockDiscussions.map(({ target }) => target.kind), ["block"]);
    assert.deepEqual(blockDiscussions.map(({ messages }) => messages[0]?.content), ["Message 2"]);
    assert.equal((await request(`/api/notes/${noteId}/blocks/99999999-9999-4999-8999-999999999999/discussions`)).status, 404);
    assert.equal((await (await request(`/api/tasks/${taskId}/discussions`)).json() as { discussions: DiscussionRecord[] }).discussions.length, 1);
  });

  it("retains resolved Discussion history and Block Discussions on their Note after Block loss", async () => {
    const { database, request } = await run();
    const created = await request("/api/discussions", "POST", { target: { kind: "block", noteId, blockKey }, message: "Keep this context" });
    const { discussion } = await created.json() as { discussion: DiscussionRecord };
    database.blockPresent = false;

    const attachedToNote = await request(`/api/notes/${noteId}/discussions`);
    assert.equal(attachedToNote.status, 200);
    assert.deepEqual((await attachedToNote.json() as { discussions: DiscussionRecord[] }).discussions[0]?.target,
      { kind: "block", noteId, blockId, state: "block_missing" });

    const missing = await request(`/api/discussions/${discussion.id}`);
    assert.equal(missing.status, 200);
    assert.deepEqual((await missing.json() as { discussion: DiscussionRecord }).discussion.target,
      { kind: "block", noteId, blockId, state: "block_missing" });

    const resolved = await request(`/api/discussions/${discussion.id}/resolution`, "PUT", {});
    assert.equal(resolved.status, 200);
    const read = await request(`/api/discussions/${discussion.id}`);
    const retained = (await read.json() as { discussion: DiscussionRecord }).discussion;
    assert.ok(retained.resolvedAt);
    assert.equal(retained.messages[0]?.content, "Keep this context");
    assert.equal(database.projections.at(-1)?.resolvedAt, retained.resolvedAt);
  });

  it("adds messages while open and makes terminal resolution visible", async () => {
    const { request } = await run();
    const created = await request("/api/discussions", "POST", { target: { kind: "task", taskId }, message: "First" });
    const { discussion } = await created.json() as { discussion: DiscussionRecord };
    const reply = await request(`/api/discussions/${discussion.id}/messages`, "POST", { content: "Second" });
    assert.equal(reply.status, 201);
    assert.equal((await reply.json() as { discussion: DiscussionRecord }).discussion.messages.length, 2);
    assert.equal((await request(`/api/discussions/${discussion.id}/resolution`, "PUT", {})).status, 200);
    const rejected = await request(`/api/discussions/${discussion.id}/messages`, "POST", { content: "Too late" });
    assert.equal(rejected.status, 409);
    assert.equal((await rejected.json() as { error: string }).error, "discussion_resolved");
  });

  it("surfaces permission, invalid target, ambiguity, and recoverable persistence failures without leakage", async () => {
    const { database, request } = await run();
    assert.equal((await request("/api/discussions", "POST", { target: { kind: "note", noteId }, message: "Private" }, "unknown")).status, 401);
    for (const body of [{}, { target: { kind: "note", noteId: "bad" }, message: "x" },
      { target: { kind: "task", taskId }, message: " " }, { target: { kind: "block", noteId, blockKey }, message: "x", extra: true }])
      assert.equal((await request("/api/discussions", "POST", body)).status, 422);
    assert.equal((await request("/api/discussions", "POST", { target: { kind: "note", noteId: taskId }, message: "Missing" })).status, 404);
    database.duplicateBlock = true;
    assert.equal((await request("/api/discussions", "POST", { target: { kind: "block", noteId, blockKey }, message: "Ambiguous" })).status, 422);
    database.duplicateBlock = false;
    database.fail = true;
    const failed = await request("/api/discussions", "POST", { target: { kind: "task", taskId }, message: "Retry" });
    assert.equal(failed.status, 503);
    assert.doesNotMatch(await failed.text(), /postgres|secret/i);
    assert.equal(database.discussions.length, 0);
  });

  it("rechecks authorization on every read without exposing Discussion content", async () => {
    const { database, request } = await run();
    const created = await request("/api/discussions", "POST", { target: { kind: "note", noteId }, message: "Sensitive roadmap" });
    const { discussion } = await created.json() as { discussion: DiscussionRecord };
    database.revoked = true;
    const denied = await request(`/api/discussions/${discussion.id}`);
    assert.equal(denied.status, 404);
    assert.doesNotMatch(await denied.text(), /Sensitive roadmap/);
  });

  it("lets a selected Project Guest read only shared Task and project-specific Note or Block Discussions", async () => {
    const { request } = await run();
    const sharedNote = await request("/api/discussions", "POST", { target: { kind: "note", noteId }, message: "Shared note" });
    const sharedBlock = await request("/api/discussions", "POST", { target: { kind: "block", noteId, blockKey }, message: "Shared block" });
    const sharedTask = await request("/api/discussions", "POST", { target: { kind: "task", taskId }, message: "Shared task" });
    const workspaceNote = await request("/api/discussions", "POST", { target: { kind: "note", noteId: workspaceNoteId }, message: "Workspace private" });
    const secretNote = await request("/api/discussions", "POST", { target: { kind: "note", noteId: secretNoteId }, message: "Other Project" });
    const secretTask = await request("/api/discussions", "POST", { target: { kind: "task", taskId: secretTaskId }, message: "Other Task" });
    const ids = await Promise.all([sharedNote, sharedBlock, sharedTask, workspaceNote, secretNote, secretTask]
      .map(async (response) => (await response.json() as { discussion: DiscussionRecord }).discussion.id));

    assert.equal((await request(`/api/notes/${noteId}/discussions`, "GET", undefined, "guest-grace")).status, 200);
    assert.equal((await request(`/api/tasks/${taskId}/discussions`, "GET", undefined, "guest-grace")).status, 200);
    for (const id of ids.slice(0, 3)) assert.equal((await request(`/api/discussions/${id}`, "GET", undefined, "guest-grace")).status, 200);
    for (const [path, secret] of [[`/api/notes/${workspaceNoteId}/discussions`, "Workspace private"],
      [`/api/notes/${secretNoteId}/discussions`, "Other Project"], [`/api/tasks/${secretTaskId}/discussions`, "Other Task"],
      ...ids.slice(3).map((id) => [`/api/discussions/${id}`, "private"])] as const) {
      const denied = await request(path, "GET", undefined, "guest-grace");
      assert.equal(denied.status, 404);
      assert.doesNotMatch(await denied.text(), new RegExp(secret, "i"));
    }
  });

  it("forbids a selected Project Guest from creating, replying to, or resolving Discussions", async () => {
    const { database, request } = await run();
    const created = await request("/api/discussions", "POST", { target: { kind: "task", taskId }, message: "Member message" });
    const { discussion } = await created.json() as { discussion: DiscussionRecord };
    const before = structuredClone(database.discussions);
    for (const target of [{ kind: "note", noteId }, { kind: "block", noteId, blockKey }, { kind: "task", taskId }])
      assert.equal((await request("/api/discussions", "POST", { target, message: "Guest message" }, "guest-grace")).status, 403);
    assert.equal((await request(`/api/discussions/${discussion.id}/messages`, "POST", { content: "Guest reply" }, "guest-grace")).status, 403);
    assert.equal((await request(`/api/discussions/${discussion.id}/resolution`, "PUT", {}, "guest-grace")).status, 403);
    assert.equal((await request("/api/discussions", "POST", { target: { kind: "task", taskId: secretTaskId }, message: "Probe" }, "guest-grace")).status, 404);
    assert.deepEqual(database.discussions, before);
  });

  it("creates linked durable Notes and Tasks from only the selected Discussion messages", async () => {
    const { database, request } = await run();
    const created = await request("/api/discussions", "POST", { target: { kind: "note", noteId }, message: "Keep as context" });
    const discussion = (await created.json() as { discussion: DiscussionRecord }).discussion;
    const second = await request(`/api/discussions/${discussion.id}/messages`, "POST", { content: "Turn this into work" });
    const messages = (await second.json() as { discussion: DiscussionRecord }).discussion.messages;

    const noteResponse = await request(`/api/discussions/${discussion.id}/work`, "POST", {
      kind: "note", messageIds: [messages[1]!.id], idempotencyKey: "99999999-9999-4999-8999-999999999991",
    });
    assert.equal(noteResponse.status, 201);
    const note = await noteResponse.json() as { result: string; work: { kind: string; content: string; source: { discussionId: string; messageIds: string[] } }; projections: Array<{ schema: string }> };
    assert.equal(note.work.kind, "note");
    assert.equal(note.work.content, "Turn this into work");
    assert.doesNotMatch(note.work.content, /Keep as context/);
    assert.deepEqual(note.work.source, { discussionId: discussion.id, messageIds: [messages[1]!.id] });
    assert.deepEqual(note.projections.map(({ schema }) => schema), ["stash.note.v1", "stash.discussion-work-link.v1", "stash.activity.v1"]);
    assert.deepEqual((database.createdWork[0]!.projections[1] as PortableDiscussionWorkLinkProjection).selectedMessages[0]!.author,
      { localAccountId: "ada", displayName: "Ada Lovelace" });
    assert.deepEqual(database.workActivities[0]?.before,
      { discussionId: discussion.id, selectedMessageIds: [messages[1]!.id] });
    assert.equal(database.workActivities[0]?.object.kind, "Note");

    const taskResponse = await request(`/api/discussions/${discussion.id}/work`, "POST", {
      kind: "task", messageIds: [messages[0]!.id, messages[1]!.id], projectId: "88888888-8888-4888-8888-888888888888",
      title: "Document the rollback path", idempotencyKey: "99999999-9999-4999-8999-999999999992",
    });
    assert.equal(taskResponse.status, 201);
    const task = await taskResponse.json() as { work: { kind: string; projectId: string; title: string; key: string; source: { discussionId: string; messageIds: string[] } } };
    assert.equal(task.work.kind, "task");
    assert.equal(task.work.projectId, "88888888-8888-4888-8888-888888888888");
    assert.equal(task.work.title, "Document the rollback path");
    assert.equal(task.work.key, "LAUNCH-1");
    assert.deepEqual(task.work.source, { discussionId: discussion.id, messageIds: messages.map(({ id }) => id) });
  });

  it("makes selection, authorization, idempotency, and recoverable projection failures visible", async () => {
    const { database, request } = await run();
    const created = await request("/api/discussions", "POST", { target: { kind: "task", taskId }, message: "Selected" });
    const discussion = (await created.json() as { discussion: DiscussionRecord }).discussion;
    const input = { kind: "note", messageIds: [discussion.messages[0]!.id], idempotencyKey: "99999999-9999-4999-8999-999999999993" };

    assert.equal((await request(`/api/discussions/${discussion.id}/work`, "POST", input, "guest-grace")).status, 403);
    for (const invalid of [{ ...input, messageIds: [] }, { ...input, messageIds: [taskId] },
      { ...input, messageIds: [discussion.messages[0]!.id, discussion.messages[0]!.id] }, { ...input, extra: true }])
      assert.equal((await request(`/api/discussions/${discussion.id}/work`, "POST", invalid)).status, 422);

    database.workProjectionFailure = true;
    const failed = await request(`/api/discussions/${discussion.id}/work`, "POST", input);
    assert.equal(failed.status, 503);
    assert.equal(database.createdWork.length, 0);
    assert.equal(database.workActivities.length, 0);
    database.workProjectionFailure = false;
    const first = await request(`/api/discussions/${discussion.id}/work`, "POST", input);
    assert.equal(first.status, 201);
    const firstBody = await first.json();
    const retry = await request(`/api/discussions/${discussion.id}/work`, "POST", input);
    assert.equal(retry.status, 200);
    assert.deepEqual((await retry.json() as { work: object }).work, (firstBody as { work: object }).work);
    assert.equal(database.createdWork.length, 1);
    assert.equal(database.workActivities.length, 1, "an exact duplicate does not append Activity");
    const conflict = await request(`/api/discussions/${discussion.id}/work`, "POST", { kind: "task", messageIds: input.messageIds,
      projectId: "88888888-8888-4888-8888-888888888888", title: "Different", idempotencyKey: input.idempotencyKey });
    assert.equal(conflict.status, 409);
    assert.equal(database.workActivities.length, 1, "a conflict does not append Activity");
  });

  it("serializes concurrent idempotency-key reuse across Discussions without duplicate work or outages", async () => {
    const { database, request } = await run();
    const [firstCreated, secondCreated] = await Promise.all([
      request("/api/discussions", "POST", { target: { kind: "note", noteId }, message: "First Discussion" }),
      request("/api/discussions", "POST", { target: { kind: "task", taskId }, message: "Second Discussion" }),
    ]);
    const first = (await firstCreated.json() as { discussion: DiscussionRecord }).discussion;
    const second = (await secondCreated.json() as { discussion: DiscussionRecord }).discussion;
    const idempotencyKey = "99999999-9999-4999-8999-999999999994";
    const responses = await Promise.all([
      request(`/api/discussions/${first.id}/work`, "POST", { kind: "note", messageIds: [first.messages[0]!.id], idempotencyKey }),
      request(`/api/discussions/${second.id}/work`, "POST", { kind: "note", messageIds: [second.messages[0]!.id], idempotencyKey }),
    ]);

    assert.deepEqual(responses.map(({ status }) => status).sort((left, right) => left - right), [201, 409]);
    assert.equal(responses.some(({ status }) => status === 503), false);
    assert.equal(database.createdWork.length, 1);
    assert.equal(database.workActivities.length, 1);
  });
});
