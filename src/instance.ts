import { createServer } from "node:http";

import {
  createOptionalRedisAcceleration,
  type OptionalRedisAcceleration,
} from "./acceleration.js";
import { ownerBootstrapRoute } from "./bootstrap-route.js";
import { diagnosticsAdminRoute, diagnosticsSchemaRoute } from "./diagnostics-routes.js";
import { createDiagnostics, type Diagnostics } from "./diagnostics.js";
import { json, requireInstanceAdministrator } from "./http-routing.js";
import { instanceAdminRoute } from "./instance-route.js";
import type { OwnerBootstrapService } from "./owner-bootstrap.js";
import { oidcAuthRoute, oidcManagementRoute } from "./oidc-auth-routes.js";
import type { OidcAuthService } from "./oidc-auth.js";
import type { OidcManagementService } from "./oidc-management.js";
import { passwordAuthRoute } from "./password-auth-routes.js";
import type { PasswordAuthService } from "./password-auth.js";
import { workspaceProjectRoutes } from "./workspace-project-routes.js";
import type { MemberAccessResolver, WorkspaceProjectService } from "./workspaces-projects.js";

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
  passwordAuth?: PasswordAuthService;
  workspaceProjects?: WorkspaceProjectService;
  memberAccess?: MemberAccessResolver;
  oidcAuth?: OidcAuthService;
  oidcManagement?: OidcManagementService;
  diagnostics?: Diagnostics;
  acceleration?: OptionalRedisAcceleration;
}

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
  const routes = [
    ...(options.oidcManagement && options.passwordAuth ? [oidcManagementRoute(options.oidcManagement, options.passwordAuth)] : []),
    ...(options.oidcAuth ? [oidcAuthRoute(options.oidcAuth)] : []),
    ...(options.passwordAuth ? [passwordAuthRoute(options.passwordAuth)] : []),
    diagnosticsSchemaRoute(diagnostics),
    requireInstanceAdministrator(options.instanceAdminToken, diagnosticsAdminRoute(diagnostics)),
    requireInstanceAdministrator(options.instanceAdminToken, instanceAdminRoute(acceleration)),
    requireInstanceAdministrator(
      options.instanceAdminToken,
      ownerBootstrapRoute(options.ownerBootstrap),
    ),
    ...(options.workspaceProjects && (options.memberAccess ?? options.passwordAuth)
      ? [workspaceProjectRoutes(
        options.workspaceProjects,
        (options.memberAccess ?? options.passwordAuth)!,
      )]
      : []),
  ];

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

    for (const route of routes) {
      if (route.matches(request, url) && await route.handle(request, response, url)) return;
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
