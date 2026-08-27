import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";

import { startInstance, type DatabaseProbe, type RunningInstance } from "./support/start-test-instance.js";
import {
  NoteService,
  noteOperationDigest,
  type NoteEditBatch,
  type NoteRecord,
  type NoteRepository,
  type PortableNoteProjection,
} from "../src/notes.js";
import { richTextToMarkdown } from "../src/rich-text.js";
import type { MemberAccessResolver } from "../src/workspaces-projects.js";

const workspaceId = "11111111-1111-4111-8111-111111111111";
const projectId = "22222222-2222-4222-8222-222222222222";
const blockId = "44444444-4444-4444-8444-444444444444";

class ProtocolCompatibleNoteDatabase implements DatabaseProbe, NoteRepository {
  readonly notes = new Map<string, NoteRecord>();
  readonly portableProjectionOutbox: PortableNoteProjection[] = [];
  readonly conflicts: NoteEditBatch[] = [];
  readonly applied = new Map<string, { revision: number; blockKey: string; digest: string }>();
  readonly acknowledged = new Map<string, { blockKey: string; digest: string }>();
  readonly conflictIds = new Set<string>();
  readonly conflictByOperation = new Map<string, string>();
  readonly editConflicts = new Map<string, import("../src/notes.js").NoteEditConflict>();
  failure: Error | undefined;
  projectionFailure: Error | undefined;
  updateFailure: Error | undefined;

  async verifyConnection(): Promise<void> {}
  async close(): Promise<void> {}

  async findPortableMemberIdentity(memberId: string) {
    return memberId === "ada"
      ? { localAccountId: "ada", displayName: "Ada Lovelace" }
      : undefined;
  }

  async createNote(memberId: string, note: NoteRecord, projection: PortableNoteProjection) {
    if (this.failure) throw this.failure;
    if (memberId !== "ada" || note.workspaceId !== workspaceId) return "workspace_forbidden" as const;
    if (note.projectId && note.projectId !== projectId) return "project_forbidden" as const;
    if (this.projectionFailure) throw this.projectionFailure;
    this.portableProjectionOutbox.push(projection);
    this.notes.set(note.id, note);
    return "created" as const;
  }

  async listInboxNotes() { return { status: "found" as const, notes: [] }; }
  async triageNote() { return { status: "note_not_found" as const }; }

  async findNoteForMember(memberId: string, noteId: string) {
    if (memberId !== "ada" && memberId !== "grace") return undefined;
    return this.notes.get(noteId);
  }

