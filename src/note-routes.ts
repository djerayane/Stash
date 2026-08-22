import { json, readJson, type HttpRoute } from "./http-routing.js";
import { InvalidNoteInput, type NoteService } from "./notes.js";
import type { MemberAccessResolver } from "./workspaces-projects.js";

export function noteRoutes(service: NoteService, memberAccess: MemberAccessResolver): HttpRoute {
  return {
    matches: (request, url) => request.method === "POST"
      && /^\/api\/workspaces\/[^/]+\/notes$/.test(url.pathname),
    async handle(request, response, url) {
      const access = await memberAccess.authenticateBearer(request.headers.authorization);
      if (!access) {
        json(response, 401, { error: "unauthorized", message: "A valid Member session is required." });
        return true;
      }
      try {
        let workspaceId: string;
        try {
          workspaceId = decodeURIComponent(url.pathname.split("/")[3]!);
        } catch {
          throw new InvalidNoteInput();
        }
        const result = await service.capture(access.accountId, workspaceId, await readJson(request));
        if (result.status === "created") {
          json(response, 201, result.note);
        } else {
          json(response, 403, {
            error: "workspace_forbidden",
            message: "This Member cannot capture Notes in that Workspace or Project.",
          });
        }
      } catch (error) {
        if (error instanceof InvalidNoteInput) {
          json(response, 422, {
            error: "invalid_input",
            message: "A Note requires content and valid optional Project, tags, and reminder fields.",
          });
        } else if (error instanceof SyntaxError || (error instanceof Error && error.message === "body_too_large")) {
          const tooLarge = error instanceof Error && error.message === "body_too_large";
          json(response, tooLarge ? 413 : 400, {
            error: tooLarge ? "body_too_large" : "invalid_json",
            message: tooLarge ? "Request body exceeds the 64 KiB limit." : "Request body must be valid JSON.",
          });
        } else {
          json(response, 503, {
            error: "note_unavailable",
            message: "The Note could not be captured. Try again.",
          });
        }
      }
      return true;
    },
  };
}
