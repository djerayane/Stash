import { json, readJson, type HttpRoute } from "./http-routing.js";
import { InvalidNoteInput, InvalidNoteTriageInput, type NoteService } from "./notes.js";
import type { MemberAccessResolver } from "./workspaces-projects.js";

export function noteRoutes(service: NoteService, memberAccess: MemberAccessResolver): HttpRoute {
  return {
    matches: (request, url) => (request.method === "POST" && /^\/api\/workspaces\/[^/]+\/notes$/.test(url.pathname))
      || (request.method === "GET" && /^\/api\/workspaces\/[^/]+\/inbox$/.test(url.pathname))
      || (request.method === "POST" && /^\/api\/workspaces\/[^/]+\/inbox\/[^/]+\/triage$/.test(url.pathname)),
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
        if (request.method === "GET") {
          const result = await service.listInbox(access.accountId, workspaceId);
          if (result.status === "workspace_forbidden") json(response, 403, { error: "workspace_forbidden", message: "This Member cannot read that Workspace Inbox." });
          else json(response, 200, { notes: result.notes.map(({ createdByMemberId: _, ...note }) => note) });
          return true;
        }
        if (url.pathname.includes("/inbox/")) {
          let noteId: string;
          try { noteId = decodeURIComponent(url.pathname.split("/")[5]!); } catch { throw new InvalidNoteTriageInput(); }
          const outcome = await service.triage(access.accountId, workspaceId, noteId, await readJson(request));
          if (outcome.status === "updated") {
            const result = outcome.result.kind;
            const payload = outcome.result.kind === "organized" || outcome.result.kind === "archived"
              ? { result, note: (({ createdByMemberId: _, ...note }) => note)(outcome.result.note) }
              : outcome.result.kind === "linked" ? { result, link: outcome.result.link } : { result, task: outcome.result.task };
            json(response, 200, payload); return true;
          }
          if (outcome.status === "note_not_found" || outcome.status === "target_note_not_found") {
            json(response, 404, { error: outcome.status, message: "The requested Note could not be found." }); return true;
          }
          json(response, 403, { error: "workspace_forbidden", message: "This Member cannot triage that Note or Project." }); return true;
        }
        const result = await service.capture(access.accountId, workspaceId, await readJson(request));
        if (result.status === "created") {
          const { createdByMemberId: _, ...note } = result.note;
          json(response, 201, {
            ...note,
            portableProjection: {
              format: result.projection.schema,
              state: "recorded",
            },
          });
        } else {
          json(response, 403, {
            error: "workspace_forbidden",
            message: "This Member cannot capture Notes in that Workspace or Project.",
          });
        }
      } catch (error) {
        if (error instanceof InvalidNoteInput || error instanceof InvalidNoteTriageInput) {
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
