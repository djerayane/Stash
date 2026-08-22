import { json, readJson, type HttpRoute } from "./http-routing.js";
import { InvalidInvitationInput, type InvitationService } from "./invitations.js";
import type { MemberAccessResolver } from "./workspaces-projects.js";

const invitationPath = /^\/api\/organizations\/([^/]+)\/invitations$/;
const projectPath = /^\/api\/projects\/([^/]+)$/;

export function invitationRoutes(service: InvitationService, accessResolver: MemberAccessResolver): HttpRoute {
  return {
    matches: (_request, url) => invitationPath.test(url.pathname) || projectPath.test(url.pathname) || url.pathname === "/api/invitations/accept",
    async handle(request, response, url) {
      const access = await accessResolver.authenticateBearer(request.headers.authorization);
      if (!access) { json(response, 401, { error: "unauthorized", message: "A valid account session is required." }); return true; }
      try {
        const invitationMatch = url.pathname.match(invitationPath);
        const projectMatch = url.pathname.match(projectPath);
        if (invitationMatch) {
          if (request.method !== "POST") return methodNotAllowed(response);
          const organizationId = decodeURIComponent(invitationMatch[1]!);
          const result = await service.create(organizationId, access.accountId, await readJson(request));
          if (result.status === "created") json(response, 201, { token: result.token, expiresAt: result.invitation.expiresAt });
          else if (result.status === "forbidden") json(response, 403, { error: "organization_forbidden", message: "Organization Owner or Admin permission is required." });
          else json(response, 403, { error: "project_forbidden", message: "Every Guest Project must belong to the invited Organization." });
          return true;
        }
        if (url.pathname === "/api/invitations/accept") {
          if (request.method !== "POST") return methodNotAllowed(response);
          const result = await service.accept(access.accountId, await readJson(request));
          if (result === "invalid_invitation") json(response, 410, { error: result, message: "This invitation is invalid, expired, or already accepted." });
          else json(response, 200, result.access);
          return true;
        }
        const projectId = decodeURIComponent(projectMatch![1]!);
        if (request.method === "GET") {
          const project = await service.readProject(access.accountId, projectId);
          if (!project) json(response, 404, { error: "not_found", message: "No accessible Project exists at this path." });
          else { const { organizationId: _, ...visible } = project; json(response, 200, { ...visible, access: "read" }); }
        } else if (request.method === "PATCH") {
          if (!await service.canWriteProject(access.accountId, projectId)) json(response, 403, { error: "project_read_only", message: "Guests have read-only Project access." });
          else json(response, 405, { error: "method_not_allowed", message: "Project editing is not supported yet." });
        } else return methodNotAllowed(response);
      } catch (error) {
        if (error instanceof InvalidInvitationInput) json(response, 422, { error: "invalid_input", message: "Invitation and Project values must be valid." });
        else if (error instanceof SyntaxError || (error instanceof Error && error.message === "body_too_large")) json(response, 400, { error: "invalid_json", message: "Request body must be valid JSON." });
        else json(response, 503, { error: "invitation_unavailable", message: "The invitation operation could not be completed. Try again." });
      }
      return true;
    },
  };
}

function methodNotAllowed(response: Parameters<typeof json>[0]) { json(response, 405, { error: "method_not_allowed", message: "This invitation or Project operation is not supported." }); return true; }
