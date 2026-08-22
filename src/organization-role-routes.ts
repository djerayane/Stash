import { json, readJson, type HttpRoute } from "./http-routing.js";
import {
  InvalidOrganizationRoleInput,
  type BuiltInOrganizationRole,
  type OrganizationRoleService,
} from "./organization-roles.js";
import type { MemberAccessResolver } from "./workspaces-projects.js";

const rolesPath = /^\/api\/organizations\/([^/]+)\/roles(?:\/([^/]+))?$/;
const memberPath = /^\/api\/organizations\/([^/]+)\/members\/([^/]+)(?:\/role)?$/;

export function organizationRoleRoutes(
  service: OrganizationRoleService,
  memberAccess: MemberAccessResolver,
): HttpRoute {
  return {
    matches: (_request, url) => rolesPath.test(url.pathname) || memberPath.test(url.pathname),
    async handle(request, response, url) {
      const access = await memberAccess.authenticateBearer(request.headers.authorization);
      if (!access) {
        json(response, 401, { error: "unauthorized", message: "A valid Member session is required." });
        return true;
      }

      try {
        const rolesMatch = url.pathname.match(rolesPath);
        const memberMatch = url.pathname.match(memberPath);
        const organizationId = decodeURIComponent((rolesMatch ?? memberMatch)![1]!);

        if (rolesMatch) {
          if (!await service.authorizeOwner(organizationId, access.accountId)) {
            forbidden(response);
            return true;
          }
          if (request.method === "GET" && !rolesMatch[2]) {
            json(response, 200, { roles: service.listBuiltInRoles() });
          } else if ((request.method === "PUT" || request.method === "DELETE") && rolesMatch[2]) {
            json(response, 409, {
              error: "built_in_role_immutable",
              message: "Owner, Admin, and Member Roles cannot be edited or deleted.",
            });
          } else {
            json(response, 405, { error: "method_not_allowed", message: "This Role operation is not supported." });
          }
          return true;
        }

        const memberId = decodeURIComponent(memberMatch![2]!);
        let result;
        if (request.method === "PUT" && url.pathname.endsWith("/role")) {
          const input = await readJson(request);
          result = await service.assign(organizationId, access.accountId, memberId, input);
          if (result === "updated") {
            json(response, 200, {
              organizationId,
              memberId,
              role: (input as { role: BuiltInOrganizationRole }).role,
            });
            return true;
          }
        } else if (request.method === "DELETE" && !url.pathname.endsWith("/role")) {
          result = await service.remove(organizationId, access.accountId, memberId);
          if (result === "removed") {
            response.writeHead(204, { "cache-control": "no-store" });
            response.end();
            return true;
          }
        } else {
          json(response, 405, { error: "method_not_allowed", message: "This membership operation is not supported." });
          return true;
        }

        if (result === "forbidden") {
          forbidden(response);
        } else if (result === "member_not_found") {
          json(response, 404, { error: result, message: "That Member does not belong to this Organization." });
        } else if (result === "final_owner") {
          json(response, 409, {
            error: result,
            message: "Transfer ownership before removing or reassigning the final Owner.",
          });
        }
      } catch (error) {
        if (error instanceof InvalidOrganizationRoleInput) {
          json(response, 422, { error: "invalid_input", message: "Organization, Member, and built-in Role values must be valid." });
        } else if (error instanceof SyntaxError) {
          json(response, 400, { error: "invalid_json", message: "Request body must be valid JSON." });
        } else {
          json(response, 503, { error: "organization_roles_unavailable", message: "Organization Roles could not be updated. Try again." });
        }
      }
      return true;
    },
  };
}

function forbidden(response: Parameters<typeof json>[0]): void {
  json(response, 403, {
    error: "organization_forbidden",
    message: "Only an Organization Owner can manage built-in Roles.",
  });
}
