import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";

import { AttachmentService, LocalAttachmentStorage, type AttachmentRecord, type AttachmentRepository, type PortableAttachmentProjection } from "../src/attachments.js";
import { startInstance, type DatabaseProbe, type RunningInstance } from "../src/instance.js";
import type { MemberAccessResolver } from "../src/workspaces-projects.js";

const workspaceId = "11111111-1111-4111-8111-111111111111";
class AttachmentDatabase implements DatabaseProbe, AttachmentRepository {
  records = new Map<string, AttachmentRecord>(); projections: PortableAttachmentProjection[] = [];
  fail = false;
  async verifyConnection() {} async close() {}
  async findPortableMemberIdentity(memberId: string) { return memberId === "ada" ? { localAccountId: "ada", displayName: "Ada Lovelace" } : undefined; }
  async createAttachment(memberId: string, record: AttachmentRecord, projection: PortableAttachmentProjection) {
    if (memberId !== "ada" || record.workspaceId !== workspaceId) return "workspace_forbidden" as const;
    if (this.fail) throw new Error("database unavailable");
    this.records.set(record.id, record); this.projections.push(projection); return "created" as const;
  }
  async findAttachmentForMember(memberId: string, id: string) { return memberId === "ada" ? this.records.get(id) : undefined; }
}
const access: MemberAccessResolver = { async authenticateBearer(value) { return value === "Bearer member-ada" ? { accountId: "ada", sessionId: "s" } : value === "Bearer member-grace" ? { accountId: "grace", sessionId: "g" } : undefined; } };

describe("Workspace Attachments", () => {
  let instance: RunningInstance | undefined;
  afterEach(async () => { await instance?.close(); instance = undefined; });
  async function run() {
    const directory = await mkdtemp(join(tmpdir(), "stash-attachments-")); const database = new AttachmentDatabase();
    instance = await startInstance({ database, host: "127.0.0.1", port: 0, instanceAdminToken: "admin", memberAccess: access,
      attachments: new AttachmentService(database, new LocalAttachmentStorage(directory), { maxBytes: 12 }) });
    return { database, directory, baseUrl: instance.url };
  }
  const upload = (baseUrl: string, token: string, body: string, filename = "design notes.txt", contentType = "text/plain") => fetch(`${baseUrl}/api/workspaces/${workspaceId}/attachments`, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": contentType, "x-stash-filename": filename, "x-stash-source": "paste" }, body });

  it("uploads pasted bytes, records a portable relative link, and serves them only to Workspace Members", async () => {
    const { baseUrl, database, directory } = await run();
    const response = await upload(baseUrl, "member-ada", "hello stash"); assert.equal(response.status, 201);
    const attachment = await response.json() as AttachmentRecord & { contentUrl: string; portableLink: string; portableProjection: object };
    assert.equal(attachment.source, "paste"); assert.equal(attachment.relativePath.startsWith("attachments/"), true);
    assert.equal(attachment.portableLink, `[design notes.txt](<${attachment.relativePath}>)`);
    assert.equal(await readFile(join(directory, workspaceId, attachment.id), "utf8"), "hello stash");
    assert.deepEqual(database.projections[0], { schema: "stash.attachment.v1", id: attachment.id, workspaceId, filename: "design notes.txt", contentType: "text/plain", size: 11, relativePath: attachment.relativePath, source: "paste", createdAt: attachment.createdAt, createdBy: { localAccountId: "ada", displayName: "Ada Lovelace" } });
    const served = await fetch(`${baseUrl}${attachment.contentUrl}`, { headers: { authorization: "Bearer member-ada" } });
    assert.equal(served.status, 200); assert.equal(served.headers.get("content-type"), "text/plain"); assert.equal(served.headers.get("x-content-type-options"), "nosniff"); assert.equal(await served.text(), "hello stash");
    assert.equal((await fetch(`${baseUrl}${attachment.contentUrl}`, { headers: { authorization: "Bearer member-grace" } })).status, 404);

    const uploaded = await fetch(`${baseUrl}/api/workspaces/${workspaceId}/attachments`, { method: "POST", headers: { authorization: "Bearer member-ada", "content-type": "application/pdf", "x-stash-filename": "brief.pdf" }, body: "%PDF" });
    assert.equal(uploaded.status, 201);
    assert.equal((await uploaded.json() as { source: string }).source, "upload");
  });

  it("rejects unsafe names, unsupported types, oversized bodies, and cleans stored bytes after metadata failure", async () => {
    const { baseUrl, database, directory } = await run();
    assert.equal((await upload(baseUrl, "member-ada", "x", "../secret.txt")).status, 422);
    assert.equal((await upload(baseUrl, "member-ada", "x", "script.html", "text/html")).status, 415);
    assert.equal((await upload(baseUrl, "member-ada", "1234567890123")).status, 413);
    database.fail = true; assert.equal((await upload(baseUrl, "member-ada", "retryable")).status, 503);
    await assert.rejects(readFile(join(directory, workspaceId, [...database.records.keys()][0] ?? "missing")));
  });
});
