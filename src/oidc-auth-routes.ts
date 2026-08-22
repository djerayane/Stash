import { json, type HttpRoute } from "./http-routing.js";
import {
  InvalidOidcRequest,
  OidcAuthService,
  OidcIdentityNotAuthorized,
  OidcProviderRejected,
} from "./oidc-auth.js";

function callbackUri(request: Parameters<HttpRoute["handle"]>[0], organizationId: string): string {
  const forwardedProtocol = request.headers["x-forwarded-proto"];
  const protocol = typeof forwardedProtocol === "string" ? forwardedProtocol : "http";
  const host = request.headers.host;
  if (!host) throw new InvalidOidcRequest();
  return `${protocol}://${host}/api/auth/oidc/${encodeURIComponent(organizationId)}/callback`;
}

export function oidcAuthRoute(service: OidcAuthService): HttpRoute {
  return {
    matches: (_request, url) => url.pathname.startsWith("/api/auth/oidc/"),
    async handle(request, response, url) {
      const callback = url.pathname.match(/^\/api\/auth\/oidc\/([^/]+)\/callback$/);
      const start = url.pathname.match(/^\/api\/auth\/oidc\/([^/]+)$/);
      try {
        if (request.method === "GET" && callback) {
          const organizationId = decodeURIComponent(callback[1]!);
          const result = await service.complete(
            organizationId,
            url.searchParams.get("code"),
            url.searchParams.get("state"),
            request.headers["user-agent"],
          );
          json(response, 201, result);
          return true;
        }
        if (request.method === "GET" && start) {
          const organizationId = decodeURIComponent(start[1]!);
          json(response, 200, await service.begin(organizationId, callbackUri(request, organizationId)));
          return true;
        }
        return false;
      } catch (error) {
        if (error instanceof InvalidOidcRequest) {
          json(response, 422, { error: "invalid_oidc_request", message: "The OpenID Connect request is invalid or expired." });
        } else if (error instanceof OidcIdentityNotAuthorized) {
          json(response, 403, { error: "oidc_identity_not_authorized", message: "This OpenID Connect identity is not linked to an Organization Member." });
        } else if (error instanceof OidcProviderRejected) {
          json(response, 502, { error: "oidc_provider_rejected", message: "The OpenID Connect provider response could not be accepted. Try again." });
        } else {
          json(response, 503, { error: "authentication_unavailable", message: "Authentication is temporarily unavailable. Try again." });
        }
        return true;
      }
    },
  };
}
