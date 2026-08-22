import { json, readJson, type HttpRoute } from "./http-routing.js";
import { InvalidBootstrapInput, type OwnerBootstrapService } from "./owner-bootstrap.js";

export function ownerBootstrapRoute(ownerBootstrap: OwnerBootstrapService | undefined): HttpRoute {
  return {
    matches: (request, url) =>
      request.method === "POST" && url.pathname === "/api/instance/organizations/bootstrap",
    async handle(request, response) {
      try {
        const input = await readJson(request);
        if (!ownerBootstrap) throw new Error("bootstrap_not_configured");
        const result = await ownerBootstrap.bootstrap(input);
        if (!result) {
          json(response, 409, {
            error: "already_bootstrapped",
            message: "The first Organization Owner has already been created.",
          });
          return true;
        }
        json(response, 201, result);
      } catch (error) {
        if (error instanceof InvalidBootstrapInput) {
          json(response, 422, {
            error: "invalid_input",
            message: "organizationName, ownerName, ownerEmail, and password must be valid.",
          });
          return true;
        }
        const tooLarge = error instanceof Error && error.message === "body_too_large";
        const invalidJson = error instanceof SyntaxError;
        if (tooLarge || invalidJson) {
          json(response, tooLarge ? 413 : 400, {
            error: tooLarge ? "body_too_large" : "invalid_json",
            message: tooLarge
              ? "Request body exceeds the 64 KiB limit."
              : "Request body must be valid JSON.",
          });
          return true;
        }
        json(response, 503, {
          error: "bootstrap_unavailable",
          message: "The first Organization Owner could not be created. Try again.",
        });
      }
      return true;
    },
  };
}
