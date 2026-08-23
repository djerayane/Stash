import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";

import { ActivityService, type ActivityRecord, type ActivityRepository, type NoteHistoryRevision } from "../src/activity.js";
import { startInstance, type DatabaseProbe, type RunningInstance } from "../src/instance.js";
import { paragraphDocument, type RichTextDocument } from "../src/rich-text.js";
import type { MemberAccessResolver, PortableIdentity } from "../src/workspaces-projects.js";

const workspaceId = "11111111-1111-4111-8111-111111111111";
const noteId = "22222222-2222-4222-8222-222222222222";
const restoreKey = "33333333-3333-4333-8333-333333333333";

class ProtocolCompatibleActivityDatabase implements DatabaseProbe, ActivityRepository {
  readonly identities = new Map<string, PortableIdentity>([
    ["ada", { localAccountId: "ada", displayName: "Ada Lovelace" }],
    ["grace", { localAccountId: "grace", displayName: "Grace Hopper" }],
  ]);
  readonly revisions: NoteHistoryRevision[] = [
    { noteId, workspaceId, revision: 1, content: "Original", document: paragraphDocument("Original", "44444444-4444-4444-8444-444444444444"),
      recordedAt: "2026-08-22T08:00:00.000Z", actor: this.identities.get("ada")!, cause: { kind: "member" } },
    { noteId, workspaceId, revision: 2, content: "Changed", document: paragraphDocument("Changed", "55555555-5555-4555-8555-555555555555"),
      recordedAt: "2026-08-22T09:00:00.000Z", actor: this.identities.get("grace")!, cause: { kind: "member" } },
  ];
  readonly activities: ActivityRecord[] = [{ schema: "stash.activity.v1", id: "66666666-6666-4666-8666-666666666666",
    workspaceId, object: { kind: "Note", id: noteId }, action: "note_edited", actor: this.identities.get("grace")!,
    cause: { kind: "member" }, occurredAt: "2026-08-22T09:00:00.000Z", before: { revision: 1, content: "Original" },
    after: { revision: 2, content: "Changed" } }, { schema: "stash.activity.v1", id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    workspaceId, object: { kind: "Note", id: noteId }, action: "note_organized", actor: this.identities.get("ada")!,
    cause: { kind: "member" }, occurredAt: "2026-08-22T09:30:00.000Z", before: { projectId: null, tags: [] },
    after: { projectId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", tags: ["planning"] } }];
  currentRevision = 2;
  currentContent = "Changed";
  currentDocument: RichTextDocument = this.revisions[1]!.document;
  fail = false;
  readonly receipts = new Map<string, { targetRevision: number; activity: ActivityRecord; note: { revision: number; content: string; document: RichTextDocument } }>();

  async verifyConnection() {}
  async close() {}
  async listWorkspaceActivity(memberId: string, requestedWorkspaceId: string) {
    if (memberId !== "ada" || requestedWorkspaceId !== workspaceId) return { status: "forbidden" as const };
    return { status: "found" as const, activities: this.activities };
  }
  async listNoteHistory(memberId: string, requestedNoteId: string) {
    if (memberId !== "ada" || requestedNoteId !== noteId) return { status: "not_found" as const };
    return { status: "found" as const, revisions: this.revisions };
  }
  async restoreNote(memberId: string, requestedNoteId: string, targetRevision: number, expectedRevision: number, idempotencyKey: string) {
    if (this.fail) throw new Error("storage unavailable");
    if (memberId !== "ada" || requestedNoteId !== noteId) return { status: "not_found" as const };
    const receipt = this.receipts.get(idempotencyKey);
    if (receipt) return receipt.targetRevision === targetRevision
      ? { status: "duplicate" as const, note: receipt.note, activity: receipt.activity }
      : { status: "idempotency_conflict" as const };
    if (expectedRevision !== this.currentRevision) return { status: "revision_conflict" as const, currentRevision: this.currentRevision };
    const target = this.revisions.find((revision) => revision.revision === targetRevision);
    if (!target) return { status: "revision_not_found" as const };
    const actor = this.identities.get(memberId)!;
    const before = { revision: this.currentRevision, content: this.currentContent };
    this.currentRevision += 1; this.currentContent = target.content; this.currentDocument = target.document;
    const activity: ActivityRecord = { schema: "stash.activity.v1", id: "77777777-7777-4777-8777-777777777777", workspaceId,
      object: { kind: "Note", id: noteId }, action: "note_restored", actor, cause: { kind: "member", restorationOfRevision: targetRevision },
      occurredAt: "2026-08-22T10:00:00.000Z", before, after: { revision: this.currentRevision, content: this.currentContent } };
    this.activities.push(activity);
    this.revisions.push({ ...target, revision: this.currentRevision, recordedAt: activity.occurredAt, actor, cause: activity.cause });
    const note = { revision: this.currentRevision, content: this.currentContent, document: this.currentDocument };
    this.receipts.set(idempotencyKey, { targetRevision, activity, note });
    return { status: "restored" as const, note, activity };
  }
}

const access: MemberAccessResolver = { async authenticateBearer(value) {
  return value === "Bearer member-ada" ? { accountId: "ada", sessionId: "session-ada" }
    : value === "Bearer member-grace" ? { accountId: "grace", sessionId: "session-grace" } : undefined;
} };

describe("Activity and Note history", () => {
  let instance: RunningInstance | undefined;
  afterEach(async () => { await instance?.close(); instance = undefined; });
  async function run() {
    const database = new ProtocolCompatibleActivityDatabase();
    instance = await startInstance({ database, host: "127.0.0.1", port: 0, instanceAdminToken: "admin",
      activities: new ActivityService(database), memberAccess: access });
    return { database, baseUrl: instance.url };
  }
  const headers = { authorization: "Bearer member-ada", "content-type": "application/json" };

  it("reads permission-filtered Activity with actor, cause, time, and before-and-after state", async () => {
    const { baseUrl } = await run();
    const allowed = await fetch(`${baseUrl}/api/workspaces/${workspaceId}/activity`, { headers });
    assert.equal(allowed.status, 200);
    const body = await allowed.json() as { activities: ActivityRecord[] };
    assert.deepEqual(body.activities[0]!.actor, { localAccountId: "grace", displayName: "Grace Hopper" });
    assert.deepEqual(body.activities[0]!.cause, { kind: "member" });
    assert.deepEqual(body.activities[0]!.before, { revision: 1, content: "Original" });
    assert.deepEqual(body.activities[1]!.before, { projectId: null, tags: [] });
    assert.deepEqual(body.activities[1]!.after, { projectId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", tags: ["planning"] });
    const denied = await fetch(`${baseUrl}/api/workspaces/${workspaceId}/activity`, { headers: { authorization: "Bearer member-grace" } });
    assert.equal(denied.status, 404);
  });

  it("restores prior content as a new revision without erasing history or attribution", async () => {
    const { baseUrl, database } = await run();
    const before = await fetch(`${baseUrl}/api/notes/${noteId}/history`, { headers });
    assert.equal(before.status, 200);
    assert.deepEqual((await before.json() as { revisions: NoteHistoryRevision[] }).revisions.map(({ revision }) => revision), [1, 2]);
    const restore = await fetch(`${baseUrl}/api/notes/${noteId}/history/1/restore`, { method: "POST", headers,
      body: JSON.stringify({ expectedRevision: 2, idempotencyKey: restoreKey }) });
    assert.equal(restore.status, 200);
    const result = await restore.json() as { note: { revision: number; content: string }; activity: ActivityRecord };
    assert.deepEqual(result.note, { revision: 3, content: "Original", document: database.currentDocument });
    assert.equal(result.activity.action, "note_restored");
    assert.deepEqual(result.activity.cause, { kind: "member", restorationOfRevision: 1 });
    assert.deepEqual(database.revisions.map(({ revision, content }) => [revision, content]), [[1, "Original"], [2, "Changed"], [3, "Original"]]);
  });

  it("surfaces stale restores, invalid input, idempotency conflicts, authorization, and recoverable failures", async () => {
    const { baseUrl, database } = await run();
    const post = (revision: string, body: unknown, token = "member-ada") => fetch(`${baseUrl}/api/notes/${noteId}/history/${revision}/restore`, {
      method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify(body),
    });
    assert.equal((await post("1", { expectedRevision: 1, idempotencyKey: restoreKey })).status, 409);
    assert.equal((await post("0", { expectedRevision: 2, idempotencyKey: restoreKey })).status, 422);
    assert.equal((await post("1", { expectedRevision: 2, idempotencyKey: "bad" })).status, 422);
    assert.equal((await post("1", { expectedRevision: 2, idempotencyKey: restoreKey }, "member-grace")).status, 404);
    assert.equal((await post("1", { expectedRevision: 2, idempotencyKey: restoreKey })).status, 200);
    assert.equal((await post("2", { expectedRevision: 3, idempotencyKey: restoreKey })).status, 409);
    database.fail = true;
    assert.equal((await post("2", { expectedRevision: 3, idempotencyKey: "88888888-8888-4888-8888-888888888888" })).status, 503);
  });

  it("returns the exact original restore result when its retry arrives after another edit", async () => {
    const { baseUrl, database } = await run();
    const request = () => fetch(`${baseUrl}/api/notes/${noteId}/history/1/restore`, { method: "POST", headers,
      body: JSON.stringify({ expectedRevision: 2, idempotencyKey: restoreKey }) });
    const original = await request(); assert.equal(original.status, 200); const originalBody = await original.json();
    database.currentRevision = 4; database.currentContent = "Later edit";
    database.currentDocument = paragraphDocument("Later edit", "99999999-9999-4999-8999-999999999999");
    const retry = await request(); assert.equal(retry.status, 200);
    const retryBody = await retry.json() as { duplicate: boolean };
    assert.equal(retryBody.duplicate, true);
    assert.deepEqual({ ...retryBody, duplicate: false }, originalBody);
  });
});
