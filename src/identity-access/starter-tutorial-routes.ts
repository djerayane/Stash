import { json, readJson, type HttpRoute } from "../http-routing.js";
import type { MemberAccessResolver } from "../workspaces-projects.js";
import { InvalidStarterTutorialInput, type StarterTutorialService } from "./starter-tutorial.js";

const tutorialPath = /^\/api\/notes\/([^/]+)\/starter-tutorial(?:\/collection)?$/;

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
        const collection = url.pathname.endsWith("/collection");
        const tutorial = request.method === "GET" && !collection
          ? await service.read(member.accountId, rootNoteId)
          : request.method === "PUT" && collection
            ? await service.renameCollection(member.accountId, rootNoteId, await readJson(request))
            : undefined;
        if ((request.method !== "GET" || collection) && (request.method !== "PUT" || !collection)) {
          json(response, 405, { error: "method_not_allowed", message: "This tutorial operation is not supported." });
        } else if (!tutorial) {
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
