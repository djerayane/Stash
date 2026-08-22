import { json, readJson, type HttpRoute } from "./http-routing.js";
import { InvalidMobileCapture, type MobileCaptureService } from "./mobile-captures.js";
import type { MemberAccessResolver } from "./workspaces-projects.js";

export function mobileCaptureRoutes(service: MobileCaptureService, accessResolver: MemberAccessResolver): HttpRoute {
  return {
    matches: (request, url) => (request.method === "POST" && /^\/api\/mobile\/v1\/workspaces\/[^/]+\/captures$/.test(url.pathname))
      || (request.method === "GET" && /^\/api\/mobile\/v1\/workspaces\/[^/]+\/capture-options$/.test(url.pathname)),
    async handle(request, response, url) {
      const access = await accessResolver.authenticateBearer(request.headers.authorization);
      if (!access) { json(response, 401, { error: "unauthorized", message: "A valid Member session is required." }); return true; }
      try {
        let workspaceId: string;
        try { workspaceId = decodeURIComponent(url.pathname.split("/")[5]!); } catch { throw new InvalidMobileCapture(); }
        if (request.method === "GET") {
          const result = await service.options(access.accountId, workspaceId);
          if (result.status === "found") json(response, 200, result.options);
          else json(response, 403, { error: "workspace_forbidden", message: "This Member cannot read capture options in that Workspace." });
          return true;
        }
        const result = await service.capture(access.accountId, workspaceId, await readJson(request));
        if (result.status === "created" || result.status === "duplicate") {
          json(response, result.status === "created" ? 201 : 200, { status: result.status, noteId: result.noteId });
        } else if (result.status === "conflict") {
          json(response, 409, { error: "capture_conflict", message: "This capture ID was already used for a different payload. The capture remains in the outbox." });
        } else json(response, 403, { error: "workspace_forbidden", message: "This Member cannot capture Notes in that Workspace or Project." });
      } catch (error) {
        if (error instanceof InvalidMobileCapture) json(response, 422, { error: "invalid_input", message: "The mobile capture is invalid and remains in the outbox." });
        else if (error instanceof SyntaxError) json(response, 400, { error: "invalid_json", message: "Request body must be valid JSON." });
        else json(response, 503, { error: "capture_unavailable", message: "The capture could not be synchronized. Try again." });
      }
      return true;
    },
  };
}
