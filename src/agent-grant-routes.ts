import type { MemberAccessResolver } from "./workspaces-projects.js";
import { json, readJson, type HttpRoute } from "./http-routing.js";
import { AgentGrantService, InvalidAgentGrantInput } from "./agent-grants.js";

export function agentGrantRoutes(service: AgentGrantService, access: MemberAccessResolver): HttpRoute {
  return {
    matches: (_request, url) => /^\/api\/organizations\/[^/]+\/agent-grants(?:\/[^/]+)?$/.test(url.pathname),
    async handle(request, response, url) {
      const member = await access.authenticateBearer(request.headers.authorization);
      if (!member) { json(response, 401, { error: "unauthorized", message: "A valid Member session is required." }); return true; }
      try {
        const parts = url.pathname.split("/"); const organizationId = decodeURIComponent(parts[3]!); const grantId = parts[5] ? decodeURIComponent(parts[5]) : undefined;
        if (request.method === "GET" && !grantId) {
          const grants = await service.list(member.accountId, organizationId);
          if (!grants) json(response, 403, { error: "agent_grants_forbidden", message: "Only the sponsoring Member can view their Agent Grants." });
          else json(response, 200, { grants });
        } else if (request.method === "POST" && !grantId) {
          const result = await service.create(member.accountId, await readJson(request));
          if (result.status === "forbidden") json(response, 403, { error: "agent_grants_forbidden", message: "A Member may only create Agent Grants within their own Organization and Projects." });
          else json(response, 201, result);
        } else if (request.method === "DELETE" && grantId) {
          const result = await service.revoke(member.accountId, organizationId, grantId);
          if (result === "revoked") json(response, 200, { grantId, revoked: true });
          else if (result === "not_found") json(response, 404, { error: "agent_grant_not_found", message: "That Agent Grant was not found." });
          else json(response, 403, { error: "agent_grants_forbidden", message: "Only the sponsoring Member can revoke this Agent Grant." });
        } else json(response, 405, { error: "method_not_allowed", message: "This Agent Grant operation is not supported." });
      } catch (error) {
        if (error instanceof InvalidAgentGrantInput) json(response, 422, { error: "invalid_input", message: "Agent Grant scope, mode, and expiry must be valid." });
        else if (error instanceof SyntaxError) json(response, 400, { error: "invalid_json", message: "Request body must be valid JSON." });
        else json(response, 503, { error: "agent_grants_unavailable", message: "Agent Grants are temporarily unavailable. Try again." });
      }
      return true;
    },
  };
}