  async applyNoteOperations(memberId: string, noteId: string, batch: NoteEditBatch) {
    if (this.updateFailure) throw this.updateFailure;
    const current = this.notes.get(noteId);
    if ((memberId !== "ada" && memberId !== "grace") || !current) return { status: "not_found" as const };
    const reused = batch.operations.find((operation) => (this.applied.get(operation.id)?.digest ?? this.acknowledged.get(operation.id)?.digest) !== undefined
      && (this.applied.get(operation.id)?.digest ?? this.acknowledged.get(operation.id)?.digest) !== noteOperationDigest(operation));
    if (reused) { this.conflicts.push(batch); const id = "88888888-8888-4888-8888-888888888888";
      this.editConflicts.set(id, { id, noteId, baseRevision: batch.baseRevision, preservedDocument: current.document,
        preservedMarkdown: current.content, operations: [reused], kind: "invalid_operation_id", currentRevision: current.revision,
        createdBy: { displayName: memberId === "grace" ? "Grace Hopper" : "Ada Lovelace", attribution: "recorded" }, createdAt: "2026-08-22T10:00:00.000Z" });
      return { status: "invalid_reference" as const }; }
    const createdBy = { localAccountId: current.createdByMemberId, displayName: "Ada Lovelace" };
    const pending = batch.operations.filter(({ id }) => !this.applied.has(id) && !this.acknowledged.has(id) && !this.conflictIds.has(id));
    const projection = (note: NoteRecord): PortableNoteProjection => ({ schema: "stash.note.v1", id: note.id, workspaceId: note.workspaceId,
      content: note.content, tags: note.tags, createdAt: note.createdAt, createdBy });
    if (!pending.length) { const conflictId = batch.operations.map(({ id }) => this.conflictByOperation.get(id)).find(Boolean);
      return conflictId ? { status: "conflict_preserved" as const, conflictId }
      : { status: "duplicate" as const, note: current, projection: projection(current) };
    }
    if (pending.some((operation) => [...this.applied.values()].some((entry) => entry.revision > batch.baseRevision
      && (entry.blockKey === operation.blockKey || operation.type === "insert_block" && entry.blockKey === operation.afterBlockKey)))) {
      this.conflicts.push(batch); for (const operation of pending) this.conflictIds.add(operation.id);
      const id = "99999999-9999-4999-8999-999999999999";
      this.editConflicts.set(id, { id, noteId, baseRevision: batch.baseRevision, preservedDocument: current.document,
        preservedMarkdown: current.content, operations: pending, kind: "concurrent_edit", currentRevision: current.revision,
        createdBy: { displayName: memberId === "grace" ? "Grace Hopper" : "Ada Lovelace", attribution: "recorded" }, createdAt: "2026-08-22T10:00:00.000Z" });
      for (const operation of pending) this.conflictByOperation.set(operation.id, id);
      return { status: "conflict_preserved" as const, conflictId: id };
    }
    const blocks = [...current.document.blocks];
    for (const operation of pending) { const index = blocks.findIndex(({ blockKey }) => blockKey === operation.blockKey);
      if (operation.type === "delete_block") { if (index < 0 || blocks[index]!.id) return { status: "invalid_reference" as const }; blocks.splice(index, 1); }
      else if (operation.type === "insert_block") { if (index >= 0 || operation.block.id) return { status: "invalid_reference" as const };
        const after = operation.afterBlockKey === null ? -1 : blocks.findIndex(({ blockKey }) => blockKey === operation.afterBlockKey);
        if (operation.afterBlockKey !== null && after < 0) return { status: "invalid_reference" as const }; blocks.splice(after + 1, 0, operation.block); }
      else { if (index < 0 || blocks[index]!.id !== operation.block.id) return { status: "invalid_reference" as const }; blocks[index] = operation.block; } }
    const document = { type: "doc" as const, blocks }; const note = { ...current, document, content: richTextToMarkdown(document), revision: current.revision + 1 };
    for (const operation of pending) this.applied.set(operation.id, { revision: note.revision, blockKey: operation.blockKey, digest: noteOperationDigest(operation) });
    this.notes.set(note.id, note); this.portableProjectionOutbox.push(projection(note));
    return { status: "updated" as const, note, projection: projection(note) };
  }

  async listNoteEditConflicts(memberId: string, noteId: string) {
    if ((memberId !== "ada" && memberId !== "grace") || !this.notes.has(noteId)) return { status: "not_found" as const };
    return { status: "found" as const, conflicts: [...this.editConflicts.values()].filter((conflict) => conflict.noteId === noteId && !conflict.resolvedAt) };
  }

