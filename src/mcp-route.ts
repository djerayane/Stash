import { json, readJson, type HttpRoute } from "./http-routing.js";
import type { AgentGrant, AgentGrantService } from "./agent-grants.js";
import type { AgentGrantCapability } from "@stash/domain-types";
import type { NoteService } from "./notes.js";
import type { TaskService } from "./tasks.js";

interface McpDomainServices { notes?: NoteService; tasks?: TaskService }

export function mcpRoute(service: AgentGrantService, enabled: boolean, domain: McpDomainServices): HttpRoute {
  return {
    matches: (_request, url) => url.pathname === "/mcp",
    async handle(request, response) {
      if (!enabled) { json(response, 404, { error: "not_found", message: "MCP is not enabled on this Instance." }); return true; }
      if (request.method !== "POST") { json(response, 405, { error: "method_not_allowed", message: "MCP accepts JSON-RPC POST requests." }); return true; }
      const token = request.headers.authorization?.replace(/^Bearer\s+/, "");
      const grant = await service.authenticate(token);
      if (!grant) { json(response, 401, { error: "unauthorized", message: "A valid, active Agent Grant is required." }); return true; }
      try {
        const value = await readJson(request);
        if (!isRequest(value)) { rpc(response, null, undefined, { code: -32600, message: "Invalid Request" }); return true; }
        if (value.method === "initialize") rpc(response, value.id, { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "stash", version: "0.1.0" } });
        else if (value.method === "tools/list") rpc(response, value.id, { tools: toolsFor(grant) });
        else if (value.method === "tools/call") await callTool(response, value.id, grant, value.params, service, domain);
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
const toolSchemas: Record<AgentGrantCapability, object> = {
  "note.read": { type: "object", additionalProperties: false, properties: { noteId: uuidSchema }, required: ["noteId"] },
  "note.write": { type: "object", additionalProperties: false, properties: { workspaceId: uuidSchema, projectId: uuidSchema,
    input: { type: "object", additionalProperties: false, properties: { content: { type: "string" }, templateId: { type: "string" }, projectId: uuidSchema,
      tags: { type: "array", items: { type: "string" } }, reminder: { type: "object", additionalProperties: false, properties: { at: { type: "string" } }, required: ["at"] } } } }, required: ["workspaceId", "input"] },
  "task.read": { type: "object", additionalProperties: false, properties: { projectId: uuidSchema, taskKey: taskKeySchema }, required: ["projectId", "taskKey"] },
  "task.write": { type: "object", additionalProperties: false, properties: { projectId: uuidSchema, taskKey: taskKeySchema,
    input: { type: "object", additionalProperties: false, minProperties: 1, properties: { title: { type: "string" }, statusId: uuidSchema,
      assigneeIds: { type: "array", items: uuidSchema }, priority: { type: "string", enum: ["none", "low", "medium", "high", "urgent"] },
      labelNames: { type: "array", items: { type: "string" } }, dueDate: { type: ["string", "null"] }, estimate: { type: ["number", "null"] }, linkedNoteIds: { type: "array", items: uuidSchema },
      dependencies: { type: "array", items: { type: "object", additionalProperties: false, properties: { taskId: uuidSchema, type: { type: "string", enum: ["depends_on", "required_by"] } }, required: ["taskId", "type"] } },
      developmentLinks: { type: "array", items: { type: "object", additionalProperties: false, properties: { provider: { type: "string" }, url: { type: "string" }, kind: { type: "string", enum: ["branch", "commit", "pull_request"] } }, required: ["provider", "url", "kind"] } } } } }, required: ["projectId", "taskKey", "input"] },
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
  return matchesSchema(toolSchemas[capability] as JsonSchema, value);
}
interface JsonSchema { type?: string | string[]; format?: string; pattern?: string; enum?: unknown[]; properties?: Record<string, JsonSchema>; required?: string[]; additionalProperties?: boolean; items?: JsonSchema; minProperties?: number }
function matchesSchema(schema: JsonSchema, value: unknown): boolean {
  const types = Array.isArray(schema.type) ? schema.type : schema.type ? [schema.type] : [];
  if (types.length && !types.some((type) => type === "null" ? value === null : type === "array" ? Array.isArray(value) : type === "object" ? plain(value) : typeof value === type)) return false;
  if (schema.enum && !schema.enum.includes(value)) return false;
  if (typeof value === "string" && schema.format === "uuid" && !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) return false;
  if (typeof value === "string" && schema.pattern && !new RegExp(schema.pattern).test(value)) return false;
  if (Array.isArray(value) && schema.items && !value.every((item) => matchesSchema(schema.items!, item))) return false;
  if (plain(value)) { const properties = schema.properties ?? {}; if (schema.additionalProperties === false && Object.keys(value).some((key) => !(key in properties))) return false;
    if (schema.required?.some((key) => !(key in value)) || schema.minProperties && Object.keys(value).length < schema.minProperties) return false;
    if (Object.entries(value).some(([key, item]) => properties[key] && !matchesSchema(properties[key]!, item))) return false; }
  return true;
}
function plain(value: unknown): value is Record<string, unknown> { return Boolean(value && typeof value === "object" && !Array.isArray(value)); }
function validProjectScope(grant: AgentGrant, capability: string, args: unknown): boolean { if (!grant.projectId || capability === "note.read") return true; if (!args || typeof args !== "object") return false;
  const input = args as any; return input.projectId === grant.projectId || input.input?.projectId === grant.projectId; }
async function executeDirect(grant: AgentGrant, capability: string, args: unknown, domain: McpDomainServices): Promise<unknown> {
  if (!args || typeof args !== "object") throw new Error("invalid"); const input = args as any;
  const cause = { kind: "agent" as const, agentGrantId: grant.id, sponsoringMemberId: grant.sponsoringMemberId, agentName: grant.name };
  if (capability === "note.read") { const note = await domain.notes?.get(grant.sponsoringMemberId, input.noteId); if (grant.projectId && note?.projectId !== grant.projectId) return undefined; return note; }
  if (capability === "note.write") return domain.notes?.capture(grant.sponsoringMemberId, input.workspaceId, input.input, cause);
  if (capability === "task.read") return domain.tasks?.findByKey(grant.sponsoringMemberId, input.projectId, input.taskKey);
  if (capability === "task.write") return domain.tasks?.updateByKey(grant.sponsoringMemberId, input.projectId, input.taskKey, input.input, cause);
  throw new Error("unsupported");
}
function targetFrom(value: unknown): { workspaceId?: string; projectId?: string } { if (!value || typeof value !== "object") return {};
  const item = value as any; return { ...(typeof item.workspaceId === "string" ? { workspaceId: item.workspaceId } : {}),
    ...(typeof item.projectId === "string" ? { projectId: item.projectId } : typeof item.input?.projectId === "string" ? { projectId: item.input.projectId } : {}) }; }
function rpc(response: Parameters<typeof json>[0], id: string | number | null, result?: object, error?: object) { json(response, 200, { jsonrpc: "2.0", id, ...(result ? { result } : {}), ...(error ? { error } : {}) }); }
function isRequest(value: unknown): value is { jsonrpc: "2.0"; id: string | number; method: string; params?: unknown } { return Boolean(value && typeof value === "object" && (value as any).jsonrpc === "2.0" && ["string", "number"].includes(typeof (value as any).id) && typeof (value as any).method === "string"); }
