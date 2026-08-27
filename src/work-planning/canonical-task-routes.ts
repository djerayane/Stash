import { json, readJson, type HttpRoute } from "../http-routing.js";
import type { MemberAccessResolver } from "../workspaces-projects.js";
import { InvalidCanonicalTaskInput, type CanonicalTaskService } from "./canonical-tasks.js";

const workspaceTasks = /^\/api\/workspaces\/([^/]+)\/canonical-tasks$/;
const workflow = /^\/api\/workspaces\/([^/]+)\/workflow$/;
const task = /^\/api\/canonical-tasks\/([^/]+)$/;
const associations = /^\/api\/canonical-tasks\/([^/]+)\/projects$/;
const parent = /^\/api\/canonical-tasks\/([^/]+)\/parent$/;
const key = /^\/api\/projects\/([^/]+)\/task-keys\/([^/]+)$/;
const projectParent = /^\/api\/projects\/([^/]+)\/parent$/;
const projectTasks = /^\/api\/projects\/([^/]+)\/canonical-tasks$/;
export function canonicalTaskRoutes(service: CanonicalTaskService, memberAccess: MemberAccessResolver): HttpRoute {
  return { matches(_request, url) { return [workspaceTasks, workflow, task, associations, parent, key, projectParent, projectTasks].some((pattern) => pattern.test(url.pathname)); },
    async handle(request, response, url) {
      const member = await memberAccess.authenticateBearer(request.headers.authorization);
      if (!member) { json(response, 401, { error: "unauthorized", message: "A valid Member session is required." }); return true; }
      try {
        let result: any; let created = false;
        const matchWorkspace = url.pathname.match(workspaceTasks); const matchWorkflow = url.pathname.match(workflow);
        const matchTask = url.pathname.match(task); const matchAssociations = url.pathname.match(associations);
        const matchParent = url.pathname.match(parent); const matchKey = url.pathname.match(key);
        const matchProjectParent = url.pathname.match(projectParent); const matchProjectTasks = url.pathname.match(projectTasks);
        if (matchWorkspace && request.method === "GET") result = await service.list(member.accountId, decodeURIComponent(matchWorkspace[1]!));
        else if (matchWorkspace && request.method === "POST") { result = await service.create(member.accountId,
          decodeURIComponent(matchWorkspace[1]!), await readJson(request)); created = true; }
        else if (matchWorkflow && request.method === "GET") result = await service.workflow(member.accountId, decodeURIComponent(matchWorkflow[1]!));
        else if (matchWorkflow && request.method === "PUT") result = await service.configureWorkflow(member.accountId, decodeURIComponent(matchWorkflow[1]!), await readJson(request));
        else if (matchTask && request.method === "PATCH") result = await service.update(member.accountId, decodeURIComponent(matchTask[1]!), await readJson(request));
        else if (matchAssociations && request.method === "PUT") result = await service.associate(member.accountId, decodeURIComponent(matchAssociations[1]!), await readJson(request));
        else if (matchParent && request.method === "PUT") result = await service.setParent(member.accountId, decodeURIComponent(matchParent[1]!), await readJson(request));
        else if (matchKey && request.method === "GET") result = await service.resolveKey(member.accountId,
          decodeURIComponent(matchKey[1]!), decodeURIComponent(matchKey[2]!));
        else if (matchProjectParent && request.method === "PUT") result = await service.setProjectParent(member.accountId, decodeURIComponent(matchProjectParent[1]!), await readJson(request));
        else if (matchProjectTasks && request.method === "GET") result = await service.listProject(member.accountId, decodeURIComponent(matchProjectTasks[1]!));
        else { response.setHeader("allow", matchWorkspace ? "GET, POST" : matchWorkflow || matchKey ? "GET" : matchTask ? "PATCH" : "PUT");
          json(response, 405, { error: "method_not_allowed", message: "Use the documented Task method." }); return true; }
        if (["workspace_not_found", "task_not_found", "project_not_found"].includes(result.status)) json(response, 404, { error: "not_found", message: "That Task, Project, or Workspace is not available." });
        else if (["invalid_reference", "cycle"].includes(result.status)) json(response, 409, { error: result.status,
          message: result.status === "cycle" ? "A Subtask cannot contain itself through its parent chain." : "A referenced Task, Project, or Workflow status is unavailable." });
        else if (result.status === "audience_broadening") json(response, 409, { ...result, error: result.status,
          message: "Confirm before sharing this Task with additional Project guests." });
        else if(result.status==="conflict") json(response,409,{...result,error:"revision_conflict",
          message:"This Task changed while the offline update was pending. The local contribution was preserved for review."});
        else json(response, created ? 201 : 200, result);
      } catch (error) {
        if (error instanceof InvalidCanonicalTaskInput) json(response, 422, { error: "invalid_input", message: "Provide valid canonical Task fields and stable identities." });
        else if (error instanceof SyntaxError) json(response, 400, { error: "invalid_json", message: "Request body must be valid JSON." });
        else json(response, 503, { error: "tasks_unavailable", message: "Tasks are temporarily unavailable." });
      }
      return true;
    } };
}
