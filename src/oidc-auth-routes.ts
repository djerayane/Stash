import { json, readJson, type HttpRoute } from "./http-routing.js";
import {
  InvalidOidcRequest,
  OidcAuthService,
  OidcIdentityNotAuthorized,
  OidcProviderRejected,
} from "./oidc-auth.js";
import { OidcManagementNotAuthorized, type OidcManagementService } from "./oidc-management.js";
import type { PasswordAuthService } from "./password-auth.js";

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

export function oidcManagementRoute(service: OidcManagementService, sessions: PasswordAuthService): HttpRoute {
  return {
    matches: (_request, url) => /^\/api\/organizations\/[^/]+\/auth\/oidc(?:\/identities)?$/.test(url.pathname),
    async handle(request, response, url) {
      try {
        const member = await sessions.authenticateBearer(request.headers.authorization);
        if (!member) {
          json(response, 401, { error: "unauthorized", message: "A valid Member session is required." });
          return true;
        }
        const match = url.pathname.match(/^\/api\/organizations\/([^/]+)\/auth\/oidc(\/identities)?$/)!;
        const organizationId = decodeURIComponent(match[1]!);
        if (request.method === "PUT" && !match[2]) {
          await service.configure(member.accountId, organizationId, await readJson(request));
          response.writeHead(204).end();
          return true;
        }
        if (request.method === "POST" && match[2]) {
          await service.linkIdentity(member.accountId, organizationId, await readJson(request));
          response.writeHead(204).end();
          return true;
        }
        return false;
      } catch (error) {
        if (error instanceof OidcManagementNotAuthorized) {
          json(response, 403, { error: "forbidden", message: "Organization Owner or Admin permission is required." });
        } else if (error instanceof InvalidOidcRequest) {
          json(response, 422, { error: "invalid_input", message: "The submitted OpenID Connect configuration is invalid." });
        } else if (error instanceof OidcIdentityNotAuthorized) {
          json(response, 422, { error: "member_not_found", message: "The identity must be linked to an existing Organization Member." });
        } else if (error instanceof SyntaxError) {
          json(response, 400, { error: "invalid_json", message: "Request body must be valid JSON." });
        } else {
          json(response, 503, { error: "authentication_unavailable", message: "Authentication is temporarily unavailable. Try again." });
        }
        return true;
      }
    },
  };
}
