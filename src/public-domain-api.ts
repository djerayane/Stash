import type { HttpRoute } from "./http-routing.js";

export const publicDomainApiVersion = "1";

export function publicDomainApiRoute(domainRoutes: readonly HttpRoute[]): HttpRoute {
  return {
    matches: (_request, url) => url.pathname === "/api/v1" || url.pathname.startsWith("/api/v1/"),
    async handle(request, response, url) {
      response.setHeader("stash-api-version", publicDomainApiVersion);
      if (url.pathname === "/api/v1") {
        if (request.method !== "GET") {
          response.writeHead(405, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
          response.end(JSON.stringify({ error: "method_not_allowed", message: "Only public domain API discovery is available at this path." }));
          return true;
        }
        response.writeHead(200, {
          "content-type": "application/json; charset=utf-8",
          "cache-control": "no-store",
        });
        response.end(JSON.stringify({
          api: "stash.domain",
          version: publicDomainApiVersion,
          authentication: { scheme: "bearer", credential: "member_session" },
          basePath: "/api/v1",
        }));
        return true;
      }

      const domainUrl = new URL(url);
      domainUrl.pathname = `/api${url.pathname.slice("/api/v1".length)}`;
      for (const route of domainRoutes) {
        if (!route.matches(request, domainUrl)) continue;
        return route.handle(request, response, domainUrl);
      }
      return false;
    },
  };
}
