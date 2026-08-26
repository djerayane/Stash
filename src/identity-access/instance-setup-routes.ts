import type { IncomingMessage } from "node:http";

import { json, readJson, type HttpRoute } from "../http-routing.js";
import {
  ExpiredSetupCode,
  InvalidInstanceSetupInput,
  InvalidSetupCode,
  SetupCodeRequired,
  type InstanceSetupService,
} from "./instance-setup.js";

function connection(request: IncomingMessage) {
  return {
    ...(request.socket.localAddress ? { localAddress: request.socket.localAddress } : {}),
    ...(request.socket.remoteAddress ? { remoteAddress: request.socket.remoteAddress } : {}),
  };
}

export function instanceSetupRoutes(service: InstanceSetupService): HttpRoute {
  return {
    matches(request, url) {
      return request.method === "GET" && url.pathname === "/api/instance/setup-state"
        || request.method === "POST" && url.pathname === "/api/instance/setup";
    },
    async handle(request, response) {
      try {
        if (request.method === "GET") {
          json(response, 200, { state: await service.state(connection(request)) });
          return true;
        }
        const result = await service.setup(await readJson(request), connection(request), request.headers["user-agent"]);
        if (!result) {
          json(response, 409, { error: "setup_complete", message: "This Instance has already been set up." });
          return true;
        }
        json(response, 201, result);
      } catch (error) {
        if (error instanceof InvalidInstanceSetupInput) {
          json(response, 422, { error: "invalid_input", message: "Name, email, password, and Workspace name must be valid." });
        } else if (error instanceof SetupCodeRequired) {
          json(response, 403, { error: "setup_code_required", message: "Enter the setup code shown in the Instance startup output." });
        } else if (error instanceof InvalidSetupCode) {
          json(response, 403, { error: "invalid_setup_code", message: "The setup code is not valid." });
        } else if (error instanceof ExpiredSetupCode) {
          json(response, 410, { error: "setup_code_expired", message: "The setup code has expired. Restart the Instance to generate a new code." });
        } else if (error instanceof SyntaxError || error instanceof Error && error.message === "body_too_large") {
          const tooLarge = error instanceof Error && error.message === "body_too_large";
          json(response, tooLarge ? 413 : 400, { error: tooLarge ? "body_too_large" : "invalid_json",
            message: tooLarge ? "Request body exceeds the 64 KiB limit." : "Request body must be valid JSON." });
        } else {
          json(response, 503, { error: "setup_unavailable", message: "Setup could not be completed. Try again." });
        }
      }
      return true;
    },
  };
}
