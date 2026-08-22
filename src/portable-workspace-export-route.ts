import type { MemberAccessResolver } from "./workspaces-projects.js";
import { InvalidPortableWorkspaceExport, type PortableWorkspaceExportService } from "./portable-workspace-export.js";
import { json, type HttpRoute } from "./http-routing.js";

export function portableWorkspaceExportRoute(service: PortableWorkspaceExportService, access: MemberAccessResolver): HttpRoute {
  return {
    matches(request, url) { return request.method === "GET" && /^\/api\/workspaces\/[^/]+\/export$/.test(url.pathname); },
    async handle(request, response, url) {
      const member = await access.authenticateBearer(request.headers.authorization);
      if (!member) { json(response, 401, { error: "unauthorized", message: "A valid Member bearer token is required." }); return true; }
      const workspaceId = url.pathname.split("/")[3]!;
      try {
        const result = await service.export(member.accountId, workspaceId);
        if (result.status === "workspace_forbidden") json(response, 403, { error: "workspace_forbidden", message: "Workspace export permission is required." });
        else if (result.status === "workspace_not_found") json(response, 404, { error: "workspace_not_found", message: "The Workspace was not found." });
        else {
          response.writeHead(200, { "content-type": "application/zip", "content-disposition": `attachment; filename="${result.filename}"`,
            "content-length": result.archive.length, "cache-control": "no-store", "x-content-type-options": "nosniff" });
          response.end(result.archive);
        }
      } catch (error) {
        if (error instanceof InvalidPortableWorkspaceExport) json(response, 422, { error: "invalid_export_request", message: "A valid Workspace identifier is required." });
        else json(response, 503, { error: "export_unavailable", message: "The Workspace export could not be completed. No partial export was produced." });
      }
      return true;
    },
  };
}
