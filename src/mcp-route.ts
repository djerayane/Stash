import { json, readJson, type HttpRoute } from "./http-routing.js";
import type { AgentGrant, AgentGrantService } from "./agent-grants.js";

export function mcpRoute(service: AgentGrantService, enabled: boolean): HttpRoute {
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
        else if (value.method === "tools/call") callTool(response, value.id, grant, value.params);
        else rpc(response, value.id, undefined, { code: -32601, message: "Method not found" });
      } catch (error) {
        if (error instanceof SyntaxError) rpc(response, null, undefined, { code: -32700, message: "Parse error" });
        else json(response, 503, { error: "mcp_unavailable", message: "MCP is temporarily unavailable. Try again." });
      }
      return true;
    },
  };
}

const descriptions: Record<string, string> = { "workspace.read": "Read authorized Workspace context", "note.write": "Create or update Notes", "task.write": "Create or update Tasks" };
function toolsFor(grant: AgentGrant) { return grant.scopes.filter(({ mode }) => mode !== "deny").map(({ capability, mode }) => ({
  name: `stash.${capability}`, description: `${descriptions[capability] ?? capability} (${mode === "direct" ? "applies directly" : "creates a Proposal"})`,
  inputSchema: { type: "object", additionalProperties: true }, annotations: { readOnlyHint: capability.endsWith(".read") },
})); }
function callTool(response: Parameters<typeof json>[0], id: string | number, grant: AgentGrant, params: unknown) {
  const name = params && typeof params === "object" && "name" in params ? String(params.name) : "";
  const capability = name.startsWith("stash.") ? name.slice(6) : ""; const scope = grant.scopes.find((candidate) => candidate.capability === capability);
  if (!scope || scope.mode === "deny") { rpc(response, id, undefined, { code: -32003, message: "Agent Grant denies this capability" }); return; }
  rpc(response, id, { content: [{ type: "text", text: scope.mode === "propose" ? "Proposal required before canonical data changes." : "Agent Grant authorizes direct execution through the Stash domain API." }],
    structuredContent: { capability, mode: scope.mode, organizationId: grant.organizationId, ...(grant.projectId ? { projectId: grant.projectId } : {}) } });
}
function rpc(response: Parameters<typeof json>[0], id: string | number | null, result?: object, error?: object) { json(response, 200, { jsonrpc: "2.0", id, ...(result ? { result } : {}), ...(error ? { error } : {}) }); }
function isRequest(value: unknown): value is { jsonrpc: "2.0"; id: string | number; method: string; params?: unknown } { return Boolean(value && typeof value === "object" && (value as any).jsonrpc === "2.0" && ["string", "number"].includes(typeof (value as any).id) && typeof (value as any).method === "string"); }