  async resolveNoteEditConflict(memberId: string, noteId: string, conflictId: string, resolution: "keep_current" | "apply_contribution", expectedRevision: number) {
    const current = this.notes.get(noteId); const conflict = this.editConflicts.get(conflictId);
    if ((memberId !== "ada" && memberId !== "grace") || !current) return { status: "not_found" as const };
    if (!conflict || conflict.noteId !== noteId) return { status: "conflict_not_found" as const };
    if (conflict.resolvedAt) return { status: "already_resolved" as const };
    if (current.revision !== expectedRevision) { conflict.currentRevision = current.revision; return { status: "conflict_changed" as const, conflict }; }
    if (resolution === "apply_contribution" && conflict.kind === "invalid_operation_id") return { status: "invalid_operation_identity" as const };
    if (resolution === "keep_current") { conflict.resolvedAt = "2026-08-22T10:01:00.000Z"; conflict.resolution = resolution;
      for (const operation of conflict.operations) { this.acknowledged.set(operation.id, { blockKey: operation.blockKey, digest: noteOperationDigest(operation) });
        this.conflictIds.delete(operation.id); this.conflictByOperation.delete(operation.id); }
      return { status: "resolved" as const, note: current, projection: this.portableProjectionOutbox.at(-1)! }; }
    const blocks = [...current.document.blocks];
    for (const operation of conflict.operations) { const index = blocks.findIndex(({ blockKey }) => blockKey === operation.blockKey);
      if (operation.type === "replace_block" && index >= 0) blocks[index] = operation.block;
      else if (operation.type === "delete_block" && index >= 0 && !blocks[index]!.id) blocks.splice(index, 1);
      else if (operation.type === "insert_block" && index < 0) { const after = operation.afterBlockKey === null ? -1 : blocks.findIndex(({ blockKey }) => blockKey === operation.afterBlockKey); if (operation.afterBlockKey !== null && after < 0) return { status: "invalid_reference" as const }; blocks.splice(after + 1, 0, operation.block); }
      else return { status: "invalid_reference" as const }; }
    const document = { type: "doc" as const, blocks }; const note = { ...current, document, content: richTextToMarkdown(document), revision: current.revision + 1 };
    this.notes.set(noteId, note); conflict.resolvedAt = "2026-08-22T10:01:00.000Z"; conflict.resolution = resolution;
    for (const operation of conflict.operations) { this.applied.set(operation.id, { revision: note.revision, blockKey: operation.blockKey, digest: noteOperationDigest(operation) });
      this.conflictIds.delete(operation.id); this.conflictByOperation.delete(operation.id); }
    const projection = { ...this.portableProjectionOutbox.at(-1)!, content: note.content }; this.portableProjectionOutbox.push(projection);
    return { status: "resolved" as const, note, projection };
  }
}

const access: MemberAccessResolver = {
  async authenticateBearer(authorization) {
    return authorization === "Bearer member-ada"
      ? { accountId: "ada", sessionId: "session-ada" }
      : authorization === "Bearer member-grace" ? { accountId: "grace", sessionId: "session-grace" }
      : undefined;
  },
};

