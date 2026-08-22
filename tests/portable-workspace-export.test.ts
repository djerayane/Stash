import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { Pool } from "pg";

import { createAuthenticationSecretCodec } from "../src/authentication-secrets.js";
import { AttachmentService, LocalAttachmentStorage, portableAttachmentHref } from "../src/attachments.js";
import { startInstance, type DatabaseProbe, type RunningInstance } from "../src/instance.js";
import { NoteService } from "../src/notes.js";
import { PostgresDatabase } from "../src/postgres-database.js";
import {
  PortableWorkspaceExportService,
  PortableWorkspaceExportTooLarge,
  type PortableWorkspaceExportRepository,
  type PortableWorkspaceExportSnapshot,
} from "../src/portable-workspace-export.js";
import type { MemberAccessResolver } from "../src/workspaces-projects.js";
import { WorkspaceProjectService } from "../src/workspaces-projects.js";
import { TaskService } from "../src/tasks.js";
import { BoardService } from "../src/boards.js";
import { MobileCaptureService } from "../src/mobile-captures.js";
import { DiscussionService } from "../src/discussions.js";
import { NoteLinkService } from "../src/note-links.js";

const workspaceId = "11111111-1111-4111-8111-111111111111";
const secretWorkspaceId = "99999999-9999-4999-8999-999999999999";
const actor = { localAccountId: "ada", displayName: "Ada Lovelace" };

