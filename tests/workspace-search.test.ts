import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";

import { startInstance, type DatabaseProbe, type RunningInstance } from "../src/instance.js";
import { InvalidWorkspaceSearchInput, WorkspaceSearchService, type WorkspaceSearchQuery, type WorkspaceSearchRepository } from "../src/workspace-search.js";

const workspaceId = "11111111-1111-4111-8111-111111111111";
const projectId = "22222222-2222-4222-8222-222222222222";

class SearchRepository implements WorkspaceSearchRepository {
  calls: Array<{ memberId: string; workspaceId: string; query: WorkspaceSearchQuery }> = [];
  async searchWorkspace(memberId: string, id: string, query: WorkspaceSearchQuery) {
    this.calls.push({ memberId, workspaceId: id, query });
    return { status: "found" as const, results: [{ id: "note-1", kind: "note" as const, title: "Release plan", href: "/app/notes/note-1" }] };
  }
}

describe("Workspace search", () => {
  it("validates and normalizes its complete filter contract", async () => {
    const repository = new SearchRepository();
    const service = new WorkspaceSearchService(repository);
    await service.search("member", workspaceId, { q: "  Release  ", projectId, object: "Task", author: "Ada", assignee: "Grace", status: "Started", from: "2026-01-01", to: "2026-08-23" });
    assert.deepEqual(repository.calls[0], { memberId: "member", workspaceId, query: { q: "Release", projectId, object: "task", author: "Ada", assignee: "Grace", status: "Started", from: "2026-01-01T00:00:00.000Z", to: "2026-08-23T23:59:59.999Z" } });
    await assert.rejects(() => service.search("member", workspaceId, { q: "" }), InvalidWorkspaceSearchInput);
    await assert.rejects(() => service.search("member", workspaceId, { q: "x", object: "secret" }), InvalidWorkspaceSearchInput);
    await assert.rejects(() => service.search("member", workspaceId, { q: "x", from: "tomorrow" }), InvalidWorkspaceSearchInput);
  });

  describe("HTTP route", () => {
    let instance: RunningInstance | undefined;
    afterEach(async () => { await instance?.close(); });
    const database: DatabaseProbe = { async verifyConnection() {}, async close() {} };
    const access = { async authenticateBearer(value?: string) { return value === "Bearer member-token" ? { accountId: "member", sessionId: "session" } : undefined; } };

    it("requires a Member session and returns canonical results", async () => {
      const repository = new SearchRepository();
      instance = await startInstance({ database, host: "127.0.0.1", port: 0, instanceAdminToken: "admin", searches: new WorkspaceSearchService(repository), memberAccess: access });
      const unauthorized = await fetch(`${instance.url}/api/workspaces/${workspaceId}/search?q=release`);
      assert.equal(unauthorized.status, 401);
      const response = await fetch(`${instance.url}/api/workspaces/${workspaceId}/search?q=release&object=note`, { headers: { authorization: "Bearer member-token" } });
      assert.equal(response.status, 200);
      assert.deepEqual(await response.json(), { results: [{ id: "note-1", kind: "note", title: "Release plan", href: "/app/notes/note-1" }] });
      assert.equal(repository.calls[0]?.query.object, "note");
    });

    it("distinguishes invalid filters and hidden Workspaces", async () => {
      const repository: WorkspaceSearchRepository = { async searchWorkspace() { return { status: "forbidden" as const }; } };
      instance = await startInstance({ database, host: "127.0.0.1", port: 0, instanceAdminToken: "admin", searches: new WorkspaceSearchService(repository), memberAccess: access });
      const invalid = await fetch(`${instance.url}/api/workspaces/${workspaceId}/search?q=x&object=unknown`, { headers: { authorization: "Bearer member-token" } });
      assert.equal(invalid.status, 422);
      const hidden = await fetch(`${instance.url}/api/workspaces/${workspaceId}/search?q=x`, { headers: { authorization: "Bearer member-token" } });
      assert.equal(hidden.status, 404);
    });
  });
});
