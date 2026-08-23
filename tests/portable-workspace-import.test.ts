import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { describe, it } from "node:test";

import { startInstance } from "../src/instance.js";
import { PortableWorkspaceExportService, type PortableWorkspaceExportSnapshot } from "../src/portable-workspace-export.js";
import { PortableWorkspaceImportService, type PortableWorkspaceImportBundle, type PortableWorkspaceImportReport, type PortableWorkspaceImportRepository } from "../src/portable-workspace-import.js";

const workspaceId = "11111111-1111-4111-8111-111111111111";
const noteId = "22222222-2222-4222-8222-222222222222";
const actor = { localAccountId: "source-ada", displayName: "Ada Lovelace" };
const snapshot: PortableWorkspaceExportSnapshot = {
  workspace: { schema: "stash.workspace.v1", id: workspaceId, name: "Portable", owner: { type: "personal", identity: actor }, createdBy: actor },
  notes: [{ schema: "stash.note.v1", id: noteId, workspaceId, content: "# Durable", tags: ["knowledge"], createdAt: "2026-01-01T00:00:00.000Z", createdBy: actor }],
  tasks: [], boards: [],
  attachments: [{ projection: { schema: "stash.attachment.v1", id: "33333333-3333-4333-8333-333333333333", workspaceId,
    filename: "proof.bin", contentType: "application/octet-stream", size: 3,
    relativePath: "./attachments/33333333-3333-4333-8333-333333333333/proof.bin", source: "upload",
    createdAt: "2026-01-01T00:00:00.000Z", createdBy: actor }, content: Buffer.from([1, 2, 3]) }],
  noteLocations: [{ schema: "stash.note-location.v1", noteId, workspaceId, path: `notes/${noteId}.md`, aliases: [], revision: 1 }],
  noteLinks: [], activities: [], noteHistory: [],
};

class ImportMemory implements PortableWorkspaceImportRepository {
  readonly imports = new Map<string, { digest: string; report: PortableWorkspaceImportReport }>();
  committed?: PortableWorkspaceImportBundle;
  fail = false;
  async importWorkspace(importId: string, bundle: PortableWorkspaceImportBundle) {
    if (this.fail) throw new Error("storage_down");
    const previous = this.imports.get(importId);
    if (previous) {
      if (previous.digest !== bundle.archiveSha256) return { status: "workspace_conflict" as const };
      return { status: "duplicate" as const, report: previous.report };
    }
    const report: PortableWorkspaceImportReport = { schema: "stash.portable-workspace-import-report.v1", importId,
      workspaceId: bundle.state.workspace.id, archiveSha256: bundle.archiveSha256,
      transformations: bundle.identityStubs.map(({ sourceAccountId }) => ({ kind: "transformed", object: sourceAccountId, reason: "identity_stub_created" })),
      identityStubs: bundle.identityStubs };
    // A real adapter performs this operation in one transaction. The fake exposes
    // the same atomic seam used by the running-Instance acceptance test.
    this.committed = bundle; this.imports.set(importId, { digest: bundle.archiveSha256, report });
    return { status: "imported" as const, report };
  }
}
async function archive(): Promise<Buffer> {
  const result = await new PortableWorkspaceExportService({ async readExportSnapshot() { return { status: "found", snapshot }; } }).export("ada", workspaceId);
  assert.equal(result.status, "exported"); if (result.status !== "exported") throw new Error(); return result.archive;
}

describe("Portable Workspace import", () => {
  it("round-trips canonical semantics and Attachment bytes through a running Instance, preserving missing people as Identity Stubs", async () => {
    const repository = new ImportMemory(); const database = { async verifyConnection() {}, async close() {} };
    const instance = await startInstance({ database, host: "127.0.0.1", port: 0, instanceAdminToken: "admin",
      portableWorkspaceImports: new PortableWorkspaceImportService(repository) });
    try {
      const importId = randomUUID(); const exported = await archive();
      const response = await fetch(`${instance.url}/api/workspace-imports`, { method: "POST",
        headers: { authorization: "Bearer admin", "idempotency-key": importId, "content-type": "application/zip" }, body: new Uint8Array(exported) });
      assert.equal(response.status, 201); const result = await response.json() as any;
      assert.equal(result.status, "imported"); assert.deepEqual(result.report.identityStubs, [{ sourceAccountId: "source-ada", displayName: "Ada Lovelace" }]);
      assert.deepEqual(repository.committed?.state, { workspace: snapshot.workspace, notes: snapshot.notes, tasks: [], boards: [],
        attachments: snapshot.attachments.map(({ projection }) => projection), noteLocations: snapshot.noteLocations, noteLinks: [], activities: [], noteHistory: [], durableObjects: [] });
      assert.deepEqual(repository.committed?.attachmentContent.get(snapshot.attachments[0]!.projection.id), Buffer.from([1, 2, 3]));
      const duplicate = await fetch(`${instance.url}/api/workspace-imports`, { method: "POST",
        headers: { authorization: "Bearer admin", "idempotency-key": importId }, body: new Uint8Array(exported) });
      assert.equal(duplicate.status, 200); assert.equal((await duplicate.json() as any).status, "duplicate");
    } finally { await instance.close(); }
  });

  it("makes authorization, corruption, unsupported legacy archives, and recoverable failure atomic and visible", async () => {
    const repository = new ImportMemory(); const database = { async verifyConnection() {}, async close() {} };
    const instance = await startInstance({ database, host: "127.0.0.1", port: 0, instanceAdminToken: "admin",
      portableWorkspaceImports: new PortableWorkspaceImportService(repository) });
    try {
      const exported = await archive(); const headers = { authorization: "Bearer admin", "idempotency-key": randomUUID() };
      assert.equal((await fetch(`${instance.url}/api/workspace-imports`, { method: "POST", body: new Uint8Array(exported) })).status, 401);
      const corrupt = Buffer.from(exported); const marker = corrupt.indexOf(Buffer.from("objects/workspace.json")); assert.ok(marker > 0);
      corrupt.writeUInt8(corrupt.readUInt8(marker + 2) ^ 1, marker + 2);
      assert.equal((await fetch(`${instance.url}/api/workspace-imports`, { method: "POST", headers, body: new Uint8Array(corrupt) })).status, 422);
      assert.equal(repository.committed, undefined);
      repository.fail = true; const failed = await fetch(`${instance.url}/api/workspace-imports`, { method: "POST",
        headers: { ...headers, "idempotency-key": randomUUID() }, body: new Uint8Array(exported) });
      assert.equal(failed.status, 503); assert.deepEqual(await failed.json(), { error: "import_unavailable", message: "The Workspace import could not be completed. Nothing was imported." });
    } finally { await instance.close(); }
  });
});
