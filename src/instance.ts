import { createServer, type ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, resolve, sep } from "node:path";

import {
  createOptionalRedisAcceleration,
  type OptionalRedisAcceleration,
} from "./acceleration.js";
import { createDiagnostics, type Diagnostics } from "./diagnostics.js";
import { json, requireInstanceAdministrator } from "./http-routing.js";
import { instanceAdminRoute } from "./instance-route.js";
import { publicDomainApiRoute } from "./public-domain-api.js";
import type { InstanceUpgradeService } from "./instance-upgrade.js";
import { memberAccessFromCapabilities, publicRoutesFromCapabilities, routesFromCapabilities, type CapabilityRegistry } from "./capability-registry.js";
import type { AuthenticationFailureReporter } from "./account-registration-routes.js";
import type { InstanceBackupService } from "./instance-backup.js";

export interface DatabaseProbe {
  verifyConnection(): Promise<void>;
  close(): Promise<void>;
  resolveClientSessionPrincipal?(accountId: string): Promise<ClientSessionPrincipal | undefined>;
}

export interface ClientSessionPrincipal {
  member: { id: string; name: string; email: string };
  workspace: { id: string; name: string };
  capabilities: string[];
  organizationAdministrations?: Array<{
    organizationId: string;
    organizationName: string;
    members: Array<{ id: string; name: string; email: string; role: "Owner" | "Admin" | "Member" }>;
  }>;
  activeOrganizationId?: string;
}

export interface RunningInstance {
  url: string;
  close(): Promise<void>;
}

export interface InstanceOptions {
  database: DatabaseProbe;
  capabilities: CapabilityRegistry;
  host: string;
  port: number;
  instanceAdminToken: string;
  diagnostics?: Diagnostics;
  acceleration?: OptionalRedisAcceleration;
  webClientRoot?: string;
  instanceBackups?: InstanceBackupService;
  instanceUpgrades?: InstanceUpgradeService;
  reportAuthenticationFailure?: AuthenticationFailureReporter;
}

const webContentTypes: Record<string, string> = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".woff2": "font/woff2",
};

const operationalNamespaces = ["/api", "/health", "/mcp"];

function isOperationalPath(pathname: string): boolean {
  return operationalNamespaces.some((namespace) => pathname === namespace || pathname.startsWith(`${namespace}/`));
}

