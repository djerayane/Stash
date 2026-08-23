import { json, readJson, type HttpRoute } from "./http-routing.js";
import {
  builtInOrganizationRoles,
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
      const rolesMatch = url.pathname.match(rolesPath);
      const memberMatch = url.pathname.match(memberPath);
      let organizationId: string;
      let memberId: string | undefined;
      let roleName: BuiltInOrganizationRole | undefined;
      try {
        organizationId = decodeUuid((rolesMatch ?? memberMatch)![1]!);
        memberId = memberMatch ? decodeUuid(memberMatch[2]!) : undefined;
        roleName = rolesMatch?.[2] ? decodeBuiltInRole(rolesMatch[2]) : undefined;
      } catch {
        invalidInput(response);
        return true;
      }

      const access = await memberAccess.authenticateBearer(request.headers.authorization);
      if (!access) {
        json(response, 401, { error: "unauthorized", message: "A valid Member session is required." });
        return true;
      }

      try {
        if (rolesMatch) {
          if (!await service.authorizeOwner(organizationId, access.accountId)) {
            forbidden(response);
            return true;
          }
          if (request.method === "GET" && !rolesMatch[2]) {
            json(response, 200, { roles: service.listBuiltInRoles() });
          } else if ((request.method === "PUT" || request.method === "DELETE") && roleName) {
            json(response, 409, {
              error: "built_in_role_immutable",
              message: "Owner, Admin, and Member Roles cannot be edited or deleted.",
            });
          } else {
            json(response, 405, { error: "method_not_allowed", message: "This Role operation is not supported." });
          }
          return true;
        }

        let result;
        if (request.method === "PUT" && url.pathname.endsWith("/role")) {
          const input = await readJson(request);
          result = await service.assign(organizationId, access.accountId, memberId!, input);
          if (result === "updated") {
            json(response, 200, {
              organizationId,
              memberId: memberId!,
              role: (input as { role: BuiltInOrganizationRole }).role,
            });
            return true;
          }
        } else if (request.method === "DELETE" && !url.pathname.endsWith("/role")) {
          result = await service.remove(organizationId, access.accountId, memberId!);
          if (typeof result === "object" && result.status === "removed") {
            json(response, 200, {
              memberId: result.departure.memberId,
              affectedTaskIds: result.departure.affectedTaskIds,
              degradedRepositoryConnectionIds: result.departure.degradedRepositoryConnectionIds,
              authorityRevoked: true,
            });
            return true;
          }
        } else {
          json(response, 405, { error: "method_not_allowed", message: "This membership operation is not supported." });
          return true;
        }

        if (result === "forbidden") {
          forbidden(response, request.method === "DELETE" && !url.pathname.endsWith("/role"));
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
          invalidInput(response);
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

function forbidden(response: Parameters<typeof json>[0], membershipOperation = false): void {
  json(response, 403, {
    error: "organization_forbidden",
    message: membershipOperation
      ? "Organization Owner or Admin permission is required to manage Members."
      : "Only an Organization Owner can manage built-in Roles.",
  });
}

function invalidInput(response: Parameters<typeof json>[0]): void {
  json(response, 422, {
    error: "invalid_input",
    message: "Organization, Member, and built-in Role values must be valid.",
  });
}

function decodeUuid(value: string): string {
  const decoded = decodeURIComponent(value);
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(decoded)) {
    throw new InvalidOrganizationRoleInput();
  }
  return decoded;
}

function decodeBuiltInRole(value: string): BuiltInOrganizationRole {
  const decoded = decodeURIComponent(value);
  if (!builtInOrganizationRoles.includes(decoded as BuiltInOrganizationRole)) {
    throw new InvalidOrganizationRoleInput();
  }
  return decoded as BuiltInOrganizationRole;
}