describe("capturing Notes", () => {
  let instance: RunningInstance | undefined;

  afterEach(async () => {
    await instance?.close();
    instance = undefined;
  });

  async function run() {
    const database = new ProtocolCompatibleNoteDatabase();
    instance = await startInstance({
      database,
      host: "127.0.0.1",
      port: 0,
      instanceAdminToken: "test-instance-admin-token",
      notes: new NoteService(database),
      memberAccess: access,
    });
    return { database, baseUrl: instance.url };
  }

  function capture(baseUrl: string, token: string, body: unknown) {
    return fetch(`${baseUrl}/api/workspaces/${workspaceId}/notes`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  it("lets a Member capture a content-only workspace Note", async () => {
    const { baseUrl, database } = await run();

    const response = await capture(baseUrl, "member-ada", {
      content: "Follow up on the release retrospective.",
    });

    assert.equal(response.status, 201);
    const note = await response.json() as Record<string, unknown>;
    assert.equal(note.workspaceId, workspaceId);
    assert.equal(note.content, "Follow up on the release retrospective.");
    assert.equal(note.createdByMemberId, undefined);
    assert.equal(typeof note.createdAt, "string");
    assert.equal(note.projectId, undefined);
    assert.deepEqual(note.tags, []);
    assert.equal(note.reminder, undefined);
    assert.deepEqual(note.portableProjection, {
      format: "stash.note.v1",
      state: "recorded",
    });
    assert.equal(database.notes.size, 1);
    assert.deepEqual(database.portableProjectionOutbox, [{
      schema: "stash.note.v1",
      id: note.id,
      workspaceId,
      content: "Follow up on the release retrospective.",
      tags: [],
      createdAt: note.createdAt,
      createdBy: { localAccountId: "ada", displayName: "Ada Lovelace" },
    }]);
  });

  it("captures optional Project, tags, and reminder structure", async () => {
    const { baseUrl, database } = await run();

    const response = await capture(baseUrl, "member-ada", {
      content: "Prepare the launch checklist.",
      projectId,
      tags: ["launch", "follow-up", "launch"],
      reminder: { at: "2026-09-02T10:30:00+02:00" },
    });

    assert.equal(response.status, 201);
    const note = await response.json() as Omit<NoteRecord, "createdByMemberId"> & {
      portableProjection: { format: string; state: string };
    };
    assert.equal(note.projectId, projectId);
    assert.deepEqual(note.tags, ["launch", "follow-up"]);
    assert.deepEqual(note.reminder, { at: "2026-09-02T08:30:00.000Z" });
    const { portableProjection: _, ...publicNote } = note;
    assert.deepEqual(database.notes.get(note.id), { ...publicNote, createdByMemberId: "ada" });
    assert.deepEqual(database.portableProjectionOutbox[0], {
      schema: "stash.note.v1",
      id: note.id,
      workspaceId,
      projectId,
      content: "Prepare the launch checklist.",
      tags: ["launch", "follow-up"],
      reminder: { at: "2026-09-02T08:30:00.000Z" },
      createdAt: note.createdAt,
      createdBy: { localAccountId: "ada", displayName: "Ada Lovelace" },
    });
  });

  it("accepts real leap days and legal offset edges without changing their local calendar value", async () => {
    const { baseUrl } = await run();

    for (const [at, expectedUtc] of [
      ["2028-02-29T23:59:59+14:00", "2028-02-29T09:59:59.000Z"],
      ["2028-02-29T00:00:00-14:00", "2028-02-29T14:00:00.000Z"],
    ]) {
      const response = await capture(baseUrl, "member-ada", {
        content: "Valid reminder",
        reminder: { at },
      });
      assert.equal(response.status, 201);
      const note = await response.json() as { reminder: { at: string } };
      assert.equal(note.reminder.at, expectedUtc);
    }
  });

  it("makes permission, input, and recoverable persistence failures visible without saving data", async () => {
    const { baseUrl, database } = await run();

    const unauthorized = await capture(baseUrl, "unknown", { content: "Private" });
    assert.equal(unauthorized.status, 401);

    for (const invalidBody of [
      {},
      { content: "   " },
      { content: "Idea", tags: [""] },
      { content: "Idea", reminder: { at: "sometime" } },
      { content: "Idea", reminder: { at: "2026-09-02T10:30:00" } },
      { content: "Idea", reminder: { at: "2026-02-29T10:00:00Z" } },
      { content: "Idea", reminder: { at: "2026-02-30T10:00:00Z" } },
      { content: "Idea", reminder: { at: "2026-04-31T10:00:00+02:00" } },
      { content: "Idea", reminder: { at: "2026-09-02T10:30:00+14:01" } },
      { content: "Idea", reminder: { at: "2026-09-02T10:30:00+15:00" } },
      { content: "Idea", reminder: { at: "2026-09-02T10:30:00+02:60" } },
      { content: "Idea", projectId: "not-a-uuid" },
    ]) {
      const invalid = await capture(baseUrl, "member-ada", invalidBody);
      assert.equal(invalid.status, 422);
    }

    const inaccessibleProject = await capture(baseUrl, "member-ada", {
      content: "Must remain private",
      projectId: "33333333-3333-4333-8333-333333333333",
    });
    assert.equal(inaccessibleProject.status, 403);
    assert.deepEqual(await inaccessibleProject.json(), {
      error: "workspace_forbidden",
      message: "This Member cannot capture Notes in that Workspace or Project.",
    });
    assert.equal(database.notes.size, 0);

    database.failure = new Error("postgres://stash:secret@database/stash");
    const unavailable = await capture(baseUrl, "member-ada", { content: "Retry me" });
    assert.equal(unavailable.status, 503);
    const body = await unavailable.text();
    assert.doesNotMatch(body, /postgres|secret/i);
    assert.equal(database.notes.size, 0);

    database.failure = undefined;
    database.projectionFailure = new Error("projection unavailable");
    const projectionUnavailable = await capture(baseUrl, "member-ada", {
      content: "Must stay atomic",
    });
    assert.equal(projectionUnavailable.status, 503);
    assert.equal(database.notes.size, 0);
    assert.equal(database.portableProjectionOutbox.length, 0);
  });
});

describe("editing Notes", () => {
  let instance: RunningInstance | undefined;

  afterEach(async () => instance?.close());

  async function run() {
    const database = new ProtocolCompatibleNoteDatabase();
    instance = await startInstance({
      database, host: "127.0.0.1", port: 0, instanceAdminToken: "admin",
      notes: new NoteService(database), memberAccess: access,
    });
    const capture = await fetch(`${instance.url}/api/workspaces/${workspaceId}/notes`, {
      method: "POST",
      headers: { authorization: "Bearer member-ada", "content-type": "application/json" },
      body: JSON.stringify({ content: "Release notes" }),
    });
    return { database, baseUrl: instance.url, note: await capture.json() as NoteRecord };
  }

  const operationId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  const otherOperationId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
  const conflictOperationId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";

  it("loads a WYSIWYG-primary editor and applies an idempotent Block operation", async () => {
    const { baseUrl, database, note } = await run();
    const block = database.notes.get(note.id)!.document.blocks[0]!;
    block.id = blockId;
    const blockKey = block.blockKey!;
    const loaded = await fetch(`${baseUrl}/api/notes/${note.id}`, { headers: { authorization: "Bearer member-ada" } });
    assert.equal(loaded.status, 200);
    assert.equal((await loaded.json() as NoteRecord).document.blocks[0]?.type, "paragraph");

    const body = { baseRevision: 1, operations: [{ id: operationId, type: "replace_block", blockKey,
      block: { type: "heading", level: 2, blockKey, id: blockId, content: [{ text: "Release notes", marks: ["bold"] }] } }] };
    const response = await fetch(`${baseUrl}/api/notes/${note.id}`, {
      method: "PUT",
      headers: { authorization: "Bearer member-grace", "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    assert.equal(response.status, 200);
    const edited = await response.json() as NoteRecord;
    assert.equal(edited.revision, 2);
    assert.equal(edited.content, `## **Release notes**\n<!-- stash-block:${blockId} -->`);
    assert.deepEqual(database.notes.get(note.id)?.document, edited.document);
    assert.equal(database.portableProjectionOutbox.at(-1)?.content, edited.content);
    assert.deepEqual(database.portableProjectionOutbox.at(-1)?.createdBy, { localAccountId: "ada", displayName: "Ada Lovelace" });
    const retry = await fetch(`${baseUrl}/api/notes/${note.id}`, { method: "PUT",
      headers: { authorization: "Bearer member-grace", "content-type": "application/json" }, body: JSON.stringify(body) });
    assert.equal(retry.status, 200);
    assert.equal((await retry.json() as NoteRecord).revision, 2);
    const reused = { baseRevision: 2, operations: [{ ...body.operations[0], block: { ...body.operations[0]!.block, content: [{ text: "Changed reuse" }] } }] };
    const changedTarget = "77777777-7777-4777-8777-777777777777";
    const reuses = [reused, { baseRevision: 2, operations: [{ ...body.operations[0], blockKey: changedTarget,
      block: { ...body.operations[0]!.block, blockKey: changedTarget } }] },
    { baseRevision: 2, operations: [{ id: operationId, type: "delete_block", blockKey }] }];
    for (const reuse of reuses) assert.equal((await fetch(`${baseUrl}/api/notes/${note.id}`, { method: "PUT",
      headers: { authorization: "Bearer member-grace", "content-type": "application/json" }, body: JSON.stringify(reuse) })).status, 422);
    assert.equal(database.conflicts.length, 3);
  });

  it("merges concurrent operations on different Blocks and preserves same-Block conflicts", async () => {
    const { baseUrl, database, note } = await run();
    const first = database.notes.get(note.id)!.document.blocks[0]!;
    const secondKey = "55555555-5555-4555-8555-555555555555";
    database.notes.get(note.id)!.document.blocks.push({ type: "check", checked: false, blockKey: secondKey, content: [{ text: "Verify" }] });
    const update = (body: unknown, token = "member-ada") => fetch(`${baseUrl}/api/notes/${note.id}`, {
      method: "PUT",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    const replace = (id: string, blockKey: string, text: string, checked?: boolean) => ({ baseRevision: 1, operations: [{ id, type: "replace_block", blockKey,
      block: checked === undefined ? { ...first, blockKey, content: [{ text }] } : { type: "check", blockKey, checked, content: [{ text }] } }] });
    assert.equal((await update(replace(operationId, first.blockKey!, "First changed"))).status, 200);
    const merged = await update(replace(otherOperationId, secondKey, "Verified", true));
    assert.equal(merged.status, 200); assert.equal((await merged.json() as NoteRecord).revision, 3);
    const conflict = replace(conflictOperationId, first.blockKey!, "Conflicting");
    assert.equal((await update(conflict)).status, 409);
    assert.equal((await update(conflict)).status, 409);
    assert.equal(database.conflicts.length, 1);
    assert.equal(database.conflicts[0]!.operations[0]!.type, "replace_block");
    const swapId = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
    database.notes.get(note.id)!.document.blocks[0]!.id = blockId;
    database.notes.get(note.id)!.document.blocks[1]!.id = "66666666-6666-4666-8666-666666666666";
    const invalid = { baseRevision: 3, operations: [{ id: swapId, type: "replace_block", blockKey: first.blockKey,
      block: { ...first, blockKey: first.blockKey, id: "66666666-6666-4666-8666-666666666666", content: [{ text: "guessed" }] } }] };
    assert.equal((await update(invalid)).status, 422);
    assert.equal((await update(replace(operationId, first.blockKey!, "Private"), "unknown")).status, 401);
    database.updateFailure = new Error("database secret");
    const unavailable = await update(replace("eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee", secondKey, "Retry", true));
    assert.equal(unavailable.status, 503);
    assert.doesNotMatch(await unavailable.text(), /secret/i);
    assert.match(database.notes.get(note.id)!.content, /First changed/);
  });

  it("exposes a focused conflict and explicitly applies the preserved contribution", async () => {
    const { baseUrl, database, note } = await run();
    const block = database.notes.get(note.id)!.document.blocks[0]!;
    const update = (id: string, text: string, token = "member-ada") => fetch(`${baseUrl}/api/notes/${note.id}`, { method: "PUT",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ baseRevision: 1, operations: [{ id, type: "replace_block", blockKey: block.blockKey,
        block: { ...block, content: [{ text }] } }] }) });
    assert.equal((await update(operationId, "Published contribution")).status, 200);
    const conflicted = await update(conflictOperationId, "Preserved contribution", "member-grace");
    assert.equal(conflicted.status, 409);
    const conflictBody = await conflicted.json() as { conflictId: string };
    assert.equal(conflictBody.conflictId, "99999999-9999-4999-8999-999999999999");

    const listed = await fetch(`${baseUrl}/api/notes/${note.id}/conflicts`, { headers: { authorization: "Bearer member-grace" } });
    assert.equal(listed.status, 200);
    const listBody = await listed.json() as { conflicts: Array<Record<string, unknown>> };
    assert.equal(listBody.conflicts.length, 1);
    assert.equal(listBody.conflicts[0]?.createdByMemberId, undefined);
    assert.deepEqual(listBody.conflicts[0]?.createdBy, { displayName: "Grace Hopper", attribution: "recorded" });
    assert.equal(listBody.conflicts[0]?.currentRevision, 2);
    assert.deepEqual((listBody.conflicts[0]?.operations as NoteEditBatch["operations"])[0], database.conflicts[0]!.operations[0]);

    const resolved = await fetch(`${baseUrl}/api/notes/${note.id}/conflicts/${conflictBody.conflictId}`, { method: "PUT",
      headers: { authorization: "Bearer member-grace", "content-type": "application/json" }, body: JSON.stringify({ resolution: "apply_contribution", expectedRevision: 2 }) });
    assert.equal(resolved.status, 200);
    assert.match((await resolved.json() as NoteRecord).content, /Preserved contribution/);
    assert.equal((await fetch(`${baseUrl}/api/notes/${note.id}/conflicts/${conflictBody.conflictId}`, { method: "PUT",
      headers: { authorization: "Bearer member-grace", "content-type": "application/json" }, body: JSON.stringify({ resolution: "apply_contribution", expectedRevision: 2 }) })).status, 409);
    assert.deepEqual((await (await fetch(`${baseUrl}/api/notes/${note.id}/conflicts`, { headers: { authorization: "Bearer member-grace" } })).json() as { conflicts: unknown[] }).conflicts, []);
    const retryOriginal = await update(conflictOperationId, "Preserved contribution", "member-grace");
    assert.equal(retryOriginal.status, 200);
    assert.equal((await retryOriginal.json() as NoteRecord).revision, 3);
    assert.equal(database.notes.get(note.id)!.revision, 3);
  });

  it("returns the original conflict identity on duplicate delivery and preserves invalidated insert anchors", async () => {
    const { baseUrl, database, note } = await run(); const first = database.notes.get(note.id)!.document.blocks[0]!;
    const secondKey = "55555555-5555-4555-8555-555555555555";
    database.notes.get(note.id)!.document.blocks.push({ type: "paragraph", blockKey: secondKey, content: [{ text: "Second" }] });
    const send = (body: unknown) => fetch(`${baseUrl}/api/notes/${note.id}`, { method: "PUT", headers: {
      authorization: "Bearer member-ada", "content-type": "application/json" }, body: JSON.stringify(body) });
    assert.equal((await send({ baseRevision: 1, operations: [{ id: operationId, type: "delete_block", blockKey: first.blockKey }] })).status, 200);
    const insertion = { baseRevision: 1, operations: [{ id: conflictOperationId, type: "insert_block", blockKey: "77777777-7777-4777-8777-777777777777",
      afterBlockKey: first.blockKey, block: { type: "paragraph", blockKey: "77777777-7777-4777-8777-777777777777", content: [{ text: "Preserve me" }] } }] };
    const firstConflict = await send(insertion); assert.equal(firstConflict.status, 409); const firstBody = await firstConflict.json() as { conflictId: string };
    const retry = await send(insertion); assert.equal(retry.status, 409); assert.equal((await retry.json() as { conflictId: string }).conflictId, firstBody.conflictId);
  });

  it("refreshes a conflict instead of overwriting an intervening edit", async () => {
    const { baseUrl, database, note } = await run(); const block = database.notes.get(note.id)!.document.blocks[0]!;
    const send = (baseRevision: number, id: string, text: string) => fetch(`${baseUrl}/api/notes/${note.id}`, { method: "PUT",
      headers: { authorization: "Bearer member-ada", "content-type": "application/json" }, body: JSON.stringify({ baseRevision,
        operations: [{ id, type: "replace_block", blockKey: block.blockKey, block: { ...block, content: [{ text }] } }] }) });
    assert.equal((await send(1, operationId, "First")).status, 200);
    const conflictResponse = await send(1, conflictOperationId, "Preserved"); const { conflictId } = await conflictResponse.json() as { conflictId: string };
    assert.equal((await send(2, otherOperationId, "Intervening")).status, 200);
    const stale = await fetch(`${baseUrl}/api/notes/${note.id}/conflicts/${conflictId}`, { method: "PUT", headers: {
      authorization: "Bearer member-ada", "content-type": "application/json" }, body: JSON.stringify({ resolution: "apply_contribution", expectedRevision: 2 }) });
    assert.equal(stale.status, 409); const refreshed = await stale.json() as { error: string; conflict: { currentRevision: number } };
    assert.equal(refreshed.error, "conflict_changed"); assert.equal(refreshed.conflict.currentRevision, 3);
    assert.match(database.notes.get(note.id)!.content, /Intervening/);
  });

  it("never applies a preserved edit that reused another operation identity", async () => {
    const { baseUrl, database, note } = await run(); const block = database.notes.get(note.id)!.document.blocks[0]!;
    const request = (text: string) => fetch(`${baseUrl}/api/notes/${note.id}`, { method: "PUT", headers: {
      authorization: "Bearer member-ada", "content-type": "application/json" }, body: JSON.stringify({ baseRevision: 1,
        operations: [{ id: operationId, type: "replace_block", blockKey: block.blockKey, block: { ...block, content: [{ text }] } }] }) });
    assert.equal((await request("Applied")).status, 200); assert.equal((await request("Identity reuse")).status, 422);
    const listed = await fetch(`${baseUrl}/api/notes/${note.id}/conflicts`, { headers: { authorization: "Bearer member-ada" } });
    const invalid = (await listed.json() as { conflicts: Array<{ id: string; kind: string }> }).conflicts.find(({ kind }) => kind === "invalid_operation_id")!;
    const applied = await fetch(`${baseUrl}/api/notes/${note.id}/conflicts/${invalid.id}`, { method: "PUT", headers: {
      authorization: "Bearer member-ada", "content-type": "application/json" }, body: JSON.stringify({ resolution: "apply_contribution", expectedRevision: 2 }) });
    assert.equal(applied.status, 422); assert.match(database.notes.get(note.id)!.content, /Applied/);
  });

  it("keeps the published Note when a Member dismisses a preserved contribution", async () => {
    const { baseUrl, database, note } = await run();
    const block = database.notes.get(note.id)!.document.blocks[0]!;
    const replace = (id: string, text: string) => ({ baseRevision: 1, operations: [{ id, type: "replace_block", blockKey: block.blockKey,
      block: { ...block, content: [{ text }] } }] });
    const request = (body: unknown, token = "member-ada") => fetch(`${baseUrl}/api/notes/${note.id}`, { method: "PUT",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify(body) });
    assert.equal((await request(replace(operationId, "Published"))).status, 200);
    const conflict = await request(replace(conflictOperationId, "Dismissed"));
    const { conflictId } = await conflict.json() as { conflictId: string };
    const endpoint = `${baseUrl}/api/notes/${note.id}/conflicts/${conflictId}`;
    assert.equal((await fetch(endpoint, { method: "PUT", headers: { authorization: "Bearer unknown", "content-type": "application/json" },
      body: JSON.stringify({ resolution: "keep_current", expectedRevision: 2 }) })).status, 401);
    assert.equal((await fetch(endpoint, { method: "PUT", headers: { authorization: "Bearer member-ada", "content-type": "application/json" },
      body: JSON.stringify({ resolution: "guess", expectedRevision: 2 }) })).status, 422);
    const dismissed = await fetch(endpoint, { method: "PUT", headers: { authorization: "Bearer member-ada", "content-type": "application/json" },
      body: JSON.stringify({ resolution: "keep_current", expectedRevision: 2 }) });
    assert.equal(dismissed.status, 200);
    assert.match((await dismissed.json() as NoteRecord).content, /Published/);
    assert.equal(database.notes.get(note.id)!.revision, 2);
    const retry = await request(replace(conflictOperationId, "Dismissed"));
    assert.equal(retry.status, 200); assert.equal((await retry.json() as NoteRecord).revision, 2);
    const reused = await request(replace(conflictOperationId, "Different reuse"));
    assert.equal(reused.status, 422); assert.equal(database.notes.get(note.id)!.revision, 2);
  });
});
