import type { OptionalRedisAcceleration } from "./acceleration.js";
import { json, readJson, type HttpRoute } from "./http-routing.js";

interface InstanceSummary {
  name: string;
  status: "running";
}

const instanceSummaryCodec = {
  encode: JSON.stringify,
  decode(value: string): InstanceSummary {
    const decoded: unknown = JSON.parse(value);
    if (
      !decoded
      || typeof decoded !== "object"
      || !("name" in decoded)
      || decoded.name !== "Stash"
      || !("status" in decoded)
      || decoded.status !== "running"
    ) {
      throw new Error("invalid cached Instance summary");
    }
    return { name: decoded.name, status: decoded.status };
  },
};

export function instanceAdminRoute(acceleration: OptionalRedisAcceleration): HttpRoute {
  return {
    matches: (_request, url) => url.pathname === "/api/instance",
    async handle(request, response) {
      if (request.method === "GET") {
        const summary = await acceleration.readThrough({
          key: "stash:instance:summary:v1",
          codec: instanceSummaryCodec,
          loadAuthoritative: async () => ({ name: "Stash", status: "running" }),
        });
        json(response, 200, summary);
        return true;
      }

      if (request.method === "POST") {
        try {
          await readJson(request);
          json(response, 405, {
            error: "method_not_allowed",
            message: "This Instance surface is read-only.",
          });
        } catch (error) {
          const tooLarge = error instanceof Error && error.message === "body_too_large";
          json(response, tooLarge ? 413 : 400, {
            error: tooLarge ? "body_too_large" : "invalid_json",
            message: tooLarge
              ? "Request body exceeds the 64 KiB limit."
              : "Request body must be valid JSON.",
          });
        }
        return true;
      }

      return false;
    },
  };
}
