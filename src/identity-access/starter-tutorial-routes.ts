import { json, readJson, type HttpRoute } from "../http-routing.js";
import type { MemberAccessResolver } from "../workspaces-projects.js";
import { InvalidStarterTutorialInput, type StarterTutorialService } from "./starter-tutorial.js";

const tutorialPath = /^\/api\/notes\/([^/]+)\/starter-tutorial(?:\/(collection|view))?$/;

export function starterTutorialRoutes(service: StarterTutorialService, memberAccess: MemberAccessResolver): HttpRoute {
  return {
    matches(_request, url) { return tutorialPath.test(url.pathname); },
    async handle(request, response, url) {
      const member = await memberAccess.authenticateBearer(request.headers.authorization);
      if (!member) {
        json(response, 401, { error: "unauthorized", message: "A valid Member session is required." });
        return true;
      }
      try {
        const rootNoteId = decodeURIComponent(url.pathname.match(tutorialPath)![1]!);
        const operation = url.pathname.match(tutorialPath)?.[2];
        const supported = request.method === "GET" && !operation
          || request.method === "PUT" && (operation === "collection" || operation === "view")
          || request.method === "DELETE" && !operation;
        if (!supported) {
          json(response, 405, { error: "method_not_allowed", message: "This tutorial operation is not supported." });
          return true;
        }
        const tutorial = request.method === "GET" && !operation
          ? await service.read(member.accountId, rootNoteId)
          : request.method === "PUT" && operation === "collection"
            ? await service.updateCollection(member.accountId, rootNoteId, await readJson(request))
            : request.method === "PUT" && operation === "view"
              ? await service.updateViewBlock(member.accountId, rootNoteId, await readJson(request))
              : request.method === "DELETE" && !operation
                ? await service.remove(member.accountId, rootNoteId, await readJson(request))
                : undefined;
        if (tutorial === "removed") {
          json(response, 200, { removed: true });
        } else if (!tutorial || tutorial === "not_found") {
          json(response, 404, { error: "tutorial_not_found", message: "That starter tutorial is not available." });
        } else {
          json(response, 200, { tutorial });
        }
      } catch (error) {
        if (error instanceof InvalidStarterTutorialInput) {
          json(response, 422, { error: "invalid_input", message: "The starter tutorial value must be valid." });
        } else if (error instanceof SyntaxError) {
          json(response, 400, { error: "invalid_json", message: "Request body must be valid JSON." });
        } else {
          json(response, 503, { error: "tutorial_unavailable", message: "The starter tutorial is temporarily unavailable." });
        }
      }
      return true;
    },
  };
}
