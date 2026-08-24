import { InvalidWorkspaceSearchInput, type WorkspaceSearchService } from "./workspace-search.js";
import { json, type HttpRoute } from "./http-routing.js";
import type { MemberAccessResolver } from "./workspaces-projects.js";

export function workspaceSearchRoutes(service: WorkspaceSearchService, memberAccess: MemberAccessResolver): HttpRoute {
  return {
    matches: (request, url) => request.method === "GET" && /^\/api\/workspaces\/[^/]+\/search$/.test(url.pathname),
    async handle(request, response, url) {
      const access = await memberAccess.authenticateBearer(request.headers.authorization);
      if (!access) { json(response, 401, { error: "unauthorized", message: "A valid Member session is required." }); return true; }
      try {
        const input = Object.fromEntries(["q", "projectId", "object", "author", "assignee", "status", "from", "to"]
          .flatMap((key) => url.searchParams.has(key) ? [[key, url.searchParams.get(key)!]] : []));
        const result = await service.search(access.accountId, decodeURIComponent(url.pathname.split("/")[3]!), input);
        if (result.status === "found") json(response, 200, { results: result.results, total: result.total, facets: result.facets });
        else json(response, 404, { error: "workspace_not_found", message: "This Workspace search is unavailable." });
      } catch (error) {
        if (error instanceof InvalidWorkspaceSearchInput) json(response, 422, { error: "invalid_input", message: "Search text and filters must be valid." });
        else json(response, 503, { error: "search_unavailable", message: "Workspace search is temporarily unavailable. Try again." });
      }
      return true;
    },
  };
}
