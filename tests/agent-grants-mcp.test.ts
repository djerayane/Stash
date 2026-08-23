import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { AgentGrantService, type AgentGrant, type AgentGrantRepository, type StoredAgentGrant } from "../src/agent-grants.js";
import { startInstance, type DatabaseProbe, type RunningInstance } from "../src/instance.js";
import type { MemberAccessResolver } from "../src/workspaces-projects.js";
import { directAuthorityConfirmation } from "@stash/domain-types";
import { McpSessionStore } from "../src/mcp-route.js";

const organizationId = "11111111-1111-4111-8111-111111111111";
class RepositoryFake implements AgentGrantRepository {
  grants: StoredAgentGrant[] = [];
  proposals: import("../src/agent-grants.js").AgentProposal[] = [];
  directWrites: unknown[] = [];
  activities: unknown[] = [];
  operatorAudit: unknown[] = [];
  async createAgentGrant(actorId: string, grant: StoredAgentGrant) { if (actorId !== "member" || grant.organizationId !== organizationId) return "forbidden" as const; this.grants.push(grant); return "created" as const; }
  async listAgentGrants(actorId: string, organization: string) { return actorId === "member" && organization === organizationId ? this.grants.map(({ tokenLookup: _, tokenHash: __, ...grant }) => grant) : undefined; }
  async revokeAgentGrant(actorId: string, organization: string, id: string) { const grant = this.grants.find((candidate) => candidate.id === id && candidate.organizationId === organization); if (!grant) return "not_found" as const; if (grant.sponsoringMemberId !== actorId) return "forbidden" as const; grant.revokedAt ??= new Date().toISOString(); return "revoked" as const; }
  async findActiveAgentGrant(lookup: string) { return this.grants.find((grant) => grant.tokenLookup === lookup && !grant.revokedAt); }
  async agentGrantOptions(actorId: string) { return actorId === "member" ? [{ organizationId, organizationName: "Test Organization", projects: [] }] : []; }
  async createAgentProposal(proposal: import("../src/agent-grants.js").AgentProposal) { this.proposals.push(proposal); }
  async listAgentProposals(actorId: string, requestedOrganizationId: string) { return actorId === "member" && requestedOrganizationId === organizationId ? this.proposals : undefined; }
  async agentGrantTargetAllowed(grant: AgentGrant, target: { workspaceId?: string; projectId?: string }) { return grant.organizationId === organizationId
    && (!grant.projectId || target.projectId === grant.projectId) && target.workspaceId !== "77777777-7777-4777-8777-777777777777"; }
}
const access: MemberAccessResolver = { async authenticateBearer(value) { return value === "Bearer member-session" ? { accountId: "member", sessionId: "session" } : value === "Bearer other-session" ? { accountId: "other", sessionId: "other" } : undefined; } };
const database: DatabaseProbe = { async verifyConnection() {}, async close() {} };

