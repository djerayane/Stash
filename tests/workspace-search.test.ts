import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";

import { startInstance, type DatabaseProbe, type RunningInstance } from "./support/start-test-instance.js";
import { InvalidWorkspaceSearchInput, WorkspaceSearchService, type WorkspaceSearchQuery, type WorkspaceSearchRepository } from "../src/workspace-search.js";

const workspaceId = "11111111-1111-4111-8111-111111111111";
const projectId = "22222222-2222-4222-8222-222222222222";

class SearchRepository implements WorkspaceSearchRepository {
  calls: Array<{ memberId: string; workspaceId: string; query: WorkspaceSearchQuery }> = [];
  async searchWorkspace(memberId: string, id: string, query: WorkspaceSearchQuery) {
    this.calls.push({ memberId, workspaceId: id, query });
    return { status: "found" as const,
      results: [{ id: "note-1", kind: "note" as const, title: "Release plan", href: "/app/notes/note-1" }],
      total: 1,
      facets: { kinds: [{ value: "note" as const, count: 1 }], projects: [{ value: projectId, count: 1 }], statuses: [{ value: "active", count: 1 }] } };
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
      assert.deepEqual(await response.json(), {
        results: [{ id: "note-1", kind: "note", title: "Release plan", href: "/app/notes/note-1" }],
        total: 1,
        facets: { kinds: [{ value: "note", count: 1 }], projects: [{ value: projectId, count: 1 }], statuses: [{ value: "active", count: 1 }] },
      });
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

    it("does not leak restricted matches through results, totals, facets, identifiers, or error shape", async () => {
      const restrictedProjectId = "33333333-3333-4333-8333-333333333333";
      const repository: WorkspaceSearchRepository = {
        async searchWorkspace(memberId, requestedWorkspaceId, query) {
          if (requestedWorkspaceId !== workspaceId) return { status: "forbidden" as const };
          if (query.projectId === restrictedProjectId && memberId === "guest") return { status: "forbidden" as const };
          const permitted = [{ id: "visible-note", kind: "note" as const, title: "Visible launch", projectId }];
          const restricted = [{ id: "restricted-note", kind: "note" as const, title: "Restricted launch", projectId: restrictedProjectId }];
          const results = memberId === "member" ? [...permitted, ...restricted] : permitted;
          return { status: "found" as const, results, total: results.length,
            facets: { kinds: [{ value: "note" as const, count: results.length }],
              projects: [...new Set(results.map((result) => result.projectId!))].map((value) => ({ value, count: results.filter((result) => result.projectId === value).length })),
              statuses: [] } };
        },
      };
      const guestAccess = { async authenticateBearer(value?: string) {
        if (value === "Bearer member-token") return { accountId: "member", sessionId: "member-session" };
        if (value === "Bearer guest-token") return { accountId: "guest", sessionId: "guest-session" };
        return undefined;
      } };
      instance = await startInstance({ database, host: "127.0.0.1", port: 0, instanceAdminToken: "admin", searches: new WorkspaceSearchService(repository), memberAccess: guestAccess });

      const member = await fetch(`${instance.url}/api/workspaces/${workspaceId}/search?q=launch`, { headers: { authorization: "Bearer member-token" } });
      const guest = await fetch(`${instance.url}/api/workspaces/${workspaceId}/search?q=launch`, { headers: { authorization: "Bearer guest-token" } });
      assert.equal(member.status, 200); assert.equal(guest.status, 200);
      const memberBody = await member.json(); const guestBody = await guest.json();
      assert.equal(memberBody.total, 2); assert.equal(guestBody.total, 1);
      assert.doesNotMatch(JSON.stringify(guestBody), /restricted-note|Restricted launch|33333333-3333-4333-8333-333333333333/);
      assert.deepEqual(guestBody.facets.projects, [{ value: projectId, count: 1 }]);

      const hiddenProject = await fetch(`${instance.url}/api/workspaces/${workspaceId}/search?q=launch&projectId=${restrictedProjectId}`, { headers: { authorization: "Bearer guest-token" } });
      const hiddenWorkspace = await fetch(`${instance.url}/api/workspaces/44444444-4444-4444-8444-444444444444/search?q=launch`, { headers: { authorization: "Bearer guest-token" } });
      assert.equal(hiddenProject.status, 404); assert.equal(hiddenWorkspace.status, 404);
      assert.deepEqual(await hiddenProject.json(), await hiddenWorkspace.json());
    });
  });
});
