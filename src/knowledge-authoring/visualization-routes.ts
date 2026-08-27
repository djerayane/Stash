import { json, readJson, type HttpRoute } from "../http-routing.js";
import type { MemberAccessResolver } from "../workspaces-projects.js";
import { InvalidVisualizationBlock, type VisualizationBlockService } from "./visualization-block.js";

const visualization = /^\/api\/notes\/[^/]+\/visualizations\/[^/]+$/;
const promotion = /^\/api\/notes\/[^/]+\/visualizations\/[^/]+\/view-edges\/[^/]+\/promote$/;

export function visualizationRoutes(visualizations: VisualizationBlockService, access: MemberAccessResolver): HttpRoute {
  return {
    matches(_request, url) { return visualization.test(url.pathname) || promotion.test(url.pathname); },
    async handle(request, response, url) {
      try {
        const member = await access.authenticateBearer(request.headers.authorization);
        if (!member) { json(response, 401, { error: "unauthorized", message: "Sign in to inspect Note relationships." }); return true; }
        const segments = url.pathname.split("/");
        const noteId = decodeURIComponent(segments[3]!); const blockId = decodeURIComponent(segments[5]!);
        if (promotion.test(url.pathname)) {
          if (request.method !== "POST") { response.setHeader("allow", "POST"); json(response, 405, { error: "method_not_allowed", message: "Use POST to promote a view-only edge." }); return true; }
          const body = await readJson(request) as { idempotencyKey?: unknown };
          const result = await visualizations.promoteViewEdge(member.accountId, noteId, blockId,
            decodeURIComponent(segments[7]!), body.idempotencyKey);
          if (result.status === "promoted") json(response, 201, result);
          else if (result.status === "already_linked") json(response, 409, { error: result.status, message: "These Notes are already linked." });
          else json(response, 404, { error: result.status, message: "This view-only edge is unavailable." });
          return true;
        }
        if (request.method === "GET") {
          const result = await visualizations.read(member.accountId, noteId, blockId);
          if (result.status === "found") json(response, 200, { block: result.block });
          else json(response, 404, { error: result.status, message: "This Visualization Block is unavailable." });
        } else if (request.method === "PUT") {
          const body = await readJson(request) as { definition?: unknown; expectedRevision?: number; idempotencyKey?: unknown };
          if (!body.definition || typeof body.definition !== "object" || Array.isArray(body.definition)
            || (body.definition as { id?: unknown }).id !== blockId) throw new InvalidVisualizationBlock();
          const result = await visualizations.save(member.accountId, noteId, body.definition, body.expectedRevision, body.idempotencyKey);
          if (result.status === "saved") json(response, 200, { block: result.block });
          else if (result.status === "changed") json(response, 409, { error: result.status, block: result.block,
            message: "This Visualization Block changed. Review the latest saved view." });
          else if (result.status === "idempotency_conflict") json(response, 409, { error: result.status,
            message: "This saved-view command key was already used for another change." });
          else json(response, 404, { error: result.status, message: "This Note is unavailable." });
        } else { response.setHeader("allow", "GET, PUT"); json(response, 405, { error: "method_not_allowed", message: "Use GET or PUT for a Visualization Block." }); }
      } catch (error) {
        if (error instanceof InvalidVisualizationBlock || error instanceof URIError
          || error instanceof SyntaxError || error instanceof Error && error.message === "body_too_large")
          json(response, 422, { error: "invalid_input", message: "The visualization request is invalid." });
        else json(response, 500, { error: "visualization_unavailable", message: "Saved visualizations are temporarily unavailable." });
      }
      return true;
    },
  };
}