const snapshot: PortableWorkspaceExportSnapshot = {
  workspace: { schema: "stash.workspace.v1", id: workspaceId, name: "Research / Lab", owner: { type: "personal", identity: actor }, createdBy: actor },
  notes: [{ schema: "stash.note.v1", id: "22222222-2222-4222-8222-222222222222", workspaceId,
    projectId: "33333333-3333-4333-8333-333333333333", content: "# Engine\n\nSee [drawing](<../attachments/44444444-4444-4444-8444-444444444444/design%20v2.png>) and [[stable-note-id]].",
    tags: ["mechanical", "draft"], reminder: { at: "2026-02-01T12:00:00.000Z" }, createdAt: "2026-01-02T00:00:00.000Z", createdBy: actor }],
  tasks: [{ schema: "stash.task.v1", id: "55555555-5555-4555-8555-555555555555", workspaceId,
    projectId: "33333333-3333-4333-8333-333333333333", key: "LAB-7", keyAliases: [{ projectId: "66666666-6666-4666-8666-666666666666", key: "OLD-2" }],
    title: "Verify tolerances", status: { id: "77777777-7777-4777-8777-777777777777", name: "In Progress", category: "started" },
    sourceNoteIds: ["22222222-2222-4222-8222-222222222222"], sourceBlocks: [{ noteId: "22222222-2222-4222-8222-222222222222", blockId: "88888888-8888-4888-8888-888888888888" }],
    linkedNoteIds: ["22222222-2222-4222-8222-222222222222"], labelNames: ["hardware"], priority: "high", dueDate: "2026-02-05", estimate: 3,
    dependencies: [{ taskId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", type: "depends_on" }],
    developmentLinks: [{ provider: "github", kind: "pull_request", url: "https://github.example/p/7" }], createdAt: "2026-01-03T00:00:00.000Z", createdBy: actor }],
  boards: [{ schema: "stash.board.v1", id: "12121212-1212-4212-8212-121212121212", projectId: "33333333-3333-4333-8333-333333333333",
    name: "Delivery", groupBy: "status", createdAt: "2026-01-03T01:00:00.000Z" }],
  attachments: [{ projection: { schema: "stash.attachment.v1", id: "44444444-4444-4444-8444-444444444444", workspaceId,
    filename: "design v2.png", contentType: "image/png", size: 7, relativePath: "./attachments/44444444-4444-4444-8444-444444444444/design%20v2.png", source: "upload", createdAt: "2026-01-04T00:00:00.000Z", createdBy: actor }, content: Buffer.from([0, 1, 2, 3, 255, 4, 5]) }],
  noteLocations: [{ schema: "stash.note-location.v1", noteId: "22222222-2222-4222-8222-222222222222", workspaceId,
    path: "notes/engine.md", aliases: ["drafts/engine.md"], revision: 2 }],
  noteLinks: [{ schema: "stash.note-link.v2", id: "99999999-9999-4999-8999-999999999999", workspaceId,
    sourceNoteId: "22222222-2222-4222-8222-222222222222", targetNoteId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    label: "Decision", revision: 1 }],
};

function unzipStored(archive: Buffer): Map<string, Buffer> {
  const files = new Map<string, Buffer>(); let offset = 0;
  while (offset + 30 <= archive.length && archive.readUInt32LE(offset) === 0x04034b50) {
    const nameLength = archive.readUInt16LE(offset + 26); const extraLength = archive.readUInt16LE(offset + 28);
    const size = archive.readUInt32LE(offset + 18); const start = offset + 30 + nameLength + extraLength;
    files.set(archive.subarray(offset + 30, offset + 30 + nameLength).toString("utf8"), archive.subarray(start, start + size));
    offset = start + size;
  }
  return files;
}

class ExportDatabase implements DatabaseProbe, PortableWorkspaceExportRepository {
  fail = false;
  async verifyConnection() {} async close() {}
  async readExportSnapshot(memberId: string, requestedWorkspaceId: string) {
    if (this.fail) throw new Error("storage unavailable");
    if (requestedWorkspaceId === secretWorkspaceId || memberId !== "ada") return { status: "workspace_forbidden" as const };
    if (requestedWorkspaceId !== workspaceId) return { status: "workspace_not_found" as const };
    return { status: "found" as const, snapshot };
  }
}
const access: MemberAccessResolver = { async authenticateBearer(value) { return value === "Bearer member-ada" ? { accountId: "ada", sessionId: "s" }
  : value === "Bearer member-grace" ? { accountId: "grace", sessionId: "g" } : undefined; } };

describe("readable Portable Workspace Export", () => {
  let instance: RunningInstance | undefined;
  afterEach(async () => { await instance?.close(); instance = undefined; });
  async function run() { const database = new ExportDatabase(); instance = await startInstance({ database, host: "127.0.0.1", port: 0,
    instanceAdminToken: "admin", memberAccess: access, portableWorkspaceExports: new PortableWorkspaceExportService(database) }); return { database, baseUrl: instance.url }; }

  it("exports readable Markdown, exact Attachment bytes, metadata and a deterministic checksummed manifest", async () => {
    const { baseUrl } = await run();
    const first = await fetch(`${baseUrl}/api/workspaces/${workspaceId}/export`, { headers: { authorization: "Bearer member-ada" } });
    assert.equal(first.status, 200); assert.equal(first.headers.get("content-type"), "application/zip");
    assert.match(first.headers.get("content-disposition") ?? "", /stash-workspace-11111111.*\.zip/);
    const archive = Buffer.from(await first.arrayBuffer()); const files = unzipStored(archive);
    assert.deepEqual([...files.keys()], [
      "README.md", "attachments/44444444-4444-4444-8444-444444444444/design%20v2.png",
      "boards/12121212-1212-4212-8212-121212121212.json", "manifest.json",
      "notes/22222222-2222-4222-8222-222222222222.md", "relationships/note-links.json",
      "relationships/note-locations.json", "tasks/LAB-7--55555555-5555-4555-8555-555555555555.md",
    ]);
    assert.deepEqual(files.get("attachments/44444444-4444-4444-8444-444444444444/design%20v2.png"), snapshot.attachments[0]!.content);
    const note = files.get("notes/22222222-2222-4222-8222-222222222222.md")!.toString();
    assert.match(note, /schema: "stash.note.v1"/); assert.match(note, /projectId: "33333333/); assert.match(note, /\[drawing\]\(<\.\.\/attachments\//); assert.match(note, /\[\[stable-note-id\]\]/);
    const task = files.get("tasks/LAB-7--55555555-5555-4555-8555-555555555555.md")!.toString();
    assert.match(task, /# LAB-7 — Verify tolerances/); assert.match(task, /keyAliases:/); assert.match(task, /OLD-2/); assert.match(task, /sourceBlocks:/); assert.match(task, /depends_on/);
    const taskMetadata = Object.fromEntries(task.slice(4, task.indexOf("\n---", 4)).split("\n").map((line) => {
      const separator = line.indexOf(": "); return [line.slice(0, separator), JSON.parse(line.slice(separator + 2)) as unknown];
    }));
    assert.deepEqual(taskMetadata, snapshot.tasks[0]);
    assert.deepEqual(JSON.parse(files.get("boards/12121212-1212-4212-8212-121212121212.json")!.toString()), snapshot.boards[0]);
    assert.deepEqual(JSON.parse(files.get("relationships/note-locations.json")!.toString()), snapshot.noteLocations);
    assert.deepEqual(JSON.parse(files.get("relationships/note-links.json")!.toString()), snapshot.noteLinks);
    const manifest = JSON.parse(files.get("manifest.json")!.toString()) as { schema: string; workspace: object; files: Array<{ path: string; sha256: string; bytes: number }> };
    assert.equal(manifest.schema, "stash.portable-workspace-export.v1"); assert.deepEqual(manifest.workspace, snapshot.workspace);
    assert.equal(manifest.files.some(({ path }) => path === "manifest.json"), false);
    for (const entry of manifest.files) { const content = files.get(entry.path)!; assert.equal(entry.bytes, content.length); assert.equal(entry.sha256, createHash("sha256").update(content).digest("hex")); }
    const second = await fetch(`${baseUrl}/api/workspaces/${workspaceId}/export`, { headers: { authorization: "Bearer member-ada" } });
    assert.deepEqual(Buffer.from(await second.arrayBuffer()), archive);
  });

  it("makes authentication, permission, invalid input, absence, and recoverable failures visible without partial archives", async () => {
    const { baseUrl, database } = await run(); const path = `/api/workspaces/${workspaceId}/export`;
    assert.equal((await fetch(`${baseUrl}${path}`)).status, 401);
    const forbidden = await fetch(`${baseUrl}/api/workspaces/${secretWorkspaceId}/export`, { headers: { authorization: "Bearer member-ada" } });
    assert.equal(forbidden.status, 403); assert.doesNotMatch(await forbidden.text(), /secret|note|task|attachment/i);
    assert.equal((await fetch(`${baseUrl}/api/workspaces/invalid/export`, { headers: { authorization: "Bearer member-ada" } })).status, 422);
    assert.equal((await fetch(`${baseUrl}/api/workspaces/eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee/export`, { headers: { authorization: "Bearer member-ada" } })).status, 404);
    database.fail = true; const failed = await fetch(`${baseUrl}${path}`, { headers: { authorization: "Bearer member-ada" } });
    assert.equal(failed.status, 503); assert.equal(failed.headers.get("content-type"), "application/json; charset=utf-8"); assert.deepEqual(await failed.json(), { error: "export_unavailable", message: "The Workspace export could not be completed. No partial export was produced." });
  });

  it("rejects text-heavy archives before buffering entries and bounds actual filesystem reads", async () => {
    const textHeavy: PortableWorkspaceExportSnapshot = { ...snapshot, attachments: [], tasks: [],
      notes: [{ ...snapshot.notes[0]!, content: "x".repeat(2_000) }] };
    const repository: PortableWorkspaceExportRepository = { async readExportSnapshot() { return { status: "found", snapshot: textHeavy }; } };
    await assert.rejects(() => new PortableWorkspaceExportService(repository, undefined, { maxArchiveBytes: 1_024 }).export("ada", workspaceId),
      PortableWorkspaceExportTooLarge);

    const directory = await mkdtemp(join(tmpdir(), "stash-export-bounded-")); const storage = new LocalAttachmentStorage(directory);
    const attachment = snapshot.attachments[0]!.projection; const storageKey = `${workspaceId}/${attachment.id}`;
    await storage.put(storageKey, Buffer.from("actual bytes exceed declared size"));
    const mismatched: PortableWorkspaceExportSnapshot = { ...snapshot, notes: [], tasks: [],
      attachments: [{ projection: { ...attachment, size: 4 }, storageKey }] };
    const mismatchRepository: PortableWorkspaceExportRepository = { async readExportSnapshot() { return { status: "found", snapshot: mismatched }; } };
    await assert.rejects(() => new PortableWorkspaceExportService(mismatchRepository, storage).export("ada", workspaceId), /attachment_size_limit/);
  });

  it("writes a valid ZIP64 directory when a large Workspace exceeds the classic entry-count limit", async () => {
    const notes = Array.from({ length: 65_534 }, (_, index) => ({
      schema: "stash.note.v1" as const,
      id: `00000000-0000-4000-8000-${index.toString(16).padStart(12, "0")}`,
      workspaceId, content: "x", tags: [], createdAt: "2026-01-01T00:00:00.000Z", createdBy: actor,
    }));
    const largeSnapshot: PortableWorkspaceExportSnapshot = { ...snapshot, notes, tasks: [], attachments: [] };
    const repository: PortableWorkspaceExportRepository = { async readExportSnapshot() { return { status: "found", snapshot: largeSnapshot }; } };
    const outcome = await new PortableWorkspaceExportService(repository).export("ada", workspaceId);
    assert.equal(outcome.status, "exported"); if (outcome.status !== "exported") return;
    const { archive } = outcome; const classicEnd = archive.length - 22; const locator = classicEnd - 20; const zip64End = locator - 56;
    assert.equal(archive.readUInt32LE(classicEnd), 0x06054b50); assert.equal(archive.readUInt16LE(classicEnd + 8), 0xffff);
    assert.equal(archive.readUInt32LE(locator), 0x07064b50); assert.equal(Number(archive.readBigUInt64LE(locator + 8)), zip64End);
    assert.equal(archive.readUInt32LE(zip64End), 0x06064b50); assert.equal(archive.readBigUInt64LE(zip64End + 24), 65_539n);
    assert.equal(archive.readBigUInt64LE(zip64End + 32), 65_539n);
    const directoryOffset = Number(archive.readBigUInt64LE(zip64End + 48));
    assert.equal(archive.readUInt32LE(directoryOffset), 0x02014b50);
  });
});

const postgresUrl = process.env.STASH_TEST_DATABASE_URL;
describe("PostgreSQL readable export wiring", { skip: postgresUrl ? false : "STASH_TEST_DATABASE_URL is not configured" }, () => {
  it("serves a real permission-filtered snapshot with filesystem Attachment bytes", async () => {
    const connectionString = postgresUrl!;
    const administration = new Pool({ connectionString }); const schema = `export_${randomUUID().replaceAll("-", "")}`;
    await administration.query(`CREATE SCHEMA ${schema}`);
    const separator = connectionString.includes("?") ? "&" : "?";
    const database = new PostgresDatabase(`${connectionString}${separator}options=-csearch_path%3D${schema}`,
      createAuthenticationSecretCodec(randomBytes(32).toString("base64")));
    const storage = new LocalAttachmentStorage(await mkdtemp(join(tmpdir(), "stash-export-integration-")));
    let running: RunningInstance | undefined;
    try {
      const ownerId = "10101010-1010-4010-8010-101010101010"; const guestId = "20202020-2020-4020-8020-202020202020";
      const organizationId = "30303030-3030-4030-8030-303030303030";
      await database.createFirstOrganizationOwner({ organizationId, organizationName: "Lab", ownerId, ownerName: "Ada",
        ownerEmail: "ada@example.test", passwordHash: "test-only", role: "Owner" });
      const workspaces = new WorkspaceProjectService(database);
      const createdWorkspace = await workspaces.createWorkspace(ownerId, { name: "Portable", owner: { type: "organization", organizationId } });
      assert.equal(createdWorkspace.status, "created"); if (createdWorkspace.status !== "created") return;
      const firstProject = await workspaces.createProject(ownerId, createdWorkspace.workspace.id, { name: "Visible", key: "VIS" });
      const secondProject = await workspaces.createProject(ownerId, createdWorkspace.workspace.id, { name: "Private", key: "SEC" });
      assert.equal(firstProject.status, "created"); assert.equal(secondProject.status, "created");
      if (firstProject.status !== "created" || secondProject.status !== "created") return;
      const attachments = new AttachmentService(database, storage);
      const uploaded = await attachments.create(ownerId, createdWorkspace.workspace.id,
        { filename: "proof.bin", contentType: "application/octet-stream", source: "upload", content: Buffer.from([9, 8, 7, 6]) });
      assert.equal(uploaded.status, "created"); if (uploaded.status !== "created") return;
      const notes = new NoteService(database);
      const visibleNote = await notes.capture(ownerId, createdWorkspace.workspace.id, { projectId: firstProject.project.id,
        content: `[proof.bin](<${portableAttachmentHref(uploaded.record.relativePath)}>)` });
      const privateNote = await notes.capture(ownerId, createdWorkspace.workspace.id, { projectId: secondProject.project.id, content: "Private roadmap" });
      assert.equal(visibleNote.status, "created"); assert.equal(privateNote.status, "created");
      if (visibleNote.status !== "created" || privateNote.status !== "created") return;
      const mobileNote = await new MobileCaptureService(database).capture(ownerId, createdWorkspace.workspace.id, {
        protocol: "stash.mobile-capture.v1", id: randomUUID(), kind: "text", content: "Captured away from desk",
        createdAt: "2026-08-23T12:00:00.000Z",
      });
      assert.equal(mobileNote.status, "created");
      const discussions = new DiscussionService(database);
      const discussion = await discussions.create(ownerId, { target: { kind: "note", noteId: visibleNote.note.id }, message: "Preserve this" });
      assert.equal(discussion.status, "created"); if (discussion.status !== "created") return;
      const discussionNote = await discussions.createWork(ownerId, discussion.discussion.id, { kind: "note",
        messageIds: [discussion.discussion.messages[0]!.id], idempotencyKey: randomUUID() });
      assert.equal(discussionNote.status, "created");
      const noteLinks = new NoteLinkService(database);
      const linked = await noteLinks.create(ownerId, visibleNote.note.id, { targetNoteId: privateNote.note.id, label: "Private roadmap" });
      assert.equal(linked.status, "created");
      const moved = await noteLinks.move(ownerId, privateNote.note.id, { expectedRevision: 1, path: "private/roadmap.md" });
      assert.equal(moved.status, "moved");
      const samePath = await noteLinks.move(ownerId, privateNote.note.id, { expectedRevision: 2, path: "private/roadmap.md" });
      assert.equal(samePath.status, "unchanged"); assert.equal(samePath.location.revision, 2);
      const tasks = new TaskService(database, database);
      const visibleBlockKey = visibleNote.note.document.blocks[0]?.blockKey; const privateBlockKey = privateNote.note.document.blocks[0]?.blockKey;
      assert.ok(visibleBlockKey); assert.ok(privateBlockKey);
      await tasks.createFromBlock(ownerId, visibleNote.note.id, visibleBlockKey,
        { projectId: firstProject.project.id, title: "Visible Task" });
      await tasks.createFromBlock(ownerId, privateNote.note.id, privateBlockKey,
        { projectId: secondProject.project.id, title: "Private Task" });
      const boards = new BoardService(database);
      const visibleBoard = await boards.create(ownerId, firstProject.project.id, { name: "Visible board", groupBy: "status" });
      const privateBoard = await boards.create(ownerId, secondProject.project.id, { name: "Private board", groupBy: "priority" });
      assert.equal(visibleBoard.status, "created"); assert.equal(privateBoard.status, "created");
      const setup = new Pool({ connectionString: `${connectionString}${separator}options=-csearch_path%3D${schema}` });
      await setup.query("INSERT INTO stash_accounts (id,name,email,password_hash) VALUES ($1,'Grace','grace@example.test','test')", [guestId]);
      await setup.query("INSERT INTO stash_project_guests (project_id,account_id) VALUES ($1,$2)", [firstProject.project.id, guestId]);
      await setup.end();
      const memberAccess: MemberAccessResolver = { async authenticateBearer(value) { return value === "Bearer owner" ? { accountId: ownerId, sessionId: "owner" }
        : value === "Bearer guest" ? { accountId: guestId, sessionId: "guest" } : undefined; } };
      running = await startInstance({ database, host: "127.0.0.1", port: 0, instanceAdminToken: "admin", memberAccess,
        portableWorkspaceExports: new PortableWorkspaceExportService(database, storage) });
      const ownerFiles = unzipStored(Buffer.from(await (await fetch(`${running.url}/api/workspaces/${createdWorkspace.workspace.id}/export`,
        { headers: { authorization: "Bearer owner" } })).arrayBuffer()));
      assert.equal([...ownerFiles.keys()].filter((path) => path.startsWith("notes/")).length, 4);
      assert.equal([...ownerFiles.keys()].filter((path) => path.startsWith("tasks/")).length, 2);
      assert.equal([...ownerFiles.keys()].filter((path) => path.startsWith("boards/")).length, 2);
      const ownerLocations = JSON.parse(ownerFiles.get("relationships/note-locations.json")!.toString()) as any[];
      const ownerLinks = JSON.parse(ownerFiles.get("relationships/note-links.json")!.toString()) as any[];
      assert.equal(ownerLocations.length, 4); assert.equal(ownerLinks.length, 1);
      assert.equal(ownerLocations.find(({ noteId }) => noteId === privateNote.note.id)?.path, "private/roadmap.md");
      const guestFiles = unzipStored(Buffer.from(await (await fetch(`${running.url}/api/workspaces/${createdWorkspace.workspace.id}/export`,
        { headers: { authorization: "Bearer guest" } })).arrayBuffer()));
      assert.equal([...guestFiles.keys()].filter((path) => path.startsWith("notes/")).length, 1);
      assert.equal([...guestFiles.keys()].filter((path) => path.startsWith("tasks/")).length, 1);
      assert.equal([...guestFiles.keys()].filter((path) => path.startsWith("boards/")).length, 1);
      assert.equal([...guestFiles.values()].some((value) => value.includes("Private board")), false);
      const guestLocations = JSON.parse(guestFiles.get("relationships/note-locations.json")!.toString()) as any[];
      const guestLinks = JSON.parse(guestFiles.get("relationships/note-links.json")!.toString()) as any[];
      assert.deepEqual(guestLocations.map(({ noteId }) => noteId), [visibleNote.note.id]); assert.deepEqual(guestLinks, []);
      assert.equal([...guestFiles.values()].some((value) => value.includes("Private roadmap")), false);
      assert.deepEqual(guestFiles.get(uploaded.record.relativePath.slice(2)), Buffer.from([9, 8, 7, 6]));
      const corrupt = new Pool({ connectionString: `${connectionString}${separator}options=-csearch_path%3D${schema}` });
      await corrupt.query("DELETE FROM stash_portable_projection_outbox WHERE object_kind = 'Note' AND object_id = $1", [visibleNote.note.id]);
      await corrupt.end();
      const incomplete = await fetch(`${running.url}/api/workspaces/${createdWorkspace.workspace.id}/export`,
        { headers: { authorization: "Bearer owner" } });
      assert.equal(incomplete.status, 503); assert.equal(incomplete.headers.get("content-type"), "application/json; charset=utf-8");
      assert.deepEqual(await incomplete.json(), { error: "export_unavailable", message: "The Workspace export could not be completed. No partial export was produced." });
    } finally {
      await running?.close().catch(() => undefined); if (!running) await database.close().catch(() => undefined);
      await administration.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`).catch(() => undefined); await administration.end();
    }
  });
});
