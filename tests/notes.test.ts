import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";

import { startInstance, type DatabaseProbe, type RunningInstance } from "../src/instance.js";
import {
  NoteService,
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
  readonly applied = new Map<string, { revision: number; blockKey: string }>();
  readonly conflictIds = new Set<string>();
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
    if (memberId !== "ada") return undefined;
    return this.notes.get(noteId);
  }

  async applyNoteOperations(memberId: string, noteId: string, batch: NoteEditBatch, createdBy: { localAccountId: string; displayName: string }) {
    if (this.updateFailure) throw this.updateFailure;
    const current = this.notes.get(noteId);
    if (memberId !== "ada" || !current) return { status: "not_found" as const };
    const pending = batch.operations.filter(({ id }) => !this.applied.has(id) && !this.conflictIds.has(id));
    const projection = (note: NoteRecord): PortableNoteProjection => ({ schema: "stash.note.v1", id: note.id, workspaceId: note.workspaceId,
      content: note.content, tags: note.tags, createdAt: note.createdAt, createdBy });
    if (!pending.length) return batch.operations.some(({ id }) => this.conflictIds.has(id)) ? { status: "conflict_preserved" as const }
      : { status: "duplicate" as const, note: current, projection: projection(current) };
    if (pending.some(({ blockKey }) => [...this.applied.values()].some((entry) => entry.revision > batch.baseRevision && entry.blockKey === blockKey))) {
      this.conflicts.push(batch); for (const operation of pending) this.conflictIds.add(operation.id); return { status: "conflict_preserved" as const };
    }
    const blocks = [...current.document.blocks];
    for (const operation of pending) { const index = blocks.findIndex(({ blockKey }) => blockKey === operation.blockKey);
      if (operation.type === "delete_block") { if (index < 0 || blocks[index]!.id) return { status: "invalid_reference" as const }; blocks.splice(index, 1); }
      else if (operation.type === "insert_block") { if (index >= 0 || operation.block.id) return { status: "invalid_reference" as const };
        const after = operation.afterBlockKey === null ? -1 : blocks.findIndex(({ blockKey }) => blockKey === operation.afterBlockKey);
        if (operation.afterBlockKey !== null && after < 0) return { status: "invalid_reference" as const }; blocks.splice(after + 1, 0, operation.block); }
      else { if (index < 0 || blocks[index]!.id !== operation.block.id) return { status: "invalid_reference" as const }; blocks[index] = operation.block; } }
    const document = { type: "doc" as const, blocks }; const note = { ...current, document, content: richTextToMarkdown(document), revision: current.revision + 1 };
    for (const operation of pending) this.applied.set(operation.id, { revision: note.revision, blockKey: operation.blockKey });
    this.notes.set(note.id, note); this.portableProjectionOutbox.push(projection(note));
    return { status: "updated" as const, note, projection: projection(note) };
  }
}

const access: MemberAccessResolver = {
  async authenticateBearer(authorization) {
    return authorization === "Bearer member-ada"
      ? { accountId: "ada", sessionId: "session-ada" }
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
    const editor = await fetch(`${baseUrl}/notes/${note.id}/edit`);
    assert.equal(editor.status, 200);
    const html = await editor.text();
    assert.match(html, /contenteditable="false"/);
    assert.match(html, /Loading Note/);
    assert.match(html, /button\.disabled=false/);
    assert.match(html, /aria-label="Note editor"/);
    assert.match(html, />Bold</);
    assert.match(html, />Undo</);
    assert.match(html, />Checklist</);
    assert.match(html, />Code block</);
    assert.match(html, /dataset\.blockId/);
    assert.match(html, /\/assets\/gsap\.min\.js/);
    assert.match(html, /prefers-reduced-motion/);
    assert.match(html, /Checklist state/);
    const gsap = await fetch(`${baseUrl}/assets/gsap.min.js`);
    assert.equal(gsap.status, 200);
    assert.match(await gsap.text(), /GreenSock|gsap/i);
    assert.match(html, /Your changes remain in the editor/);
    assert.doesNotMatch(html, /Markdown source/i);

    const body = { baseRevision: 1, operations: [{ id: operationId, type: "replace_block", blockKey,
      block: { type: "heading", level: 2, blockKey, id: blockId, content: [{ text: "Release notes", marks: ["bold"] }] } }] };
    const response = await fetch(`${baseUrl}/api/notes/${note.id}`, {
      method: "PUT",
      headers: { authorization: "Bearer member-ada", "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    assert.equal(response.status, 200);
    const edited = await response.json() as NoteRecord;
    assert.equal(edited.revision, 2);
    assert.equal(edited.content, `## **Release notes**\n<!-- stash-block:${blockId} -->`);
    assert.deepEqual(database.notes.get(note.id)?.document, edited.document);
    assert.equal(database.portableProjectionOutbox.at(-1)?.content, edited.content);
    const retry = await fetch(`${baseUrl}/api/notes/${note.id}`, { method: "PUT",
      headers: { authorization: "Bearer member-ada", "content-type": "application/json" }, body: JSON.stringify(body) });
    assert.equal(retry.status, 200);
    assert.equal((await retry.json() as NoteRecord).revision, 2);
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
});
