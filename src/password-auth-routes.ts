import { json, readJson, type HttpRoute } from "./http-routing.js";
import {
  InvalidAuthenticationInput,
  InvalidCredentials,
  type AuthenticatedMember,
  type PasswordAuthService,
} from "./password-auth.js";

function errorResponse(response: Parameters<HttpRoute["handle"]>[1], error: unknown): void {
  if (error instanceof Error && error.message === "body_too_large") {
    json(response, 413, { error: "body_too_large", message: "Request body exceeds the 64 KiB limit." });
  } else if (error instanceof InvalidAuthenticationInput) {
    json(response, 422, { error: "invalid_input", message: "The submitted authentication input is invalid." });
  } else if (error instanceof InvalidCredentials) {
    json(response, 401, { error: "invalid_credentials", message: "The email or password is incorrect." });
  } else if (error instanceof SyntaxError) {
    json(response, 400, { error: "invalid_json", message: "Request body must be valid JSON." });
  } else {
    json(response, 503, { error: "authentication_unavailable", message: "Authentication is temporarily unavailable. Try again." });
  }
}

async function authenticate(service: PasswordAuthService, authorization: string | undefined, response: Parameters<HttpRoute["handle"]>[1]) {
  const member = await service.authenticateBearer(authorization);
  if (!member) json(response, 401, { error: "unauthorized", message: "A valid Member session is required." });
  return member;
}

export function passwordAuthRoute(service: PasswordAuthService): HttpRoute {
  return {
    matches: (_request, url) => url.pathname.startsWith("/api/auth/"),
    async handle(request, response, url) {
      try {
        if (request.method === "POST" && url.pathname === "/api/auth/sessions") {
          const result = await service.signIn(await readJson(request), request.headers["user-agent"]);
          json(response, 201, result);
          return true;
        }

        const member: AuthenticatedMember | undefined = await authenticate(service, request.headers.authorization, response);
        if (!member) return true;

        if (request.method === "GET" && url.pathname === "/api/auth/sessions") {
          json(response, 200, { sessions: await service.sessions(member) });
          return true;
        }
        if (request.method === "DELETE" && url.pathname === "/api/auth/session") {
          await service.revoke(member, member.sessionId);
          response.writeHead(204).end();
          return true;
        }
        const sessionMatch = url.pathname.match(/^\/api\/auth\/sessions\/([^/]+)$/);
        if (request.method === "DELETE" && sessionMatch) {
          const deleted = await service.revoke(member, decodeURIComponent(sessionMatch[1]!));
          if (!deleted) json(response, 404, { error: "session_not_found", message: "No such Member session exists." });
          else response.writeHead(204).end();
          return true;
        }
        if (request.method === "PUT" && url.pathname === "/api/auth/password") {
          await service.changePassword(member, await readJson(request));
          response.writeHead(204).end();
          return true;
        }
        return false;
      } catch (error) {
        errorResponse(response, error);
        return true;
      }
    },
  };
}
