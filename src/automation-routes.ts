import { AutomationConflict, AutomationForbidden, AutomationNotFound, InvalidAutomationInput, type AutomationService } from "./automations.js";
import { json, readJson, type HttpRoute } from "./http-routing.js";
import type { MemberAccessResolver } from "./workspaces-projects.js";

const projectPath = /^\/api\/projects\/([^/]+)\/automations$/;
const taskPath = /^\/api\/projects\/([^/]+)\/tasks\/([^/]+)\/automations(?:\/([^/]+)\/reverse)?$/;

export function automationRoutes(service: AutomationService, access: MemberAccessResolver): HttpRoute {
  return { matches: (_request, url) => projectPath.test(url.pathname) || taskPath.test(url.pathname), async handle(request, response, url) {
    const member = await access.authenticateBearer(request.headers.authorization);
    if (!member) { json(response, 401, { error: "unauthorized", message: "A valid Member session is required." }); return true; }
    try {
      const projectMatch = url.pathname.match(projectPath);
      if (projectMatch && request.method === "POST") {
        const recipe = await service.enable(member.accountId, decodeURIComponent(projectMatch[1]!), await readJson(request));
        json(response, 200, { recipe }); return true;
      }
      const taskMatch = url.pathname.match(taskPath);
      if (taskMatch && request.method === "GET" && !taskMatch[3]) {
        const automation = await service.list(member.accountId, decodeURIComponent(taskMatch[1]!), decodeURIComponent(taskMatch[2]!));
        json(response, 200, { automation }); return true;
      }
      if (taskMatch && request.method === "POST" && taskMatch[3]) {
        const transition = await service.reverse(member.accountId, decodeURIComponent(taskMatch[1]!), decodeURIComponent(taskMatch[2]!), decodeURIComponent(taskMatch[3]));
        json(response, 200, { transition }); return true;
      }
      json(response, 405, { error: "method_not_allowed", message: "This Automation operation is not supported." });
    } catch (error) {
      if (error instanceof InvalidAutomationInput || error instanceof URIError) json(response, 422, { error: "invalid_input", message: "Choose a valid recipe, active Workflow status, Task, and transition." });
      else if (error instanceof AutomationForbidden) json(response, 403, { error: "automation_forbidden", message: "This Member cannot configure or reverse Automations in this Project." });
      else if (error instanceof AutomationNotFound) json(response, 404, { error: "automation_not_found", message: "That Task, Automation, or transition is unavailable." });
      else if (error instanceof AutomationConflict) json(response, 409, { error: "automation_conflict", message: "The Task changed after this Automation ran. Review its current status before reversing." });
      else if (error instanceof SyntaxError || (error instanceof Error && error.message === "body_too_large")) json(response, 400, { error: "invalid_json", message: "Request body must be valid JSON." });
      else json(response, 503, { error: "automation_unavailable", message: "Automations are temporarily unavailable. Try again." });
    }
    return true;
  } };
}
