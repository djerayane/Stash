import { json, readJson, type HttpRoute } from "./http-routing.js";
import {
  InvalidRegistrationInput,
  RegistrationConflict,
  type AccountRegistrationService,
} from "./account-registration.js";

export type AuthenticationFailureReporter = (event: {
  operation: "password_sign_in" | "registration" | "client_session";
  cause: unknown;
}) => void;

export function accountRegistrationRoute(
  service: AccountRegistrationService | undefined,
  reportFailure?: AuthenticationFailureReporter,
): HttpRoute {
  return {
    matches: (_request, url) => url.pathname === "/api/auth/registration",
    async handle(request, response) {
      if (request.method === "GET") {
        json(response, 200, { enabled: Boolean(service) });
        return true;
      }
      if (request.method !== "POST") {
        json(response, 405, { error: "method_not_allowed", message: "Account registration accepts GET and POST requests." });
        return true;
      }
      if (!service) {
        json(response, 403, { error: "registration_closed", message: "Account registration is disabled on this Instance." });
        return true;
      }
      try {
        json(response, 201, await service.register(await readJson(request), request.headers["user-agent"]));
      } catch (error) {
        if (error instanceof Error && error.message === "body_too_large") {
          json(response, 413, { error: "body_too_large", message: "Request body exceeds the 64 KiB limit." });
        } else if (error instanceof InvalidRegistrationInput) {
          json(response, 422, { error: "invalid_input", message: "Name, email, and password must be valid." });
        } else if (error instanceof RegistrationConflict) {
          json(response, 409, { error: "account_exists", message: "An account with this email already exists." });
        } else if (error instanceof SyntaxError) {
          json(response, 400, { error: "invalid_json", message: "Request body must be valid JSON." });
        } else {
          reportFailure?.({ operation: "registration", cause: error });
          json(response, 503, { error: "registration_unavailable", message: "Account registration is temporarily unavailable. Try again." });
        }
      }
      return true;
    },
  };
}
