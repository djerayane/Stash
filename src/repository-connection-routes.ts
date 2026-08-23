import { json, readJson, type HttpRoute } from "./http-routing.js";
import { GitHubRepositoryUnavailable, InvalidRepositoryConnectionInput, RepositoryConnectionWriteForbidden, type RepositoryConnectionService } from "./repository-connections.js";
import type { MemberAccessResolver } from "./workspaces-projects.js";
const path = /^\/api\/organizations\/([^/]+)\/repository-connections$/;
const projectPath = /^\/api\/organizations\/([^/]+)\/repository-connections\/([^/]+)\/projects\/([^/]+)$/;
const verifyPath = /^\/api\/organizations\/([^/]+)\/repository-connections\/([^/]+)\/verify$/;
const repairPath = /^\/api\/organizations\/([^/]+)\/repository-connections\/([^/]+)\/repair$/;
export function repositoryConnectionRoutes(service: RepositoryConnectionService, access: MemberAccessResolver): HttpRoute {
  return { matches: (_request, url) => path.test(url.pathname) || projectPath.test(url.pathname) || verifyPath.test(url.pathname) || repairPath.test(url.pathname), async handle(request, response, url) {
    const member = await access.authenticateBearer(request.headers.authorization);
    if (!member) { json(response, 401, { error: "unauthorized", message: "A valid Member session is required." }); return true; }
    try {
      const match = url.pathname.match(path) ?? url.pathname.match(projectPath) ?? url.pathname.match(verifyPath) ?? url.pathname.match(repairPath)!;
      const organizationId = decodePathValue(match[1]!);
      if (!await service.authorize(organizationId, member.accountId)) { json(response, 403, { error: "organization_forbidden", message: "Organization Owner or Admin permission is required." }); return true; }
      if (projectPath.test(url.pathname) && request.method === "POST") {
        const attached = await service.attachToProject(member.accountId, organizationId, decodePathValue(match[2]!), decodePathValue(match[3]!));
        if (attached === "forbidden") throw new RepositoryConnectionWriteForbidden();
        if (attached === "not_found") json(response, 404, { error: "repository_connection_not_found", message: "That Repository Connection or Project is not available in this Organization." });
        else { response.writeHead(204, { "cache-control": "no-store" }); response.end(); }
      } else if (repairPath.test(url.pathname) && request.method === "PUT") {
        const repaired = await service.repair(member.accountId, organizationId, decodePathValue(match[2]!), await readJson(request));
        if (repaired === "forbidden") throw new RepositoryConnectionWriteForbidden();
        if (repaired === "not_found") json(response, 404, { error: "repository_connection_not_found", message: "That degraded Repository Connection is not available." });
        else response.writeHead(204, { "cache-control": "no-store" }).end();
      } else if (verifyPath.test(url.pathname) && request.method === "POST") {
        await service.verify(organizationId, decodePathValue(match[2]!));
        response.writeHead(204, { "cache-control": "no-store" }); response.end();
      } else if (request.method === "GET") json(response, 200, { repositoryConnections: await service.list(organizationId) });
      else if (request.method === "POST") { const result = await service.connect(member.accountId, organizationId, await readJson(request)); json(response, result.created ? 201 : 200, result.connection); }
      else json(response, 405, { error: "method_not_allowed", message: "This Repository Connection operation is not supported." });
    } catch (error) {
      if (error instanceof SyntaxError) json(response, 400, { error: "invalid_json", message: "Request body must be valid JSON." });
      else if (error instanceof InvalidRepositoryConnectionInput) json(response, 422, { error: "invalid_input", message: "Repository Connection values must be valid." });
      else if (error instanceof GitHubRepositoryUnavailable) json(response, 502, { error: "github_unavailable", message: "GitHub could not authorize that repository. Try again." });
      else if (error instanceof RepositoryConnectionWriteForbidden) json(response, 403, { error: "organization_forbidden", message: "Organization Owner or Admin permission is required." });
      else json(response, 503, { error: "repository_connections_unavailable", message: "Repository Connections are unavailable. Try again." });
    }
    return true;
  } };
}
function decodePathValue(value: string): string {
  try { return decodeURIComponent(value); }
  catch { throw new InvalidRepositoryConnectionInput(); }
}
