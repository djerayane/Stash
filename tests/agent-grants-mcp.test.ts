import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { AgentGrantService, type AgentGrant, type AgentGrantRepository, type StoredAgentGrant } from "../src/agent-grants.js";
import { startInstance, type DatabaseProbe, type RunningInstance } from "../src/instance.js";
import type { MemberAccessResolver } from "../src/workspaces-projects.js";

const organizationId = "11111111-1111-4111-8111-111111111111";
class RepositoryFake implements AgentGrantRepository {
  grants: StoredAgentGrant[] = [];
  async createAgentGrant(actorId: string, grant: StoredAgentGrant) { if (actorId !== "member" || grant.organizationId !== organizationId) return "forbidden" as const; this.grants.push(grant); return "created" as const; }
  async listAgentGrants(actorId: string, organization: string) { return actorId === "member" && organization === organizationId ? this.grants.map(({ tokenLookup: _, tokenHash: __, ...grant }) => grant) : undefined; }
  async revokeAgentGrant(actorId: string, organization: string, id: string) { const grant = this.grants.find((candidate) => candidate.id === id && candidate.organizationId === organization); if (!grant) return "not_found" as const; if (grant.sponsoringMemberId !== actorId) return "forbidden" as const; grant.revokedAt = new Date().toISOString(); return "revoked" as const; }
  async findActiveAgentGrant(lookup: string) { return this.grants.find((grant) => grant.tokenLookup === lookup && !grant.revokedAt); }
}
const access: MemberAccessResolver = { async authenticateBearer(value) { return value === "Bearer member-session" ? { accountId: "member", sessionId: "session" } : value === "Bearer other-session" ? { accountId: "other", sessionId: "other" } : undefined; } };
const database: DatabaseProbe = { async verifyConnection() {}, async close() {} };

describe("Agent Grants and MCP", () => {
  let instance: RunningInstance | undefined;
  afterEach(async () => { await instance?.close(); instance = undefined; });
  async function run(enabled = true) { const repository = new RepositoryFake(); const service = new AgentGrantService(repository, () => new Date("2026-08-23T10:00:00.000Z"));
    instance = await startInstance({ database, host: "127.0.0.1", port: 0, instanceAdminToken: "admin", memberAccess: access, agentGrants: service, mcpEnabled: enabled }); return repository; }
  async function issue(scopes: Array<{ capability: string; mode: "direct" | "propose" | "deny" }>, session = "member-session") {
    const response = await fetch(`${instance!.url}/api/v1/organizations/${organizationId}/agent-grants`, { method: "POST", headers: { authorization: `Bearer ${session}`, "content-type": "application/json" },
      body: JSON.stringify({ organizationId, name: "Planning assistant", expiresAt: "2026-09-01T10:00:00.000Z", scopes }) });
    return { response, body: await response.json() as { grant: AgentGrant; token: string; error?: string } };
  }

  it("is disabled by default and never accepts a Member session as an agent credential", async () => {
    await run(false);
    const disabled = await fetch(`${instance!.url}/mcp`, { method: "POST", headers: { authorization: "Bearer member-session", "content-type": "application/json" }, body: "{}" });
    assert.equal(disabled.status, 404);
    await instance!.close(); instance = undefined; await run(true);
    const denied = await fetch(`${instance!.url}/mcp`, { method: "POST", headers: { authorization: "Bearer member-session", "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }) });
    assert.equal(denied.status, 401);
  });

  it("issues a credential once and exposes only non-denied scoped MCP tools with their confirmation policy", async () => {
    await run(); const { response, body } = await issue([{ capability: "workspace.read", mode: "direct" }, { capability: "note.write", mode: "propose" }, { capability: "task.write", mode: "deny" }]);
    assert.equal(response.status, 201); assert.match(body.token, /^stash_agent_/); assert.equal("token" in body.grant, false);
    const tools = await fetch(`${instance!.url}/mcp`, { method: "POST", headers: { authorization: `Bearer ${body.token}`, "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }) });
    const toolsBody = await tools.json() as any; assert.deepEqual(toolsBody.result.tools.map((tool: any) => tool.name), ["stash.workspace.read", "stash.note.write"]);
    const proposal = await fetch(`${instance!.url}/mcp`, { method: "POST", headers: { authorization: `Bearer ${body.token}`, "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "stash.note.write", arguments: {} } }) });
    assert.equal((await proposal.json() as any).result.structuredContent.mode, "propose");
    const denied = await fetch(`${instance!.url}/mcp`, { method: "POST", headers: { authorization: `Bearer ${body.token}`, "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "stash.task.write" } }) });
    assert.equal((await denied.json() as any).error.code, -32003);
  });

  it("enforces sponsorship, validation, expiry, and immediate revocation without leaking credentials", async () => {
    const repository = await run(); const forbidden = await issue([{ capability: "workspace.read", mode: "direct" }], "other-session"); assert.equal(forbidden.response.status, 403);
    const invalid = await fetch(`${instance!.url}/api/organizations/${organizationId}/agent-grants`, { method: "POST", headers: { authorization: "Bearer member-session", "content-type": "application/json" }, body: JSON.stringify({ organizationId, name: "", expiresAt: "never", scopes: [] }) }); assert.equal(invalid.status, 422);
    const { body } = await issue([{ capability: "workspace.read", mode: "direct" }]);
    const listed = await fetch(`${instance!.url}/api/organizations/${organizationId}/agent-grants`, { headers: { authorization: "Bearer member-session" } }); const listedText = await listed.text(); assert.doesNotMatch(listedText, /stash_agent_|tokenHash|tokenLookup/);
    const revoke = await fetch(`${instance!.url}/api/organizations/${organizationId}/agent-grants/${body.grant.id}`, { method: "DELETE", headers: { authorization: "Bearer member-session" } }); assert.equal(revoke.status, 200); assert.ok(repository.grants[0]?.revokedAt);
    const after = await fetch(`${instance!.url}/mcp`, { method: "POST", headers: { authorization: `Bearer ${body.token}`, "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 4, method: "tools/list" }) }); assert.equal(after.status, 401);
  });
});
