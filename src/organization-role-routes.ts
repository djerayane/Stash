import { json, readJson, type HttpRoute } from "./http-routing.js";
import {
  builtInOrganizationRoles,
  InvalidOrganizationRoleInput,
  type BuiltInOrganizationRole,
  type OrganizationRoleService,
} from "./organization-roles.js";
import type { MemberAccessResolver } from "./workspaces-projects.js";

const rolesPath = /^\/api\/organizations\/([^/]+)\/roles(?:\/([^/]+))?$/;
const customMemberPath = /^\/api\/organizations\/([^/]+)\/roles\/([^/]+)\/members\/([^/]+)$/;
const memberPath = /^\/api\/organizations\/([^/]+)\/members\/([^/]+)(?:\/role)?$/;

export function organizationRoleRoutes(
  service: OrganizationRoleService,
  memberAccess: MemberAccessResolver,
): HttpRoute {
  return {
    matches: (_request, url) => rolesPath.test(url.pathname) || memberPath.test(url.pathname) || customMemberPath.test(url.pathname),
    async handle(request, response, url) {
      const rolesMatch = url.pathname.match(rolesPath);
      const memberMatch = url.pathname.match(memberPath);
      const customMemberMatch = url.pathname.match(customMemberPath);
      let organizationId: string;
      let memberId: string | undefined;
      let roleName: BuiltInOrganizationRole | undefined;
      let customRoleId: string | undefined;
      try {
        organizationId = decodeUuid((rolesMatch ?? memberMatch ?? customMemberMatch)![1]!);
        if (customMemberMatch) {
          customRoleId = decodeUuid(customMemberMatch[2]!);
          memberId = decodeUuid(customMemberMatch[3]!);
        }
        if (memberMatch) memberId = decodeUuid(memberMatch[2]!);
        if (rolesMatch?.[2]) {
          const decodedRole = decodeURIComponent(rolesMatch[2]);
          if (builtInOrganizationRoles.includes(decodedRole as BuiltInOrganizationRole)) roleName = decodedRole as BuiltInOrganizationRole;
          else decodeUuid(rolesMatch[2]);
        }
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
        if (customMemberMatch) {
          const result = request.method === "PUT"
            ? await service.assignCustom(organizationId, access.accountId, customRoleId!, memberId!)
            : request.method === "DELETE"
              ? await service.revokeCustom(organizationId, access.accountId, customRoleId!, memberId!)
              : undefined;
          if (!result) json(response, 405, { error: "method_not_allowed", message: "This Role assignment operation is not supported." });
          else respondCustomResult(response, result, { organizationId, roleId: customRoleId!, memberId: memberId! });
          return true;
        }
        if (rolesMatch) {
          if (!await service.authorizeOwner(organizationId, access.accountId)) {
            forbidden(response);
            return true;
          }
          if (request.method === "GET" && !rolesMatch[2]) {
            json(response, 200, { roles: await service.listRoles(organizationId) });
          } else if (request.method === "POST" && !rolesMatch[2]) {
            const created = await service.createCustom(organizationId, access.accountId, await readJson(request));
            if (created.result === "created") json(response, 201, { role: created.role });
            else respondCustomResult(response, created.result);
          } else if (request.method === "PUT" && rolesMatch[2] && !roleName) {
            const result = await service.updateCustom(organizationId, access.accountId, decodeUuid(rolesMatch[2]), await readJson(request));
            if (result === "updated") json(response, 200, { updated: true });
            else respondCustomResult(response, result);
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
      : "Only an Organization Owner can manage Roles.",
  });
}

function invalidInput(response: Parameters<typeof json>[0]): void {
  json(response, 422, {
    error: "invalid_input",
    message: "Organization, Member, and Role values must be valid.",
  });
}

function respondCustomResult(response: Parameters<typeof json>[0], result: string, body: object = {}): void {
  if (result === "updated") json(response, 200, { ...body, updated: true });
  else if (result === "forbidden") forbidden(response);
  else if (result === "role_not_found") json(response, 404, { error: result, message: "That custom Role does not exist." });
  else if (result === "member_not_found") json(response, 404, { error: result, message: "That Member does not belong to this Organization." });
  else if (result === "name_conflict") json(response, 409, { error: result, message: "A Role with that name already exists." });
}

function decodeUuid(value: string): string {
  const decoded = decodeURIComponent(value);
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(decoded)) {
    throw new InvalidOrganizationRoleInput();
  }
  return decoded;
}
