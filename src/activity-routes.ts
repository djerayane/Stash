import { InvalidActivityInput, type ActivityService } from "./activity.js";
import { json, readJson, type HttpRoute } from "./http-routing.js";
import type { MemberAccessResolver } from "./workspaces-projects.js";

export function activityRoutes(service: ActivityService, memberAccess: MemberAccessResolver): HttpRoute {
  return {
    matches: (request, url) => request.method === "GET" && /^\/api\/workspaces\/[^/]+\/activity$/.test(url.pathname)
      || request.method === "GET" && /^\/api\/notes\/[^/]+\/history$/.test(url.pathname)
      || request.method === "POST" && /^\/api\/notes\/[^/]+\/history\/[^/]+\/restore$/.test(url.pathname),
    async handle(request, response, url) {
      const access = await memberAccess.authenticateBearer(request.headers.authorization);
      if (!access) { json(response, 401, { error: "unauthorized", message: "A valid Member session is required." }); return true; }
      try {
        const parts = url.pathname.split("/");
        if (url.pathname.includes("/workspaces/")) {
          const result = await service.listWorkspace(access.accountId, decodeURIComponent(parts[3]!));
          if (result.status === "found") json(response, 200, { activities: result.activities });
          else json(response, 404, { error: "workspace_not_found", message: "This Workspace Activity is unavailable." });
          return true;
        }
        const noteId = decodeURIComponent(parts[3]!);
        if (request.method === "GET") {
          const result = await service.listNoteHistory(access.accountId, noteId);
          if (result.status === "found") json(response, 200, { revisions: result.revisions });
          else json(response, 404, { error: "note_not_found", message: "This Note history is unavailable." });
          return true;
        }
        const result = await service.restoreNote(access.accountId, noteId, decodeURIComponent(parts[5]!), await readJson(request));
        if (result.status === "restored" || result.status === "duplicate") {
          json(response, 200, { note: result.note, activity: result.activity, duplicate: result.status === "duplicate" });
        } else if (result.status === "revision_conflict") {
          json(response, 409, { error: "revision_conflict", message: "The Note changed after restoration began. Reload its history before retrying.", currentRevision: result.currentRevision });
        } else if (result.status === "idempotency_conflict") {
          json(response, 409, { error: "idempotency_conflict", message: "That restoration identity was already used for another revision." });
        } else json(response, 404, { error: result.status, message: "The requested Note revision is unavailable." });
      } catch (error) {
        if (error instanceof InvalidActivityInput) json(response, 422, { error: "invalid_input", message: "A valid Note revision, expected revision, and idempotency key are required." });
        else if (error instanceof SyntaxError || (error instanceof Error && error.message === "body_too_large")) json(response, 400, { error: "invalid_json", message: "Request body must be valid JSON." });
        else json(response, 503, { error: "activity_unavailable", message: "Activity or Note history is temporarily unavailable. Try again." });
      }
      return true;
    },
  };
}