describe("Agent Grants and MCP", () => {
  let instance: RunningInstance | undefined;
  afterEach(async () => { await instance?.close(); instance = undefined; });
  async function run(enabled = true) { const repository = new RepositoryFake(); const service = new AgentGrantService(repository, () => new Date("2026-08-23T10:00:00.000Z"));
    instance = await startInstance({ database, host: "127.0.0.1", port: 0, instanceAdminToken: "admin", memberAccess: access, agentGrants: service, mcpEnabled: enabled,
      notes: { async get(memberId: string, noteId: string) { return memberId === "member" && noteId === "22222222-2222-4222-8222-222222222222" ? { id: noteId, workspaceId: "55555555-5555-4555-8555-555555555555", content: "Authorized context" } : undefined; },
        async capture(memberId: string, workspaceId: string, input: unknown, cause: unknown) { repository.directWrites.push({ memberId, workspaceId, input, cause });
          repository.activities.push({ actor: memberId, cause }); repository.operatorAudit.push({ action: "agent_note_created", actor: memberId, cause });
          return { status: "created", note: { id: "33333333-3333-4333-8333-333333333333" } }; } } as any,
      tasks: { async updateByKey(memberId: string, projectId: string, taskKey: string, input: unknown, cause: unknown) {
        repository.directWrites.push({ memberId, projectId, taskKey, input, cause });
        repository.activities.push({ action: "task_planning_updated", actor: memberId, cause },
          { action: "task_dependency_relationship_updated", actor: memberId, cause });
        repository.operatorAudit.push({ action: "agent_task_updated", actor: memberId, cause });
        return { status: "updated", task: { id: "88888888-8888-4888-8888-888888888888", key: taskKey } };
      } } as any }); return repository; }
  async function issue(scopes: Array<{ capability: string; mode: "direct" | "propose" | "deny" }>, session = "member-session", projectId?: string) {
    const response = await fetch(`${instance!.url}/api/v1/organizations/${organizationId}/agent-grants`, { method: "POST", headers: { authorization: `Bearer ${session}`, "content-type": "application/json" },
      body: JSON.stringify({ organizationId, ...(projectId ? { projectId } : {}), name: "Planning assistant", expiresAt: "2026-09-01T10:00:00.000Z", scopes,
        ...(scopes.some(({ mode }) => mode === "direct") ? { directAuthorityConfirmation } : {}) }) });
    return { response, body: await response.json() as { grant: AgentGrant; token: string; error?: string } };
  }
  const mcp = (token: string, sessionId: string | undefined, body: unknown) => fetch(`${instance!.url}/mcp`, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json", ...(sessionId ? { "mcp-session-id": sessionId } : {}) }, body: JSON.stringify(body) });
  async function initializeMcp(token: string) { const initialized = await mcp(token, undefined, { jsonrpc: "2.0", id: "init", method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "compatibility-test", version: "1" } } });
    const sessionId = initialized.headers.get("mcp-session-id")!; assert.ok(sessionId); assert.equal((await initialized.json() as any).result.protocolVersion, "2025-06-18");
    const notification = await mcp(token, sessionId, { jsonrpc: "2.0", method: "notifications/initialized" }); assert.equal(notification.status, 202); assert.equal(await notification.text(), ""); return sessionId; }

  it("expires idle sessions and evicts the least recently used session at its bound", () => {
    let now = 0; const sessions = new McpSessionStore(() => now, 100, 2);
    const first = sessions.create("grant"); now = 10; const second = sessions.create("grant");
    assert.equal(sessions.get(first, "different-grant"), undefined); assert.ok(sessions.get(first, "grant")); now = 20; const third = sessions.create("grant");
    assert.equal(sessions.get(second, "grant"), undefined); assert.ok(sessions.get(first, "grant")); assert.ok(sessions.get(third, "grant"));
    now = 121; assert.equal(sessions.get(first, "grant"), undefined); assert.equal(sessions.get(third, "grant"), undefined);
  });

  it("is disabled by default and never accepts a Member session as an agent credential", async () => {
    await run(false);
    const disabled = await fetch(`${instance!.url}/mcp`, { method: "POST", headers: { authorization: "Bearer member-session", "content-type": "application/json" }, body: "{}" });
    assert.equal(disabled.status, 404);
    await instance!.close(); instance = undefined; await run(true);
    const denied = await fetch(`${instance!.url}/mcp`, { method: "POST", headers: { authorization: "Bearer member-session", "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }) });
    assert.equal(denied.status, 401);
  });

  it("follows the 2025-06-18 initialize lifecycle before discovery and calls", async () => {
    const repository = await run(); const { response, body } = await issue([{ capability: "note.read", mode: "direct" }, { capability: "note.write", mode: "propose" }, { capability: "task.write", mode: "deny" }]);
    assert.equal(response.status, 201); assert.match(body.token, /^stash_agent_/); assert.equal("token" in body.grant, false);
    const premature = await mcp(body.token, undefined, { jsonrpc: "2.0", id: 0, method: "tools/list" }); assert.equal((await premature.json() as any).error.code, -32002);
    const sessionId = await initializeMcp(body.token);
    const tools = await mcp(body.token, sessionId, { jsonrpc: "2.0", id: 1, method: "tools/list" });
    const toolsBody = await tools.json() as any; assert.deepEqual(toolsBody.result.tools.map((tool: any) => tool.name), ["stash.note.read", "stash.note.write"]);
    assert.deepEqual(toolsBody.result.tools[0].inputSchema.required, ["noteId"]); assert.equal(toolsBody.result.tools[0].inputSchema.additionalProperties, false);
    assert.deepEqual(toolsBody.result.tools[1].inputSchema.required, ["workspaceId", "input"]); assert.equal(toolsBody.result.tools[1].inputSchema.properties.input.additionalProperties, false);
    const read = await mcp(body.token, sessionId, { jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "stash.note.read", arguments: { noteId: "22222222-2222-4222-8222-222222222222" } } });
    assert.equal((await read.json() as any).result.structuredContent.result.content, "Authorized context");
    const proposal = await mcp(body.token, sessionId, { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "stash.note.write", arguments: { workspaceId: "55555555-5555-4555-8555-555555555555", input: { content: "Proposed contribution" } } } });
    assert.equal((await proposal.json() as any).result.structuredContent.status, "pending"); assert.equal(repository.proposals.length, 1);
    const proposals = await fetch(`${instance!.url}/api/organizations/${organizationId}/agent-grants/proposals`, { headers: { authorization: "Bearer member-session" } });
    assert.deepEqual((await proposals.json() as any).proposals.map((item: any) => item.status), ["pending"]);
    const extra = await mcp(body.token, sessionId, { jsonrpc: "2.0", id: 8, method: "tools/call", params: { name: "stash.note.read", arguments: { noteId: "22222222-2222-4222-8222-222222222222", unexpected: true } } });
    assert.equal((await extra.json() as any).error.code, -32602);
    const denied = await mcp(body.token, sessionId, { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "stash.task.write" } });
    assert.equal((await denied.json() as any).error.code, -32003);
  });

  it("terminates an MCP session and rejects subsequent reuse", async () => {
    await run(); const { body } = await issue([{ capability: "note.read", mode: "direct" }]);
    const sessionId = await initializeMcp(body.token);
    const terminated = await fetch(`${instance!.url}/mcp`, { method: "DELETE", headers: { authorization: `Bearer ${body.token}`, "mcp-session-id": sessionId } });
    assert.equal(terminated.status, 204); assert.equal(await terminated.text(), "");
    const reused = await mcp(body.token, sessionId, { jsonrpc: "2.0", id: 12, method: "tools/list" });
    assert.equal((await reused.json() as any).error.code, -32002);
  });

  it("applies Direct writes through the sponsoring Member domain service and enforces Project scope before effects", async () => {
    const repository = await run(); const projectId = "44444444-4444-4444-8444-444444444444"; const { body } = await issue([{ capability: "note.write", mode: "direct" }], "member-session", projectId);
    const sessionId = await initializeMcp(body.token); const call = (requestedProjectId: string, workspaceId = "55555555-5555-4555-8555-555555555555", nestedProjectId?: string) => mcp(body.token, sessionId, { jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "stash.note.write", arguments: { projectId: requestedProjectId, workspaceId, input: { content: "Agent contribution", ...(nestedProjectId ? { projectId: nestedProjectId } : {}) } } } });
    assert.equal((await (await call(projectId, undefined, "66666666-6666-4666-8666-666666666666")).json() as any).error.code, -32602); assert.equal(repository.directWrites.length, 0);
    assert.equal((await (await call("66666666-6666-4666-8666-666666666666")).json() as any).error.code, -32003); assert.equal(repository.directWrites.length, 0);
    assert.equal((await (await call(projectId, "77777777-7777-4777-8777-777777777777")).json() as any).error.code, -32003); assert.equal(repository.directWrites.length, 0);
    const omitted = await mcp(body.token, sessionId, { jsonrpc: "2.0", id: 6, method: "tools/call", params: { name: "stash.note.write", arguments: { workspaceId: "55555555-5555-4555-8555-555555555555", input: { content: "Workspace-wide attempt" } } } });
    assert.equal((await omitted.json() as any).error.code, -32003); assert.equal(repository.directWrites.length, 0);
    const accepted = await call(projectId); assert.equal((await accepted.json() as any).result.structuredContent.result.status, "created");
    const cause = { kind: "agent", agentGrantId: body.grant.id, sponsoringMemberId: "member", agentName: "Planning assistant" };
    assert.deepEqual(repository.directWrites[0], { memberId: "member", workspaceId: "55555555-5555-4555-8555-555555555555", input: { content: "Agent contribution", projectId }, cause });
    assert.deepEqual(repository.activities, [{ actor: "member", cause }]); assert.deepEqual(repository.operatorAudit, [{ action: "agent_note_created", actor: "member", cause }]);
  });

  it("uses one authoritative Project for scoped Proposals without side effects", async () => {
    const repository = await run(); const projectId = "44444444-4444-4444-8444-444444444444"; const { body } = await issue([{ capability: "note.write", mode: "propose" }], "member-session", projectId);
    const sessionId = await initializeMcp(body.token); const invoke = (argumentsValue: unknown) => mcp(body.token, sessionId, { jsonrpc: "2.0", id: 7, method: "tools/call", params: { name: "stash.note.write", arguments: argumentsValue } });
    const mismatch = await invoke({ projectId, workspaceId: "55555555-5555-4555-8555-555555555555", input: { content: "Mismatch", projectId: "66666666-6666-4666-8666-666666666666" } });
    assert.equal((await mismatch.json() as any).error.code, -32602); assert.equal(repository.proposals.length, 0); assert.equal(repository.directWrites.length, 0);
    const crossProject = await invoke({ projectId: "66666666-6666-4666-8666-666666666666", workspaceId: "55555555-5555-4555-8555-555555555555", input: { content: "Cross Project" } });
    assert.equal((await crossProject.json() as any).error.code, -32003); assert.equal(repository.proposals.length, 0);
    const omitted = await invoke({ workspaceId: "55555555-5555-4555-8555-555555555555", input: { content: "No Project" } });
    assert.equal((await omitted.json() as any).error.code, -32003); assert.equal(repository.proposals.length, 0);
    const accepted = await invoke({ projectId, workspaceId: "55555555-5555-4555-8555-555555555555", input: { content: "Review this" } });
    assert.equal((await accepted.json() as any).result.structuredContent.status, "pending"); assert.equal(repository.proposals.length, 1);
    assert.deepEqual(repository.proposals[0]?.input, { projectId, workspaceId: "55555555-5555-4555-8555-555555555555", input: { content: "Review this" } }); assert.equal(repository.directWrites.length, 0);
  });

  it("attributes every Activity from a Direct dependency update to the agent execution", async () => {
    const repository = await run(); const projectId = "44444444-4444-4444-8444-444444444444";
    const dependencyId = "99999999-9999-4999-8999-999999999999";
    const { body } = await issue([{ capability: "task.write", mode: "direct" }], "member-session", projectId);
    const sessionId = await initializeMcp(body.token);
    const update = await mcp(body.token, sessionId, { jsonrpc: "2.0", id: 9, method: "tools/call", params: { name: "stash.task.write",
      arguments: { projectId, taskKey: "STASH-12", input: { dependencies: [{ taskId: dependencyId, type: "depends_on" }] } } } });
    assert.equal((await update.json() as any).result.structuredContent.result.status, "updated");
    const cause = { kind: "agent", agentGrantId: body.grant.id, sponsoringMemberId: "member", agentName: "Planning assistant" };
    assert.deepEqual(repository.activities, [
      { action: "task_planning_updated", actor: "member", cause },
      { action: "task_dependency_relationship_updated", actor: "member", cause },
    ]);
    assert.deepEqual(repository.operatorAudit, [{ action: "agent_task_updated", actor: "member", cause }]);
  });

  it("rejects malformed Note and Task inputs before Direct effects or durable Proposals", async () => {
    const projectId = "44444444-4444-4444-8444-444444444444";
    for (const mode of ["direct", "propose"] as const) {
      const repository = await run();
      const { body } = await issue([{ capability: "note.write", mode }, { capability: "task.write", mode }], "member-session", projectId);
      const sessionId = await initializeMcp(body.token);
      const discovery = await mcp(body.token, sessionId, { jsonrpc: "2.0", id: 13, method: "tools/list" });
      const schemas = Object.fromEntries((await discovery.json() as any).result.tools.map((tool: any) => [tool.name, tool.inputSchema]));
      assert.deepEqual(schemas["stash.note.write"].properties.input.anyOf, [{ required: ["content"] }, { required: ["templateId"] }]);
      assert.deepEqual(schemas["stash.note.write"].properties.input.properties.templateId.enum, ["decision"]);
      assert.match(schemas["stash.note.write"].properties.input.properties.reminder.properties.at.pattern, /\\d\{4\}/);
      assert.equal(schemas["stash.task.write"].properties.input.properties.title.maxLength, 500);
      assert.equal(schemas["stash.task.write"].properties.input.properties.dependencies.maxItems, 100);
      assert.equal(schemas["stash.task.write"].properties.input.properties.estimate.maximum, 1_000_000);
      assert.equal(schemas["stash.task.write"].properties.input.properties.developmentLinks.items.properties.url.pattern, "^https?://");
      const note = await mcp(body.token, sessionId, { jsonrpc: "2.0", id: 10, method: "tools/call", params: { name: "stash.note.write",
        arguments: { projectId, workspaceId: "55555555-5555-4555-8555-555555555555", input: {} } } });
      assert.equal((await note.json() as any).error.code, -32602);
      const task = await mcp(body.token, sessionId, { jsonrpc: "2.0", id: 11, method: "tools/call", params: { name: "stash.task.write",
        arguments: { projectId, taskKey: "STASH-12", input: { title: "   " } } } });
      assert.equal((await task.json() as any).error.code, -32602);
      assert.equal(repository.directWrites.length, 0);
      assert.equal(repository.proposals.length, 0);
      await instance!.close(); instance = undefined;
    }
  });

  it("enforces sponsorship, validation, expiry, and immediate revocation without leaking credentials", async () => {
    const repository = await run(); const forbidden = await issue([{ capability: "note.read", mode: "direct" }], "other-session"); assert.equal(forbidden.response.status, 403);
    const unconfirmed = await fetch(`${instance!.url}/api/organizations/${organizationId}/agent-grants`, { method: "POST", headers: { authorization: "Bearer member-session", "content-type": "application/json" }, body: JSON.stringify({ organizationId, name: "Unconfirmed", expiresAt: "2026-09-01T10:00:00.000Z", scopes: [{ capability: "note.read", mode: "direct" }] }) });
    assert.equal(unconfirmed.status, 422); assert.equal(repository.grants.length, 0);
    const invalid = await fetch(`${instance!.url}/api/organizations/${organizationId}/agent-grants`, { method: "POST", headers: { authorization: "Bearer member-session", "content-type": "application/json" }, body: JSON.stringify({ organizationId, name: "", expiresAt: "never", scopes: [] }) }); assert.equal(invalid.status, 422);
    const ambiguous = await fetch(`${instance!.url}/api/organizations/${organizationId}/agent-grants`, { method: "POST", headers: { authorization: "Bearer member-session", "content-type": "application/json" }, body: JSON.stringify({ organizationId, name: "Ambiguous", expiresAt: "2026-09-01T10:00:00.000Z", scopes: [{ capability: "note.write", mode: "direct" }, { capability: "note.write", mode: "deny" }] }) }); assert.equal(ambiguous.status, 422);
    const { body } = await issue([{ capability: "note.read", mode: "direct" }]);
    const listed = await fetch(`${instance!.url}/api/organizations/${organizationId}/agent-grants`, { headers: { authorization: "Bearer member-session" } }); const listedText = await listed.text(); assert.doesNotMatch(listedText, /stash_agent_|tokenHash|tokenLookup/);
    const revoke = await fetch(`${instance!.url}/api/organizations/${organizationId}/agent-grants/${body.grant.id}`, { method: "DELETE", headers: { authorization: "Bearer member-session" } }); assert.equal(revoke.status, 200); assert.ok(repository.grants[0]?.revokedAt);
    const after = await fetch(`${instance!.url}/mcp`, { method: "POST", headers: { authorization: `Bearer ${body.token}`, "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 4, method: "tools/list" }) }); assert.equal(after.status, 401);
  });
});
