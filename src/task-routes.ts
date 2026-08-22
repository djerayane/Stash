import { json, readJson, type HttpRoute } from "./http-routing.js";
import { InvalidTaskFromBlockInput, type TaskService } from "./tasks.js";
import type { MemberAccessResolver } from "./workspaces-projects.js";

export function taskRoutes(service: TaskService, memberAccess: MemberAccessResolver): HttpRoute {
  return {
    matches: (request, url) => request.method === "POST" && /^\/api\/notes\/[^/]+\/blocks\/[^/]+\/tasks$/.test(url.pathname),
    async handle(request, response, url) {
      const access = await memberAccess.authenticateBearer(request.headers.authorization);
      if (!access) { json(response, 401, { error: "unauthorized", message: "A valid Member session is required." }); return true; }
      try {
        let noteId: string; let blockKey: string;
        try {
          const segments = url.pathname.split("/");
          noteId = decodeURIComponent(segments[3]!);
          blockKey = decodeURIComponent(segments[5]!);
        }
        catch { throw new InvalidTaskFromBlockInput(); }
        const result = await service.createFromBlock(access.accountId, noteId!, blockKey!, await readJson(request));
        if (result.status === "created") json(response, 201, { task: result.task, sourceBlock: { noteId, blockId: result.blockId } });
        else if (result.status === "project_forbidden") json(response, 403, { error: result.status, message: "This Member cannot create a Task in that Project." });
        else json(response, 404, { error: result.status, message: result.status === "note_not_found" ? "This Note is unavailable." : "That Block does not exist in this Note." });
      } catch (error) {
        if (error instanceof InvalidTaskFromBlockInput) json(response, 422, { error: "invalid_input", message: "A Task requires a valid Project, Block, and title." });
        else if (error instanceof SyntaxError || error instanceof Error && error.message === "body_too_large")
          json(response, error instanceof SyntaxError ? 400 : 413, { error: error instanceof SyntaxError ? "invalid_json" : "body_too_large", message: "The request could not be read." });
        else json(response, 503, { error: "task_unavailable", message: "The Task could not be created. Try again." });
      }
      return true;
    },
  };
}