async function readWebClientFile(root: string, pathname: string): Promise<{ body: Buffer; contentType: string } | undefined> {
  const normalizedRoot = resolve(root);
  let relativePath: string;
  try {
    relativePath = pathname === "/" ? "index.html" : decodeURIComponent(pathname).replace(/^\/+/, "");
  } catch {
    return undefined;
  }
  const filePath = resolve(normalizedRoot, relativePath);
  if (filePath !== normalizedRoot && !filePath.startsWith(`${normalizedRoot}${sep}`)) return undefined;
  try {
    return {
      body: await readFile(filePath),
      contentType: webContentTypes[extname(filePath)] ?? "application/octet-stream",
    };
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && (error.code === "ENOENT" || error.code === "EISDIR")) return undefined;
    throw error;
  }
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
  const memberAccess = memberAccessFromCapabilities(options.capabilities);
  const publicDomainRoutes = publicRoutesFromCapabilities(options.capabilities);
  const applicationRoutes = [
    requireInstanceAdministrator(options.instanceAdminToken, instanceAdminRoute(acceleration)),
  ];
  const routes = [
    ...routesFromCapabilities(options.capabilities),
    publicDomainApiRoute(publicDomainRoutes), ...applicationRoutes,
  ];

  let activeApplicationRequests = 0;
  const restoreDrainWaiters = new Set<() => void>();
  options.instanceBackups?.setBackupUnavailableBarrier(async () => {
    if (activeApplicationRequests === 0) return;
    await new Promise<void>((resolve) => restoreDrainWaiters.add(resolve));
  });
  options.instanceBackups?.setRestoreUnavailableBarrier(async () => {
    if (activeApplicationRequests === 0) return;
    await new Promise<void>((resolve) => restoreDrainWaiters.add(resolve));
  });
  options.instanceUpgrades?.setUnavailableBarrier(async () => {
    if (activeApplicationRequests === 0) return;
    await new Promise<void>((resolve) => restoreDrainWaiters.add(resolve));
  });
  const trackApplicationRequest = (response: ServerResponse) => {
    activeApplicationRequests += 1; let finished = false;
    const finish = () => { if (finished) return; finished = true; activeApplicationRequests -= 1;
      if (activeApplicationRequests === 0) { for (const resolve of restoreDrainWaiters) resolve(); restoreDrainWaiters.clear(); } };
    response.once("finish", finish); response.once("close", finish);
  };

  const server = createServer(async (request, response) => {
    const url = new URL(request.url ?? "/", "http://stash.invalid");

    if (request.method === "GET" && url.pathname === "/health/live") {
      json(response, 200, { status: "ok" });
      return;
    }

    if (request.method === "GET" && url.pathname === "/health/ready") {
      const backupAvailability = options.instanceBackups?.availability();
      if (backupAvailability === "restore_in_progress" || backupAvailability === "restore_restart_required") {
        json(response, 503, { status: "unavailable", error: backupAvailability });
        return;
      }
      const upgradeAvailability = options.instanceUpgrades?.availability();
      if (upgradeAvailability === "upgrade_in_progress" || upgradeAvailability === "upgrade_restart_required") {
        json(response, 503, { status: "unavailable", error: upgradeAvailability }); return;
      }
      try {
        await options.database.verifyConnection();
        json(response, 200, { status: "ready" });
      } catch {
        json(response, 503, { status: "unavailable", error: "database_unavailable" });
      }
      return;
    }

    const backupAvailability = options.instanceBackups?.availability();
    const upgradeAvailability = options.instanceUpgrades?.availability();
    if ((upgradeAvailability === "upgrade_in_progress" || upgradeAvailability === "upgrade_restart_required") && url.pathname.startsWith("/api/") && url.pathname !== "/api/instance/upgrade") {
      json(response, 503, { error: upgradeAvailability, message: upgradeAvailability === "upgrade_in_progress" ? "This Instance is unavailable while an upgrade is applied." : "Restart the Instance to complete the upgrade." }); return;
    }
    const operationalBackupRequest = url.pathname === "/api/instance/backups" && request.method === "POST";
    const operationalRestoreRequest = url.pathname === "/api/instance/backups/health" && (request.method === "GET" || request.method === "HEAD")
      || /^\/api\/instance\/backups\/[^/]+\/restore$/.test(url.pathname) && request.method === "POST";
    const operationalUpgradeRequest = url.pathname === "/api/instance/upgrade";
    if ((backupAvailability === "restore_in_progress" || backupAvailability === "restore_restart_required") && url.pathname.startsWith("/api/")) {
      if (!operationalRestoreRequest) {
        json(response, 503, { error: backupAvailability, message: backupAvailability === "restore_in_progress"
          ? "The Instance is unavailable while its database and Attachments are restored."
          : "The Instance was restored and must be restarted before serving application data." });
        return;
      }
    }
    if (url.pathname.startsWith("/api/") && !operationalBackupRequest && !operationalRestoreRequest && !operationalUpgradeRequest) trackApplicationRequest(response);

    if (request.method === "GET" && url.pathname === "/api/client-session") {
      if (request.headers.authorization === `Bearer ${options.instanceAdminToken}`) {
        json(response, 401, { error: "unauthorized", message: "A valid Member session is required." });
        return;
      }
      const member = await memberAccess?.authenticateBearer(request.headers.authorization);
      if (member) {
        try {
          const principal = await options.database.resolveClientSessionPrincipal?.(member.accountId);
          if (!principal) {
            json(response, 401, { error: "unauthorized", message: "A valid Member session is required." });
            return;
          }
          json(response, 200, { authenticated: true, ...principal });
        } catch (error) {
          options.reportAuthenticationFailure?.({ operation: "client_session", cause: error });
          json(response, 503, { error: "client_session_unavailable", message: "The Member session could not be loaded." });
        }
        return;
      }
      json(response, 401, { error: "unauthorized", message: "Authentication is required." });
      return;
    }

    // PostgreSQL supplies the consistent database snapshot. Holding mutating public boundaries
    // while immutable Attachment files are copied makes their combined state coordinated too.
    if (options.instanceBackups?.isRunning() && request.method !== "GET" && request.method !== "HEAD") {
      json(response, 503, { error: "backup_in_progress", message: "This Instance is temporarily read-only while a coordinated backup is created." });
      return;
    }

    for (const route of routes) {
      if (route.matches(request, url) && await route.handle(request, response, url)) return;
    }

    if (request.method === "GET" && options.webClientRoot && !isOperationalPath(url.pathname)) {
      const requested = await readWebClientFile(options.webClientRoot, url.pathname);
      const acceptsHtml = (request.headers.accept ?? "").includes("text/html");
      const webFile = requested ?? (acceptsHtml ? await readWebClientFile(options.webClientRoot, "/") : undefined);
      if (webFile) {
        response.writeHead(200, { "content-type": webFile.contentType });
        response.end(webFile.body);
        return;
      }
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
      await options.instanceUpgrades?.close();
      await options.database.close();
    },
  };
}
