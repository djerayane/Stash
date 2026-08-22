import { createServer, type IncomingMessage, type ServerResponse } from "node:http";

import {
  createOptionalRedisAcceleration,
  type OptionalRedisAcceleration,
} from "./acceleration.js";
import { createDiagnostics, type DiagnosticSettings, type Diagnostics } from "./diagnostics.js";
import { InvalidBootstrapInput, type OwnerBootstrapService } from "./owner-bootstrap.js";

export interface DatabaseProbe {
  verifyConnection(): Promise<void>;
  close(): Promise<void>;
}

export interface RunningInstance {
  url: string;
  close(): Promise<void>;
}

interface InstanceOptions {
  database: DatabaseProbe;
  host: string;
  port: number;
  instanceAdminToken: string;
  ownerBootstrap?: OwnerBootstrapService;
  diagnostics?: Diagnostics;
  acceleration?: OptionalRedisAcceleration;
}

interface InstanceSummary {
  name: string;
  status: "running";
}

const instanceSummaryCodec = {
  encode: JSON.stringify,
  decode(value: string): InstanceSummary {
    const decoded: unknown = JSON.parse(value);
    if (
      !decoded ||
      typeof decoded !== "object" ||
      !("name" in decoded) ||
      decoded.name !== "Stash" ||
      !("status" in decoded) ||
      decoded.status !== "running"
    ) {
      throw new Error("invalid cached Instance summary");
    }
    return { name: decoded.name, status: decoded.status };
  },
};

const browserSurface = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>Stash</title>
    <style>
      :root { color-scheme: light dark; font-family: system-ui, sans-serif; }
      body { display: grid; min-height: 100vh; margin: 0; place-items: center; }
      main { max-width: 38rem; padding: 2rem; }
    </style>
  </head>
  <body><main><h1>Stash</h1><p>This Instance is running.</p></main></body>
</html>`;

function json(response: ServerResponse, status: number, body: object): void {
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  response.end(JSON.stringify(body));
}

function isAuthorized(request: IncomingMessage, token: string): boolean {
  return request.headers.authorization === `Bearer ${token}`;
}

async function readJson(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > 64 * 1024) throw new Error("body_too_large");
    chunks.push(buffer);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

export async function startInstance(options: InstanceOptions): Promise<RunningInstance> {
  if (!options.instanceAdminToken) {
    throw new Error("INSTANCE_ADMIN_TOKEN must not be empty");
  }

  const diagnostics = options.diagnostics ?? createDiagnostics({
    instanceVersion: "0.1.0",
    transport: {
      async submit() {
        throw new Error("No diagnostic transport is configured");
      },
    },
  });
  diagnostics.record({ kind: "instance_started", occurredAt: new Date().toISOString() });
  const acceleration = options.acceleration ?? createOptionalRedisAcceleration();

  const server = createServer(async (request, response) => {
    const url = new URL(request.url ?? "/", "http://stash.invalid");

    if (request.method === "GET" && url.pathname === "/") {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end(browserSurface);
      return;
    }

    if (request.method === "GET" && url.pathname === "/health/live") {
      json(response, 200, { status: "ok" });
      return;
    }

    if (request.method === "GET" && url.pathname === "/health/ready") {
      try {
        await options.database.verifyConnection();
        json(response, 200, { status: "ready" });
      } catch {
        json(response, 503, { status: "unavailable", error: "database_unavailable" });
      }
      return;
    }

    if (request.method === "GET" && url.pathname === "/api/diagnostics/schema") {
      json(response, 200, diagnostics.schema());
      return;
    }

    if (url.pathname.startsWith("/api/diagnostics")) {
      if (!isAuthorized(request, options.instanceAdminToken)) {
        json(response, 401, {
          error: "unauthorized",
          message: "A valid Instance Administrator bearer token is required.",
        });
        return;
      }

      if (request.method === "GET" && url.pathname === "/api/diagnostics") {
        json(response, 200, { settings: diagnostics.settings(), pending: diagnostics.pending() });
        return;
      }

      if (request.method === "PUT" && url.pathname === "/api/diagnostics/settings") {
        try {
          const body = await readJson(request);
          if (!isDiagnosticSettings(body)) throw new Error("invalid_settings");
          diagnostics.configure(body);
          json(response, 200, { settings: diagnostics.settings() });
        } catch (error) {
          const tooLarge = error instanceof Error && error.message === "body_too_large";
          json(response, tooLarge ? 413 : 400, {
            error: tooLarge ? "body_too_large" : "invalid_settings",
            message: tooLarge
              ? "Request body exceeds the 64 KiB limit."
              : "Diagnostic settings must contain three boolean choices.",
          });
        }
        return;
      }

      if (request.method === "POST" && url.pathname === "/api/diagnostics/submit") {
        const result = await diagnostics.submitPending();
        json(response, result.status === "failed" ? 503 : 200, result);
        return;
      }
    }

    if (url.pathname === "/api/instance") {
      if (!isAuthorized(request, options.instanceAdminToken)) {
        json(response, 401, {
          error: "unauthorized",
          message: "A valid Instance Administrator bearer token is required.",
        });
        return;
      }

      if (request.method === "GET") {
        const summary = await acceleration.readThrough({
          key: "stash:instance:summary:v1",
          codec: instanceSummaryCodec,
          loadAuthoritative: async () => ({ name: "Stash", status: "running" }),
        });
        json(response, 200, summary);
        return;
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
        return;
      }
    }

    if (request.method === "POST" && url.pathname === "/api/instance/organizations/bootstrap") {
      if (!isAuthorized(request, options.instanceAdminToken)) {
        json(response, 401, {
          error: "unauthorized",
          message: "A valid Instance Administrator bearer token is required.",
        });
        return;
      }

      try {
        const input = await readJson(request);
        if (!options.ownerBootstrap) throw new Error("bootstrap_not_configured");
        const result = await options.ownerBootstrap.bootstrap(input);
        if (!result) {
          json(response, 409, {
            error: "already_bootstrapped",
            message: "The first Organization Owner has already been created.",
          });
          return;
        }
        json(response, 201, result);
      } catch (error) {
        if (error instanceof InvalidBootstrapInput) {
          json(response, 422, {
            error: "invalid_input",
            message: "organizationName, ownerName, ownerEmail, and password must be valid.",
          });
          return;
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
          return;
        }
        json(response, 503, {
          error: "bootstrap_unavailable",
          message: "The first Organization Owner could not be created. Try again.",
        });
      }
      return;
    }

    json(response, 404, {
      error: "not_found",
      message: "No Stash surface exists at this path.",
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port, options.host, resolve);
  });

  const address = server.address();
  if (!address || typeof address === "string") {
    server.close();
    throw new Error("Stash Instance did not bind to a TCP address");
  }

  return {
    url: `http://${options.host}:${address.port}`,
    async close() {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
      await options.database.close();
    },
  };
}

function isDiagnosticSettings(value: unknown): value is DiagnosticSettings {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const settings = value as Record<string, unknown>;
  return Object.keys(settings).length === 3
    && typeof settings.diagnosticSubmissions === "boolean"
    && typeof settings.crashReportSubmissions === "boolean"
    && typeof settings.updateChecks === "boolean";
}
