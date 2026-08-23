import { json, readJson, type HttpRoute } from "./http-routing.js";
import type { AgentGrant, AgentGrantService } from "./agent-grants.js";
import type { AgentGrantCapability } from "@stash/domain-types";
import { isNoteInput, type NoteService } from "./notes.js";
import { isPlanningUpdate, type TaskService } from "./tasks.js";
import { randomUUID } from "node:crypto";

interface McpDomainServices { notes?: NoteService; tasks?: TaskService }
interface McpSession { grantId: string; initialized: boolean; lastUsedAt: number }

export class McpSessionStore {
  readonly #sessions = new Map<string, McpSession>();
  constructor(private readonly now: () => number = Date.now, private readonly ttlMs = 30 * 60_000, private readonly maximum = 1_024) {}
  create(grantId: string): string {
    this.#evictExpired();
    while (this.#sessions.size >= this.maximum) this.#sessions.delete(this.#sessions.keys().next().value!);
    const id = randomUUID(); this.#sessions.set(id, { grantId, initialized: false, lastUsedAt: this.now() }); return id;
  }
  get(id: string, grantId: string): McpSession | undefined {
    const session = this.#sessions.get(id); if (!session) return undefined;
    const now = this.now(); if (now - session.lastUsedAt >= this.ttlMs) { this.#sessions.delete(id); return undefined; }
    if (session.grantId !== grantId) return undefined;
    session.lastUsedAt = now; this.#sessions.delete(id); this.#sessions.set(id, session); return session;
  }
  delete(id: string, grantId: string): boolean {
    const session = this.#sessions.get(id); if (!session || session.grantId !== grantId) return false;
    return this.#sessions.delete(id);
  }
  #evictExpired() { const now = this.now(); for (const [id, session] of this.#sessions) if (now - session.lastUsedAt >= this.ttlMs) this.#sessions.delete(id); }
}

export function mcpRoute(service: AgentGrantService, enabled: boolean, domain: McpDomainServices): HttpRoute {
  const sessions = new McpSessionStore();
  return {
    matches: (_request, url) => url.pathname === "/mcp",
    async handle(request, response) {
      if (!enabled) { json(response, 404, { error: "not_found", message: "MCP is not enabled on this Instance." }); return true; }
      const token = request.headers.authorization?.replace(/^Bearer\s+/, "");
      const grant = await service.authenticate(token);
      if (!grant) { json(response, 401, { error: "unauthorized", message: "A valid, active Agent Grant is required." }); return true; }
      if (request.method === "DELETE") { const sessionId = typeof request.headers["mcp-session-id"] === "string" ? request.headers["mcp-session-id"] : undefined;
        if (!sessionId || !sessions.delete(sessionId, grant.id)) { json(response, 404, { error: "session_not_found", message: "MCP session was not found." }); return true; }
        empty(response, 204); return true; }
      if (request.method !== "POST") { json(response, 405, { error: "method_not_allowed", message: "MCP accepts JSON-RPC POST requests and DELETE session termination." }); return true; }
      try {
        const value = await readJson(request);
        if (!isMessage(value)) { rpc(response, null, undefined, { code: -32600, message: "Invalid Request" }); return true; }
        const sessionId = typeof request.headers["mcp-session-id"] === "string" ? request.headers["mcp-session-id"] : undefined;
        const session = sessionId ? sessions.get(sessionId, grant.id) : undefined;
        if (value.method === "initialize" && value.id !== undefined) { if (!validInitialize(value.params)) { rpc(response, value.id, undefined, { code: -32602, message: "Unsupported MCP protocol version" }); return true; }
          const createdSessionId = sessions.create(grant.id); response.setHeader("mcp-session-id", createdSessionId);
          rpc(response, value.id, { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "stash", version: "0.1.0" } }); }
        else if (value.method === "notifications/initialized" && value.id === undefined) { if (!session || session.grantId !== grant.id) { empty(response, 400); return true; }
          session.initialized = true; response.writeHead(202, { "cache-control": "no-store" }); response.end(); }
        else if (!session || session.grantId !== grant.id || !session.initialized) value.id === undefined ? empty(response, 400) : rpc(response, value.id, undefined, { code: -32002, message: "MCP session is not initialized" });
        else if (value.method === "tools/list" && value.id !== undefined) rpc(response, value.id, { tools: toolsFor(grant) });
        else if (value.method === "tools/call" && value.id !== undefined) await callTool(response, value.id, grant, value.params, service, domain);
        else if (value.id === undefined) { response.writeHead(202, { "cache-control": "no-store" }); response.end(); }
        else rpc(response, value.id, undefined, { code: -32601, message: "Method not found" });
      } catch (error) {
        if (error instanceof SyntaxError) rpc(response, null, undefined, { code: -32700, message: "Parse error" });
        else json(response, 503, { error: "mcp_unavailable", message: "MCP is temporarily unavailable. Try again." });
      }
      return true;
    },
  };
}

const descriptions: Record<string, string> = { "note.read": "Read an authorized Note", "note.write": "Create a Note", "task.read": "Read an authorized Task", "task.write": "Update a Task" };
const uuidSchema = { type: "string", format: "uuid" } as const;
const taskKeySchema = { type: "string", pattern: "^[A-Za-z][A-Za-z0-9-]{1,19}-[1-9][0-9]*$" } as const;
const nonBlank100Schema = { type: "string", minLength: 1, maxLength: 100, pattern: "\\S" } as const;
const toolSchemas: Record<AgentGrantCapability, object> = {
  "note.read": { type: "object", additionalProperties: false, properties: { noteId: uuidSchema }, required: ["noteId"] },
  "note.write": { type: "object", additionalProperties: false, properties: { workspaceId: uuidSchema, projectId: uuidSchema,
    input: { type: "object", additionalProperties: false, anyOf: [{ required: ["content"] }, { required: ["templateId"] }],
      properties: { content: { type: "string", minLength: 1, pattern: "\\S" }, templateId: { type: "string", enum: ["decision"] },
        tags: { type: "array", maxItems: 50, items: nonBlank100Schema }, reminder: { type: "object", additionalProperties: false,
          properties: { at: { type: "string", pattern: "^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}(?:\\.\\d+)?(?:Z|[+-]\\d{2}:\\d{2})$" } }, required: ["at"] } } } }, required: ["workspaceId", "input"] },
  "task.read": { type: "object", additionalProperties: false, properties: { projectId: uuidSchema, taskKey: taskKeySchema }, required: ["projectId", "taskKey"] },
  "task.write": { type: "object", additionalProperties: false, properties: { projectId: uuidSchema, taskKey: taskKeySchema,
    input: { type: "object", additionalProperties: false, minProperties: 1, properties: { title: { type: "string", minLength: 1, maxLength: 500, pattern: "\\S" }, statusId: uuidSchema,
      assigneeIds: { type: "array", maxItems: 100, items: uuidSchema }, priority: { type: "string", enum: ["none", "low", "medium", "high", "urgent"] },
      labelNames: { type: "array", maxItems: 100, items: nonBlank100Schema }, dueDate: { type: ["string", "null"], pattern: "^\\d{4}-\\d{2}-\\d{2}$" },
      estimate: { type: ["number", "null"], minimum: 0, maximum: 1_000_000 }, linkedNoteIds: { type: "array", maxItems: 100, items: uuidSchema },
      dependencies: { type: "array", maxItems: 100, items: { type: "object", additionalProperties: false, properties: { taskId: uuidSchema, type: { type: "string", enum: ["depends_on", "required_by"] } }, required: ["taskId", "type"] } },
      developmentLinks: { type: "array", maxItems: 100, items: { type: "object", additionalProperties: false, properties: { provider: { type: "string", minLength: 1, pattern: "\\S" },
        url: { type: "string", pattern: "^https?://" }, kind: { type: "string", enum: ["branch", "commit", "pull_request"] } }, required: ["provider", "url", "kind"] } } } } }, required: ["projectId", "taskKey", "input"] },
};
function toolsFor(grant: AgentGrant) { return grant.scopes.filter(({ mode }) => mode !== "deny").map(({ capability, mode }) => ({
  name: `stash.${capability}`, description: `${descriptions[capability] ?? capability} (${mode === "direct" ? "applies directly" : "creates a Proposal"})`,
  inputSchema: toolSchemas[capability], annotations: { readOnlyHint: capability.endsWith(".read") },
})); }
async function callTool(response: Parameters<typeof json>[0], id: string | number, grant: AgentGrant, params: unknown, service: AgentGrantService, domain: McpDomainServices) {
  const name = params && typeof params === "object" && "name" in params ? String(params.name) : "";
  const args = params && typeof params === "object" && "arguments" in params ? (params as { arguments?: unknown }).arguments : undefined;
  const capability = name.startsWith("stash.") ? name.slice(6) : ""; const scope = grant.scopes.find((candidate) => candidate.capability === capability);
  if (!scope || scope.mode === "deny") { rpc(response, id, undefined, { code: -32003, message: "Agent Grant denies this capability" }); return; }
  if (!validToolArguments(scope.capability, args)) { rpc(response, id, undefined, { code: -32602, message: "Invalid tool arguments" }); return; }
  if (!validProjectScope(grant, capability, args)) { rpc(response, id, undefined, { code: -32003, message: "Agent Grant does not authorize that Project" }); return; }
  if (capability !== "note.read" && !await service.authorizeTarget(grant, targetFrom(args))) { rpc(response, id, undefined, { code: -32003, message: "Agent Grant does not authorize that Organization or Project" }); return; }
  if (scope.mode === "propose") { const proposal = await service.propose(grant, scope.capability, args); rpc(response, id, {
    content: [{ type: "text", text: "Proposal created for Member review." }], structuredContent: { proposalId: proposal.id, status: proposal.status, capability } }); return; }
  try {
    const result = await executeDirect(grant, capability, args, domain);
    if (result === undefined) { rpc(response, id, undefined, { code: -32004, message: "Authorized domain object was not found" }); return; }
    if (capability === "note.read" && !await service.authorizeTarget(grant, targetFrom(result))) { rpc(response, id, undefined, { code: -32004, message: "Authorized domain object was not found" }); return; }
    rpc(response, id, { content: [{ type: "text", text: JSON.stringify(result) }], structuredContent: { capability, mode: "direct", result } });
  } catch { rpc(response, id, undefined, { code: -32602, message: "Invalid or unauthorized domain input" }); }
}
function validToolArguments(capability: AgentGrantCapability, value: unknown): boolean {
  if (!matchesSchema(toolSchemas[capability] as JsonSchema, value)) return false;
  if (!plain(value)) return false;
  if (capability === "note.write") {
    const input = plain(value.input) ? { ...value.input, ...(typeof value.projectId === "string" ? { projectId: value.projectId } : {}) } : value.input;
    return isNoteInput(input);
  }
  if (capability === "task.write") return isPlanningUpdate(value.input);
  return true;
}
interface JsonSchema { type?: string | string[]; format?: string; pattern?: string; enum?: unknown[]; properties?: Record<string, JsonSchema>; required?: string[]; additionalProperties?: boolean; items?: JsonSchema; minProperties?: number; minLength?: number; maxLength?: number; maxItems?: number; minimum?: number; maximum?: number; anyOf?: JsonSchema[] }
function matchesSchema(schema: JsonSchema, value: unknown): boolean {
  const types = Array.isArray(schema.type) ? schema.type : schema.type ? [schema.type] : [];
  if (types.length && !types.some((type) => type === "null" ? value === null : type === "array" ? Array.isArray(value) : type === "object" ? plain(value) : typeof value === type)) return false;
  if (schema.anyOf && !schema.anyOf.some((candidate) => matchesSchema(candidate, value))) return false;
  if (schema.enum && !schema.enum.includes(value)) return false;
  if (typeof value === "string" && (schema.minLength !== undefined && value.length < schema.minLength || schema.maxLength !== undefined && value.length > schema.maxLength)) return false;
  if (typeof value === "number" && (!Number.isFinite(value) || schema.minimum !== undefined && value < schema.minimum || schema.maximum !== undefined && value > schema.maximum)) return false;
  if (typeof value === "string" && schema.format === "uuid" && !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) return false;
  if (typeof value === "string" && schema.pattern && !new RegExp(schema.pattern).test(value)) return false;
  if (Array.isArray(value) && (schema.maxItems !== undefined && value.length > schema.maxItems || schema.items && !value.every((item) => matchesSchema(schema.items!, item)))) return false;
  if (plain(value)) { const properties = schema.properties ?? {}; if (schema.additionalProperties === false && Object.keys(value).some((key) => !(key in properties))) return false;
    if (schema.required?.some((key) => !(key in value)) || schema.minProperties && Object.keys(value).length < schema.minProperties) return false;
    if (Object.entries(value).some(([key, item]) => properties[key] && !matchesSchema(properties[key]!, item))) return false; }
  return true;
}
function plain(value: unknown): value is Record<string, unknown> { return Boolean(value && typeof value === "object" && !Array.isArray(value)); }
function validProjectScope(grant: AgentGrant, capability: string, args: unknown): boolean { if (!grant.projectId || capability === "note.read") return true; if (!args || typeof args !== "object") return false;
  return (args as { projectId?: unknown }).projectId === grant.projectId; }
async function executeDirect(grant: AgentGrant, capability: string, args: unknown, domain: McpDomainServices): Promise<unknown> {
  if (!args || typeof args !== "object") throw new Error("invalid"); const input = args as any;
  const cause = { kind: "agent" as const, agentGrantId: grant.id, sponsoringMemberId: grant.sponsoringMemberId, agentName: grant.name };
  if (capability === "note.read") { const note = await domain.notes?.get(grant.sponsoringMemberId, input.noteId); if (grant.projectId && note?.projectId !== grant.projectId) return undefined; return note; }
  if (capability === "note.write") return domain.notes?.capture(grant.sponsoringMemberId, input.workspaceId,
    { ...input.input, ...(input.projectId ? { projectId: input.projectId } : {}) }, cause);
  if (capability === "task.read") return domain.tasks?.findByKey(grant.sponsoringMemberId, input.projectId, input.taskKey);
  if (capability === "task.write") return domain.tasks?.updateByKey(grant.sponsoringMemberId, input.projectId, input.taskKey, input.input, cause);
  throw new Error("unsupported");
}
function targetFrom(value: unknown): { workspaceId?: string; projectId?: string } { if (!value || typeof value !== "object") return {};
  const item = value as any; return { ...(typeof item.workspaceId === "string" ? { workspaceId: item.workspaceId } : {}),
    ...(typeof item.projectId === "string" ? { projectId: item.projectId } : {}) }; }
function rpc(response: Parameters<typeof json>[0], id: string | number | null, result?: object, error?: object) { json(response, 200, { jsonrpc: "2.0", id, ...(result ? { result } : {}), ...(error ? { error } : {}) }); }
function empty(response: Parameters<typeof json>[0], status: number) { response.writeHead(status, { "cache-control": "no-store" }); response.end(); }
function isMessage(value: unknown): value is { jsonrpc: "2.0"; id?: string | number; method: string; params?: unknown } { return Boolean(value && typeof value === "object" && (value as any).jsonrpc === "2.0" && ((value as any).id === undefined || ["string", "number"].includes(typeof (value as any).id)) && typeof (value as any).method === "string"); }
function validInitialize(value: unknown): boolean { return plain(value) && value.protocolVersion === "2025-06-18" && plain(value.capabilities) && plain(value.clientInfo) && typeof value.clientInfo.name === "string" && typeof value.clientInfo.version === "string"; }
