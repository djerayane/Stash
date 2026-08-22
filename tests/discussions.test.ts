import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";

import { DiscussionService, type DiscussionDraft, type DiscussionRecord, type DiscussionRepository, type PortableDiscussionProjection } from "../src/discussions.js";
import { startInstance, type DatabaseProbe, type RunningInstance } from "../src/instance.js";
import type { MemberAccessResolver, PortableIdentity } from "../src/workspaces-projects.js";

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
    return { status: "found" as const, discussions };
  }
  async listTaskDiscussions(memberId: string, sourceTaskId: string) {
    if (this.revoked || ![taskId, secretTaskId].includes(sourceTaskId)
      || memberId !== "ada" && !(memberId === "grace" && sourceTaskId === taskId)) return { status: "not_found" as const };
    return { status: "found" as const, discussions: this.discussions
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
});
