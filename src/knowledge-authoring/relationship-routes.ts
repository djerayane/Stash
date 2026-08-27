import { json, type HttpRoute } from "../http-routing.js";
import type { MemberAccessResolver } from "../workspaces-projects.js";
import { InvalidRelationshipQuery, type RelationshipQueryService } from "./relationship-query.js";

const neighborhood = /^\/api\/notes\/[^/]+\/relationships$/;
const maintenance = /^\/api\/workspaces\/[^/]+\/relationships\/maintenance$/;

export function relationshipRoutes(relationships: RelationshipQueryService, access: MemberAccessResolver): HttpRoute {
  return {
    matches(_request, url) { return neighborhood.test(url.pathname) || maintenance.test(url.pathname); },
    async handle(request, response, url) {
      try {
        const member = await access.authenticateBearer(request.headers.authorization);
        if (!member) { json(response, 401, { error: "unauthorized", message: "Sign in to inspect Note relationships." }); return true; }
        const segments = url.pathname.split("/");
        if (neighborhood.test(url.pathname)) {
          if (request.method !== "GET") { response.setHeader("allow", "GET"); json(response, 405, { error: "method_not_allowed", message: "Use GET for related Notes." }); return true; }
          const relationTypes = url.searchParams.getAll("relationType");
          const includeHierarchy = url.searchParams.get("includeHierarchy");
          if (includeHierarchy !== null && includeHierarchy !== "true" && includeHierarchy !== "false") throw new InvalidRelationshipQuery();
          const result = await relationships.query(member.accountId, decodeURIComponent(segments[3]!), {
            ...(url.searchParams.has("depth") ? { depth: Number(url.searchParams.get("depth")) } : {}),
            ...(url.searchParams.has("limit") ? { limit: Number(url.searchParams.get("limit")) } : {}),
            ...(url.searchParams.has("direction") ? { direction: url.searchParams.get("direction") } : {}),
            ...(relationTypes.length ? { relationTypes } : {}),
            ...(includeHierarchy !== null ? { includeHierarchy: includeHierarchy === "true" } : {}),
          });
          if (result.status === "found") json(response, 200, result.neighborhood);
          else json(response, 404, { error: result.status, message: "This Note is unavailable." });
          return true;
        }
        if (maintenance.test(url.pathname)) {
          if (request.method !== "GET") { response.setHeader("allow", "GET"); json(response, 405, { error: "method_not_allowed", message: "Use GET for relationship maintenance." }); return true; }
          const result = await relationships.maintenance(member.accountId, decodeURIComponent(segments[3]!), {
            ...(url.searchParams.has("limit") ? { limit: Number(url.searchParams.get("limit")) } : {}),
            ...(url.searchParams.has("cursor") ? { cursor: url.searchParams.get("cursor") } : {}),
          });
          if (result.status === "found") json(response, 200, { orphans: result.orphans, brokenLinks: result.brokenLinks,
            ...(result.nextCursor ? { nextCursor: result.nextCursor } : {}) });
          else json(response, 403, { error: result.status, message: "This Workspace is unavailable." });
          return true;
        }
      } catch (error) {
        if (error instanceof InvalidRelationshipQuery || error instanceof URIError)
          json(response, 422, { error: "invalid_input", message: "The relationship request is invalid." });
        else if (error instanceof SyntaxError || error instanceof Error && error.message === "body_too_large")
          json(response, 422, { error: "invalid_input", message: "The relationship request is invalid." });
        else json(response, 500, { error: "relationship_unavailable", message: "Note relationships are temporarily unavailable." });
      }
      return true;
    },
  };
}
