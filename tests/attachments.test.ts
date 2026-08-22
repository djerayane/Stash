import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";

import { AttachmentService, encodePortableFilename, LocalAttachmentStorage, portableAttachmentHref, type AttachmentRecord, type AttachmentRepository, type PortableAttachmentProjection } from "../src/attachments.js";
import { startInstance, type DatabaseProbe, type RunningInstance } from "../src/instance.js";
import type { MemberAccessResolver } from "../src/workspaces-projects.js";
import { NoteService, type NoteEditBatch, type NoteRecord, type NoteRepository, type PortableNoteProjection } from "../src/notes.js";
import { richTextToMarkdown } from "../src/rich-text.js";

const workspaceId = "11111111-1111-4111-8111-111111111111";
class RecordingLocalStorage extends LocalAttachmentStorage { writes = 0; override async put(key: string, content: Buffer) { this.writes += 1; await super.put(key, content); } }
class AttachmentDatabase implements DatabaseProbe, AttachmentRepository, NoteRepository {
  records = new Map<string, AttachmentRecord>(); projections: PortableAttachmentProjection[] = [];
  notes = new Map<string, NoteRecord>(); noteProjections: PortableNoteProjection[] = [];
  fail = false;
  async verifyConnection() {} async close() {}
  async findPortableMemberIdentity(memberId: string) { return memberId === "ada" ? { localAccountId: "ada", displayName: "Ada Lovelace" } : undefined; }
  async canCreateAttachment(memberId: string, requestedWorkspaceId: string) { return memberId === "ada" && requestedWorkspaceId === workspaceId; }
  async createAttachment(memberId: string, record: AttachmentRecord, projection: PortableAttachmentProjection) {
    if (memberId !== "ada" || record.workspaceId !== workspaceId) return "workspace_forbidden" as const;
    if (this.fail) throw new Error("database unavailable");
    this.records.set(record.id, record); this.projections.push(projection); return "created" as const;
  }
  async findAttachmentForMember(memberId: string, id: string) { return memberId === "ada" ? this.records.get(id) : undefined; }
  async createNote(memberId: string, note: NoteRecord, projection: PortableNoteProjection) { if (!await this.canCreateAttachment(memberId, note.workspaceId)) return "workspace_forbidden" as const; this.notes.set(note.id, note); this.noteProjections.push(projection); return "created" as const; }
  async listInboxNotes() { return { status: "found" as const, notes: [] }; }
  async triageNote() { return { status: "note_not_found" as const }; }
  async findNoteForMember(memberId: string, id: string) { return memberId === "ada" ? this.notes.get(id) : undefined; }
  async applyNoteOperations(memberId: string, id: string, batch: NoteEditBatch) {
    const current = await this.findNoteForMember(memberId, id); if (!current) return { status: "not_found" as const };
    const operation = batch.operations[0]!; if (operation.type !== "replace_block") return { status: "invalid_reference" as const };
    const index = current.document.blocks.findIndex(({ blockKey }) => blockKey === operation.blockKey); if (index < 0) return { status: "invalid_reference" as const };
    const blocks = [...current.document.blocks]; blocks[index] = operation.block; const document = { type: "doc" as const, blocks };
    const note = { ...current, document, content: richTextToMarkdown(document), revision: current.revision + 1 }; this.notes.set(id, note);
    const projection = { ...this.noteProjections[0]!, content: note.content }; this.noteProjections.push(projection); return { status: "updated" as const, note, projection };
  }
  async listNoteEditConflicts() { return { status: "not_found" as const }; }
  async resolveNoteEditConflict() { return { status: "not_found" as const }; }
}
const access: MemberAccessResolver = { async authenticateBearer(value) { return value === "Bearer member-ada" ? { accountId: "ada", sessionId: "s" } : value === "Bearer member-grace" ? { accountId: "grace", sessionId: "g" } : undefined; } };

