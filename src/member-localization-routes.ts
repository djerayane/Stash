import { json, readJson, type HttpRoute } from "./http-routing.js";
import {
  InvalidLocalizationPreferences,
  InvalidLocalizationRenderRequest,
  type MemberLocalizationService,
} from "./member-localization.js";
import type { MemberAccessResolver } from "./workspaces-projects.js";

export function memberLocalizationRoutes(
  service: MemberLocalizationService,
  memberAccess: MemberAccessResolver,
): HttpRoute {
  return {
    matches: (_request, url) => url.pathname === "/api/member/localization"
      || url.pathname === "/api/member/localization/render",
    async handle(request, response, url) {
      const access = await memberAccess.authenticateBearer(request.headers.authorization);
      if (!access) {
        json(response, 401, { error: "unauthorized", message: "A valid Member session is required." });
        return true;
      }
      try {
        if (request.method === "GET" && url.pathname.endsWith("/render")) {
          json(response, 200, await service.render(
            access.accountId,
            url.searchParams.get("message"),
            url.searchParams.get("timestamp"),
          ));
          return true;
        }
        if (request.method === "GET" && url.pathname === "/api/member/localization") {
          json(response, 200, await service.get(access.accountId));
          return true;
        }
        if (request.method === "PUT" && url.pathname === "/api/member/localization") {
          json(response, 200, await service.update(access.accountId, await readJson(request)));
          return true;
        }
        json(response, 405, { error: "method_not_allowed", message: "This localization operation is not supported." });
      } catch (error) {
        if (error instanceof InvalidLocalizationPreferences || error instanceof InvalidLocalizationRenderRequest) {
          json(response, 422, {
            error: "invalid_input",
            message: error instanceof InvalidLocalizationPreferences
              ? "Locale, time zone, date format, and week start must be valid."
              : "A supported message and an ISO 8601 timestamp with an offset are required.",
          });
        } else if (error instanceof SyntaxError) {
          json(response, 400, { error: "invalid_json", message: "Request body must be valid JSON." });
        } else {
          json(response, 503, { error: "localization_unavailable", message: "Localization preferences are temporarily unavailable." });
        }
      }
      return true;
    },
  };
}
