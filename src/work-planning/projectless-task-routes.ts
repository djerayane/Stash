import { json, type HttpRoute } from "../http-routing.js";
import type { MemberAccessResolver } from "../workspaces-projects.js";
import { InvalidProjectlessTaskInput, type ProjectlessTaskService } from "./projectless-tasks.js";

const path = /^\/api\/workspaces\/([^/]+)\/tasks$/;

export function projectlessTaskRoutes(service: ProjectlessTaskService, memberAccess: MemberAccessResolver): HttpRoute {
  return {
    matches(request, url) { return request.method === "GET" && path.test(url.pathname); },
    async handle(request, response, url) {
      const member = await memberAccess.authenticateBearer(request.headers.authorization);
      if (!member) {
        json(response, 401, { error: "unauthorized", message: "A valid Member session is required." });
        return true;
      }
      try {
        const result = await service.list(member.accountId, decodeURIComponent(url.pathname.match(path)![1]!), url.searchParams.get("scope"));
        if (result.status === "workspace_forbidden") {
          json(response, 404, { error: "workspace_not_found", message: "That Workspace is not available." });
        } else json(response, 200, { tasks: result.tasks });
      } catch (error) {
        if (error instanceof InvalidProjectlessTaskInput) {
          json(response, 422, { error: "invalid_input", message: "Workspace and task scope must be valid." });
        } else json(response, 503, { error: "tasks_unavailable", message: "Tasks are temporarily unavailable." });
      }
      return true;
    },
  };
}