describe("Workspace Attachments", () => {
  let instance: RunningInstance | undefined;
  afterEach(async () => { await instance?.close(); instance = undefined; });
  async function run() {
    const directory = await mkdtemp(join(tmpdir(), "stash-attachments-")); const database = new AttachmentDatabase(); const storage = new RecordingLocalStorage(directory);
    instance = await startInstance({ database, host: "127.0.0.1", port: 0, instanceAdminToken: "admin", memberAccess: access,
      attachments: new AttachmentService(database, storage, { maxBytes: 12 }), notes: new NoteService(database) });
    return { database, directory, storage, baseUrl: instance.url };
  }
  const upload = (baseUrl: string, token: string, body: string, filename = "design notes.txt", contentType = "text/plain") => fetch(`${baseUrl}/api/workspaces/${workspaceId}/attachments`, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": contentType, "x-stash-filename": encodePortableFilename(filename), "x-stash-source": "paste" }, body });

  it("uploads pasted bytes, records a portable relative link, and serves them only to Workspace Members", async () => {
    const { baseUrl, database, directory, storage } = await run();
    const response = await upload(baseUrl, "member-ada", "hello stash"); assert.equal(response.status, 201);
    const attachment = await response.json() as AttachmentRecord & { contentUrl: string; portableHref: string; portableLink: string; portableProjection: object };
    assert.equal(attachment.source, "paste"); assert.equal(attachment.relativePath.startsWith("./attachments/"), true);
    assert.equal(decodeURIComponent(new URL(attachment.portableHref, "file:///export/note.md").pathname).slice("/export/".length), attachment.relativePath.slice(2));
    assert.equal(attachment.portableLink, `[design notes.txt](<${attachment.portableHref}>)`);
    assert.equal(await readFile(join(directory, workspaceId, attachment.id), "utf8"), "hello stash");
    assert.deepEqual(database.projections[0], { schema: "stash.attachment.v1", id: attachment.id, workspaceId, filename: "design notes.txt", contentType: "text/plain", size: 11, relativePath: attachment.relativePath, source: "paste", createdAt: attachment.createdAt, createdBy: { localAccountId: "ada", displayName: "Ada Lovelace" } });
    const served = await fetch(`${baseUrl}${attachment.contentUrl}`, { headers: { authorization: "Bearer member-ada" } });
    assert.equal(served.status, 200); assert.equal(served.headers.get("content-type"), "text/plain"); assert.equal(served.headers.get("x-content-type-options"), "nosniff"); assert.equal(await served.text(), "hello stash");
    assert.equal((await fetch(`${baseUrl}${attachment.contentUrl}`, { headers: { authorization: "Bearer member-grace" } })).status, 404);

    const uploaded = await fetch(`${baseUrl}/api/workspaces/${workspaceId}/attachments`, { method: "POST", headers: { authorization: "Bearer member-ada", "content-type": "application/pdf", "x-stash-filename": "brief.pdf" }, body: "%PDF" });
    assert.equal(uploaded.status, 201);
    assert.equal((await uploaded.json() as { source: string }).source, "upload");

    const hostile = await upload(baseUrl, "member-ada", "safe bytes", "x](javascript:alert(1)).txt");
    assert.equal(hostile.status, 201);
    const hostileAttachment = await hostile.json() as { portableLink: string; portableHref: string; relativePath: string; contentUrl: string };
    assert.equal(hostileAttachment.portableLink, `[x\\](javascript:alert(1)).txt](<${hostileAttachment.portableHref}>)`);
    const hostileServed = await fetch(`${baseUrl}${hostileAttachment.contentUrl}`, { headers: { authorization: "Bearer member-ada" } });
    assert.match(hostileServed.headers.get("content-disposition") ?? "", /filename\*=UTF-8''x%5D%28javascript%3Aalert%281%29%29\.txt$/);

    const windowsInvalid = await upload(baseUrl, "member-ada", "portable", "report*.txt");
    assert.equal(windowsInvalid.status, 201);
    const portable = await windowsInvalid.json() as { relativePath: string; portableHref: string; contentUrl: string };
    assert.match(portable.relativePath, /report%2A\.txt$/);
    assert.equal(decodeURIComponent(new URL(portable.portableHref, "file:///export/note.md").pathname).slice("/export/".length), portable.relativePath.slice(2));
    assert.equal(await (await fetch(`${baseUrl}${portable.contentUrl}`, { headers: { authorization: "Bearer member-ada" } })).text(), "portable");

    const unicodeUpload = await upload(baseUrl, "member-ada", "utf8", "界.txt");
    assert.equal(unicodeUpload.status, 201);
    const unicodeResponse = await unicodeUpload.json() as { filename: string; relativePath: string; portableHref: string };
    assert.equal(unicodeResponse.filename, "界.txt");
    assert.match(unicodeResponse.relativePath, /%E7%95%8C\.txt$/);
    assert.equal(decodeURIComponent(new URL(unicodeResponse.portableHref, "file:///export/note.md").pathname).slice("/export/".length), unicodeResponse.relativePath.slice(2));

    const unicode = await new AttachmentService(database, storage, { maxBytes: 12 }).create("ada", workspaceId, { filename: "界.txt", contentType: "text/plain", source: "upload", content: Buffer.from("utf8") });
    assert.equal(unicode.status, "created");
    if (unicode.status === "created") {
      const href = portableAttachmentHref(unicode.record.relativePath);
      assert.equal(decodeURIComponent(new URL(href, "file:///export/note.md").pathname).slice("/export/".length), unicode.record.relativePath.slice(2));
    }

    const captured = await fetch(`${baseUrl}/api/workspaces/${workspaceId}/notes`, { method: "POST", headers: { authorization: "Bearer member-ada", "content-type": "application/json" }, body: JSON.stringify({ content: "Design file" }) });
    const note = await captured.json() as NoteRecord; const block = database.notes.get(note.id)!.document.blocks[0]!;
    const linked = await fetch(`${baseUrl}/api/notes/${note.id}`, { method: "PUT", headers: { authorization: "Bearer member-ada", "content-type": "application/json" }, body: JSON.stringify({ baseRevision: 1, operations: [{ id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", type: "replace_block", blockKey: block.blockKey, block: { ...block, content: [{ text: attachment.filename, href: attachment.portableHref }] } }] }) });
    assert.equal(linked.status, 200);
    assert.equal((await linked.json() as NoteRecord).content, `[design notes.txt](<${attachment.portableHref}>)`);
  });

  it("rejects unsafe names, unsupported types, oversized bodies, and cleans stored bytes after metadata failure", async () => {
    const { baseUrl, database, directory, storage } = await run();
    assert.equal((await upload(baseUrl, "member-grace", "private")).status, 403);
    assert.equal(storage.writes, 0);
    assert.deepEqual(await readdir(directory), []);
    assert.equal((await upload(baseUrl, "member-ada", "x", "../secret.txt")).status, 422);
    for (const filename of ["CON", "con.txt", "LPT9.log", "trailing."]) assert.equal((await upload(baseUrl, "member-ada", "x", filename)).status, 422, filename);
    await assert.rejects(() => new AttachmentService(database, storage, { maxBytes: 12 }).create("ada", workspaceId, { filename: `${"界".repeat(29)}.txt`, contentType: "text/plain", source: "upload", content: Buffer.from("x") }));
    await assert.rejects(() => new AttachmentService(database, storage, { maxBytes: 12 }).create("ada", workspaceId, { filename: "trailing ", contentType: "text/plain", source: "upload", content: Buffer.from("x") }));
    await assert.rejects(() => new AttachmentService(database, storage, { maxBytes: 12 }).create("ada", workspaceId, { filename: "control\u0001.txt", contentType: "text/plain", source: "upload", content: Buffer.from("x") }));
    assert.equal((await upload(baseUrl, "member-ada", "x", "script.html", "text/html")).status, 415);
    assert.equal((await upload(baseUrl, "member-ada", "1234567890123")).status, 413);
    database.fail = true; assert.equal((await upload(baseUrl, "member-ada", "retryable")).status, 503);
    await assert.rejects(readFile(join(directory, workspaceId, [...database.records.keys()][0] ?? "missing")));
  });
});
