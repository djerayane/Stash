import { json, readJson, type HttpRoute } from "./http-routing.js";
import { InvalidProjectWorkflowInput, type ProjectWorkflowService } from "./project-workflows.js";
import type { MemberAccessResolver } from "./workspaces-projects.js";

const workflowPath = /^\/api\/projects\/([^/]+)\/workflow$/;

export function projectWorkflowRoutes(service: ProjectWorkflowService, memberAccess: MemberAccessResolver): HttpRoute {
  return {
    matches: (request, url) => ["GET", "PUT"].includes(request.method ?? "") && workflowPath.test(url.pathname),
    async handle(request, response, url) {
      const access = await memberAccess.authenticateBearer(request.headers.authorization);
      if (!access) { json(response, 401, { error: "unauthorized", message: "A valid Member session is required." }); return true; }
      try {
        let projectId: string;
        try { projectId = decodeURIComponent(workflowPath.exec(url.pathname)![1]!); }
        catch { throw new InvalidProjectWorkflowInput(); }
        const result = request.method === "GET" ? await service.find(access.accountId, projectId)
          : await service.replace(access.accountId, projectId, await readJson(request));
        if (result.status === "found" || result.status === "updated") json(response, 200, { workflow: result.workflow });
        else if (result.status === "forbidden") json(response, 403, { error: "project_forbidden", message: "Only Project Members can configure this Workflow." });
        else if (result.status === "stale_status") json(response, 409, { error: result.status, message: "The Workflow changed. Reload it before saving." });
        else json(response, 404, { error: "project_not_found", message: "This Project is unavailable." });
      } catch (error) {
        if (error instanceof InvalidProjectWorkflowInput) json(response, 422, { error: "invalid_input", message: "Provide one or more uniquely named Workflow statuses with stable Status Categories." });
        else if (error instanceof SyntaxError || error instanceof Error && error.message === "body_too_large")
          json(response, error instanceof SyntaxError ? 400 : 413, { error: error instanceof SyntaxError ? "invalid_json" : "body_too_large", message: "The request could not be read." });
        else json(response, 503, { error: "workflow_unavailable", message: "The Workflow could not be saved. Try again." });
      }
      return true;
    },
  };
}
