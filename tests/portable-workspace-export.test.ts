import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { afterEach, describe, it } from "node:test";

import { startInstance, type DatabaseProbe, type RunningInstance } from "../src/instance.js";
import {
  PortableWorkspaceExportService,
  type PortableWorkspaceExportRepository,
  type PortableWorkspaceExportSnapshot,
} from "../src/portable-workspace-export.js";
import type { MemberAccessResolver } from "../src/workspaces-projects.js";

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
  attachments: [{ projection: { schema: "stash.attachment.v1", id: "44444444-4444-4444-8444-444444444444", workspaceId,
    filename: "design v2.png", contentType: "image/png", size: 7, relativePath: "./attachments/44444444-4444-4444-8444-444444444444/design%20v2.png", source: "upload", createdAt: "2026-01-04T00:00:00.000Z", createdBy: actor }, content: Buffer.from([0, 1, 2, 3, 255, 4, 5]) }],
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
      "README.md", "attachments/44444444-4444-4444-8444-444444444444/design%20v2.png", "manifest.json",
      "notes/22222222-2222-4222-8222-222222222222.md", "tasks/LAB-7--55555555-5555-4555-8555-555555555555.md",
    ]);
    assert.deepEqual(files.get("attachments/44444444-4444-4444-8444-444444444444/design%20v2.png"), snapshot.attachments[0]!.content);
    const note = files.get("notes/22222222-2222-4222-8222-222222222222.md")!.toString();
    assert.match(note, /schema: "stash.note.v1"/); assert.match(note, /projectId: "33333333/); assert.match(note, /\[drawing\]\(<\.\.\/attachments\//); assert.match(note, /\[\[stable-note-id\]\]/);
    const task = files.get("tasks/LAB-7--55555555-5555-4555-8555-555555555555.md")!.toString();
    assert.match(task, /# LAB-7 — Verify tolerances/); assert.match(task, /keyAliases:/); assert.match(task, /OLD-2/); assert.match(task, /sourceBlocks:/); assert.match(task, /depends_on/);
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
});
