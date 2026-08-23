import { json, readJson, type HttpRoute } from "./http-routing.js";
import { GitHubArtifactNotFound, GitHubArtifactUnavailable, GitHubArtifactWriteForbidden, InvalidGitHubArtifactInput, type GitHubArtifactService } from "./github-artifacts.js";
import type { MemberAccessResolver } from "./workspaces-projects.js";
const path = /^\/api\/projects\/([^/]+)\/tasks\/([^/]+)\/development-artifacts$/;
const connectionsPath = /^\/api\/projects\/([^/]+)\/repository-connections$/;
export function githubArtifactRoutes(service: GitHubArtifactService, access: MemberAccessResolver): HttpRoute {
  return { matches: (_request, url) => path.test(url.pathname) || connectionsPath.test(url.pathname), async handle(request, response, url) {
    const member = await access.authenticateBearer(request.headers.authorization);
    if (!member) { json(response, 401, { error: "unauthorized", message: "A valid Member session is required." }); return true; }
    try {
      const connectionsMatch = url.pathname.match(connectionsPath);
      if (connectionsMatch) {
        if (request.method === "GET") json(response, 200, { repositoryConnections: await service.listConnections(member.accountId, decodeURIComponent(connectionsMatch[1]!)) });
        else json(response, 405, { error: "method_not_allowed", message: "This Repository Connection operation is not supported." });
        return true;
      }
      const match = url.pathname.match(path)!; const projectId = decodeURIComponent(match[1]!); const taskKey = decodeURIComponent(match[2]!);
      if (request.method === "GET") json(response, 200, { artifacts: await service.list(member.accountId, projectId, taskKey) });
      else if (request.method === "POST") {
        const value = await readJson(request); const action = value && typeof value === "object" && !Array.isArray(value) ? (value as { action?: unknown }).action : undefined;
        const artifact = action === "create_branch" ? await service.createBranch(member.accountId, projectId, taskKey, value) : await service.link(member.accountId, projectId, taskKey, value);
        json(response, 201, { artifact });
      } else json(response, 405, { error: "method_not_allowed", message: "This development artifact operation is not supported." });
    } catch (error) {
      if (error instanceof SyntaxError) json(response, 400, { error: "invalid_json", message: "Request body must be valid JSON." });
      else if (error instanceof InvalidGitHubArtifactInput || error instanceof URIError) json(response, 422, { error: "invalid_input", message: "Development artifact values must be valid." });
      else if (error instanceof GitHubArtifactNotFound) json(response, 404, { error: "development_context_not_found", message: "That Task or Repository Connection is unavailable in this Project." });
      else if (error instanceof GitHubArtifactWriteForbidden) json(response, 403, { error: "project_forbidden", message: "This Member cannot change development links for that Task." });
      else if (error instanceof GitHubArtifactUnavailable) json(response, 502, { error: "github_unavailable", message: "GitHub could not complete that operation. Try again." });
      else json(response, 503, { error: "development_artifacts_unavailable", message: "Development artifacts are unavailable. Try again." });
    }
    return true;
  } };
}
