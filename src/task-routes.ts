import { json, readJson, type HttpRoute } from "./http-routing.js";
import { InvalidTaskFromBlockInput, type TaskService } from "./tasks.js";
import type { MemberAccessResolver } from "./workspaces-projects.js";

export function taskRoutes(service: TaskService, memberAccess: MemberAccessResolver): HttpRoute {
  return {
    matches: (request, url) => (request.method === "POST" && /^\/api\/notes\/[^/]+\/blocks\/[^/]+\/tasks$/.test(url.pathname))
      || (request.method === "GET" && /^\/api\/notes\/[^/]+\/linked-tasks$/.test(url.pathname))
      || (["GET", "POST"].includes(request.method ?? "") && /^\/api\/tasks\/[^/]+\/source-blocks$/.test(url.pathname))
      || (request.method === "POST" && /^\/api\/projects\/[^/]+\/tasks\/[^/]+\/move$/.test(url.pathname))
      || ((request.method === "GET" || request.method === "PATCH") && /^\/api\/projects\/[^/]+\/tasks\/[^/]+$/.test(url.pathname)),
    async handle(request, response, url) {
      const access = await memberAccess.authenticateBearer(request.headers.authorization);
      if (!access) { json(response, 401, { error: "unauthorized", message: "A valid Member session is required." }); return true; }
      try {
        if (url.pathname.startsWith("/api/tasks/")) {
          let taskId: string;
          try { taskId = decodeURIComponent(url.pathname.split("/")[3]!); } catch { throw new InvalidTaskFromBlockInput(); }
          if (request.method === "GET") {
            const result = await service.listSourceBlocks(access.accountId, taskId);
            if (result.status === "found") json(response, 200, { sourceBlocks: result.sourceBlocks });
            else json(response, 404, { error: "task_not_found", message: "This Task is unavailable." });
            return true;
          }
          const result = await service.linkBlock(access.accountId, taskId, await readJson(request));
          if (result.status === "linked" || result.status === "already_linked")
            json(response, result.status === "linked" ? 201 : 200, { result: result.status, task: result.task, sourceBlock: result.sourceBlock });
          else if (result.status === "ambiguous_block") json(response, 422, { error: result.status,
            message: "That Block identity occurs more than once. Repair the Note before linking it." });
          else json(response, 404, { error: result.status, message: result.status === "task_not_found" ? "This Task is unavailable."
            : result.status === "note_not_found" ? "This Note is unavailable." : "That Block does not exist in this Note." });
          return true;
        }
        if (/^\/api\/projects\//.test(url.pathname)) {
          let projectId: string; let taskKey: string;
          try { const segments = url.pathname.split("/"); projectId = decodeURIComponent(segments[3]!); taskKey = decodeURIComponent(segments[5]!); }
          catch { throw new InvalidTaskFromBlockInput(); }
          const result = url.pathname.endsWith("/move") ? await service.move(access.accountId, projectId!, taskKey!, await readJson(request))
            : request.method === "GET" ? await service.findByKey(access.accountId, projectId!, taskKey!)
            : await service.updateByKey(access.accountId, projectId!, taskKey!, await readJson(request));
          if (result.status === "found" || result.status === "updated") json(response, 200, { task: result.task });
          else if (result.status === "moved") json(response, 200, { task: result.task, activity: result.activity });
          else if (result.status === "destination_forbidden") json(response, 403, { error: result.status, message: "This Member cannot move the Task to that Project." });
          else if (result.status === "same_project") json(response, 409, { error: result.status, message: "The Task already belongs to that Project." });
          else if (result.status === "invalid_reference") json(response, 422, { error: result.status, message: "One or more Task properties refer to unavailable Project data." });
          else json(response, 404, { error: "task_not_found", message: "This Task is unavailable in that Project." });
          return true;
        }
        if (request.method === "GET") {
          let noteId: string;
          try { noteId = decodeURIComponent(url.pathname.split("/")[3]!); } catch { throw new InvalidTaskFromBlockInput(); }
          const result = await service.listLinked(access.accountId, noteId);
          if (result.status === "found") json(response, 200, { tasks: result.tasks });
          else json(response, 404, { error: "note_not_found", message: "This Note is unavailable." });
          return true;
        }
        let noteId: string; let blockKey: string;
        try {
          const segments = url.pathname.split("/");
          noteId = decodeURIComponent(segments[3]!);
          blockKey = decodeURIComponent(segments[5]!);
        }
        catch { throw new InvalidTaskFromBlockInput(); }
        const result = await service.createFromBlock(access.accountId, noteId!, blockKey!, await readJson(request));
        if (result.status === "created") json(response, 201, { task: result.task, sourceBlock: result.sourceBlock });
        else if (result.status === "project_forbidden") json(response, 403, { error: result.status, message: "This Member cannot create a Task in that Project." });
        else if (result.status === "ambiguous_block") json(response, 422, { error: result.status,
          message: "That Block identity occurs more than once. Repair the Note before creating a Task." });
        else json(response, 404, { error: result.status, message: result.status === "note_not_found" ? "This Note is unavailable." : "That Block does not exist in this Note." });
      } catch (error) {
        if (error instanceof InvalidTaskFromBlockInput) json(response, 422, { error: "invalid_input",
          message: url.pathname.endsWith("/move") ? "A Task move requires a valid destination Project." : "A Task requires a valid Project, Block, and title." });
        else if (error instanceof SyntaxError || error instanceof Error && error.message === "body_too_large")
          json(response, error instanceof SyntaxError ? 400 : 413, { error: error instanceof SyntaxError ? "invalid_json" : "body_too_large", message: "The request could not be read." });
        else json(response, 503, { error: "task_unavailable", message: "The Task change could not be saved. Try again." });
      }
      return true;
    },
  };
}
