import { json, readJson, type HttpRoute } from "./http-routing.js";
import {
  InvalidLocalizationPreferences,
  InvalidLocalizationRenderRequest,
  type MemberLocalizationService,
  type MessageKey,
  type MessageParameters,
} from "./member-localization.js";
import type { MemberAccessResolver } from "./workspaces-projects.js";

export function memberLocalizationRoutes(
  service: MemberLocalizationService,
  memberAccess: MemberAccessResolver,
): HttpRoute {
  const fallbackMessage = (acceptLanguage: string | undefined, key: MessageKey, parameters: MessageParameters = {}) => {
    const requested = acceptLanguage?.split(",", 1)[0]?.split(";", 1)[0]?.trim() || "en";
    try { return service.formatForLocale(requested, key, parameters); }
    catch { return service.formatForLocale("en", key, parameters); }
  };
  return {
    matches: (_request, url) => url.pathname === "/api/member/localization"
      || url.pathname === "/api/member/localization/render",
    async handle(request, response, url) {
      const access = await memberAccess.authenticateBearer(request.headers.authorization);
      if (!access) {
        json(response, 401, {
          error: "unauthorized",
          message: fallbackMessage(request.headers["accept-language"], "error.member_session_required"),
        });
        return true;
      }
      const memberMessage = async (key: MessageKey, parameters: MessageParameters = {}) => {
        try { return await service.formatForMember(access.accountId, key, parameters); }
        catch { return fallbackMessage(request.headers["accept-language"], key, parameters); }
      };
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
          const preferences = await service.update(access.accountId, await readJson(request));
          json(response, 200, {
            ...preferences,
            message: service.formatForLocale(
              preferences.locale,
              "localization.preferences.updated",
              { locale: preferences.locale },
            ),
          });
          return true;
        }
        json(response, 405, {
          error: "method_not_allowed",
          message: await memberMessage("error.localization.method_unsupported"),
        });
      } catch (error) {
        if (error instanceof InvalidLocalizationPreferences || error instanceof InvalidLocalizationRenderRequest) {
          json(response, 422, {
            error: "invalid_input",
            message: await memberMessage(error instanceof InvalidLocalizationPreferences
              ? "error.localization.preferences_invalid"
              : "error.localization.render_invalid"),
          });
        } else if (error instanceof SyntaxError || (error instanceof Error && error.message === "body_too_large")) {
          const tooLarge = error instanceof Error && error.message === "body_too_large";
          json(response, tooLarge ? 413 : 400, {
            error: tooLarge ? "body_too_large" : "invalid_json",
            message: await memberMessage(tooLarge ? "error.body_too_large" : "error.invalid_json"),
          });
        } else {
          json(response, 503, {
            error: "localization_unavailable",
            message: await memberMessage("error.localization.unavailable"),
          });
        }
      }
      return true;
    },
  };
}
