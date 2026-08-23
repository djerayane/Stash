import { createServer, type ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, resolve, sep } from "node:path";

import {
  createOptionalRedisAcceleration,
  type OptionalRedisAcceleration,
} from "./acceleration.js";
import { ownerBootstrapRoute } from "./bootstrap-route.js";
import { diagnosticsAdminRoute, diagnosticsSchemaRoute } from "./diagnostics-routes.js";
import { createDiagnostics, type Diagnostics } from "./diagnostics.js";
import { json, requireInstanceAdministrator } from "./http-routing.js";
import { instanceAdminRoute } from "./instance-route.js";
import { noteEditorRoute, noteLibraryRoute, noteRoutes } from "./note-routes.js";
import { noteEditorAssetRoute } from "./note-editor-assets.js";
import type { NoteService } from "./notes.js";
import type { OwnerBootstrapService } from "./owner-bootstrap.js";
import { organizationRoleRoutes } from "./organization-role-routes.js";
import type { OrganizationRoleService } from "./organization-roles.js";
import { oidcAuthRoute, oidcManagementRoute } from "./oidc-auth-routes.js";
import type { OidcAuthService } from "./oidc-auth.js";
import type { OidcManagementService } from "./oidc-management.js";
import { passwordAuthRoute } from "./password-auth-routes.js";
import type { PasswordAuthService } from "./password-auth.js";
import { workspaceProjectRoutes } from "./workspace-project-routes.js";
import type { MemberAccessResolver, WorkspaceProjectService } from "./workspaces-projects.js";
import { accountRecoveryRoute } from "./account-recovery-routes.js";
import type { AccountRecoveryService } from "./account-recovery.js";
import { memberLocalizationRoutes } from "./member-localization-routes.js";
import type { MemberLocalizationService } from "./member-localization.js";
import { invitationRoutes } from "./invitation-routes.js";
import type { InvitationService } from "./invitations.js";
import { repositoryConnectionRoutes } from "./repository-connection-routes.js";
import type { RepositoryConnectionService } from "./repository-connections.js";
import { taskRoutes } from "./task-routes.js";
import type { TaskService } from "./tasks.js";
import { attachmentRoutes } from "./attachment-routes.js";
import type { AttachmentService } from "./attachments.js";
import { mobileCaptureRoutes } from "./mobile-capture-routes.js";
import type { MobileCaptureService } from "./mobile-captures.js";
import { discussionRoutes } from "./discussion-routes.js";
import type { DiscussionService } from "./discussions.js";
import { projectWorkflowRoutes } from "./project-workflow-routes.js";
import type { ProjectWorkflowService } from "./project-workflows.js";
import { portableWorkspaceExportRoute } from "./portable-workspace-export-route.js";
import type { PortableWorkspaceExportService } from "./portable-workspace-export.js";
import { portableWorkspaceImportRoute } from "./portable-workspace-import-route.js";
import type { PortableWorkspaceImportService } from "./portable-workspace-import.js";
import { boardRoutes } from "./board-routes.js";
import type { BoardService } from "./boards.js";
import { boardSurfaceRoute } from "./board-surface.js";
import { noteLinkRoutes } from "./note-link-routes.js";
import type { NoteLinkService } from "./note-links.js";
import { activityRoutes } from "./activity-routes.js";
import type { ActivityService } from "./activity.js";
import { githubArtifactRoutes } from "./github-artifact-routes.js";
import type { GitHubArtifactService } from "./github-artifacts.js";
import { githubSignalRoutes, githubWebhookRoute } from "./github-signal-routes.js";
import type { GitHubSignalService } from "./github-signals.js";
import { publicDomainApiRoute } from "./public-domain-api.js";
import { instanceBackupRoute } from "./instance-backup-routes.js";
import type { InstanceBackupRestoreTarget, InstanceBackupService } from "./instance-backup.js";
import { notificationRoutes } from "./notification-routes.js";
import type { NotificationService } from "./notifications.js";
import { automationRoutes } from "./automation-routes.js";
import type { AutomationService } from "./automations.js";
import { noteCollaborationRoutes } from "./note-collaboration-routes.js";
import type { NoteCollaborationService } from "./note-collaboration.js";
import { importedIdentityAdministrationRoutes, type ImportedIdentityAdministration } from "./imported-identity-administration-routes.js";
import { workspaceSearchRoutes } from "./workspace-search-routes.js";
import type { WorkspaceSearchService } from "./workspace-search.js";
import { agentGrantRoutes } from "./agent-grant-routes.js";
import { mcpRoute } from "./mcp-route.js";
import type { AgentGrantService } from "./agent-grants.js";
import { instanceUpgradeRoute } from "./instance-upgrade-routes.js";
import type { InstanceUpgradeService } from "./instance-upgrade.js";

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
  host: string;
  port: number;
  instanceAdminToken: string;
  ownerBootstrap?: OwnerBootstrapService;
  passwordAuth?: PasswordAuthService;
  workspaceProjects?: WorkspaceProjectService;
  notes?: NoteService;
  noteCollaboration?: NoteCollaborationService;
  memberAccess?: MemberAccessResolver;
  organizationRoles?: OrganizationRoleService;
  memberLocalization?: MemberLocalizationService;
  oidcAuth?: OidcAuthService;
  oidcManagement?: OidcManagementService;
  oidcCallbackOrigin?: string;
  allowInsecureOidcCallbackOriginForTest?: boolean;
  accountRecovery?: AccountRecoveryService;
  invitations?: InvitationService;
  diagnostics?: Diagnostics;
  acceleration?: OptionalRedisAcceleration;
  repositoryConnections?: RepositoryConnectionService;
  tasks?: TaskService;
  attachments?: AttachmentService;
  mobileCaptures?: MobileCaptureService;
  discussions?: DiscussionService;
  projectWorkflows?: ProjectWorkflowService;
  portableWorkspaceExports?: PortableWorkspaceExportService;
  portableWorkspaceImports?: PortableWorkspaceImportService;
  boards?: BoardService;
  noteLinks?: NoteLinkService;
  activities?: ActivityService;
  githubArtifacts?: GitHubArtifactService;
  githubSignals?: GitHubSignalService;
  webClientRoot?: string;
  instanceBackups?: InstanceBackupService;
  instanceBackupRoot?: string;
  instanceBackupRestoreTarget?: InstanceBackupRestoreTarget;
  notifications?: NotificationService;
  automations?: AutomationService;
  importedIdentityAdministration?: ImportedIdentityAdministration;
  searches?: WorkspaceSearchService;
  agentGrants?: AgentGrantService;
  mcpEnabled?: boolean;
  instanceUpgrades?: InstanceUpgradeService;
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
  let oidcCallbackOrigin: string | undefined;
  if (options.oidcAuth) {
    if (!options.oidcCallbackOrigin) throw new Error("PUBLIC_ORIGIN must be configured when OpenID Connect is enabled");
    let origin: URL;
    try { origin = new URL(options.oidcCallbackOrigin); } catch { throw new Error("PUBLIC_ORIGIN must be a valid absolute URL"); }
    if (origin.origin !== origin.href.replace(/\/$/, "") || origin.username || origin.password
      || (origin.protocol !== "https:" && !(options.allowInsecureOidcCallbackOriginForTest && origin.protocol === "http:"))) {
      throw new Error("PUBLIC_ORIGIN must be an HTTPS origin without credentials, path, query, or fragment");
    }
    oidcCallbackOrigin = origin.origin;
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
  const memberAccess = options.memberAccess ?? options.passwordAuth;
  const publicDomainRoutes = memberAccess ? [
    ...(options.memberLocalization ? [memberLocalizationRoutes(options.memberLocalization, memberAccess)] : []),
    ...(options.workspaceProjects ? [workspaceProjectRoutes(options.workspaceProjects, memberAccess)] : []),
    ...(options.organizationRoles ? [organizationRoleRoutes(options.organizationRoles, memberAccess)] : []),
    ...(options.invitations ? [invitationRoutes(options.invitations, memberAccess)] : []),
    ...(options.notes ? [noteRoutes(options.notes, memberAccess)] : []),
    ...(options.noteCollaboration ? [noteCollaborationRoutes(options.noteCollaboration, memberAccess)] : []),
    ...(options.noteLinks ? [noteLinkRoutes(options.noteLinks, memberAccess)] : []),
    ...(options.tasks ? [taskRoutes(options.tasks, memberAccess)] : []),
    ...(options.projectWorkflows ? [projectWorkflowRoutes(options.projectWorkflows, memberAccess)] : []),
    ...(options.boards ? [boardRoutes(options.boards, memberAccess)] : []),
    ...(options.attachments ? [attachmentRoutes(options.attachments, memberAccess)] : []),
    ...(options.discussions ? [discussionRoutes(options.discussions, memberAccess)] : []),
    ...(options.portableWorkspaceExports ? [portableWorkspaceExportRoute(options.portableWorkspaceExports, memberAccess)] : []),
    ...(options.activities ? [activityRoutes(options.activities, memberAccess)] : []),
    ...(options.notifications ? [notificationRoutes(options.notifications, memberAccess)] : []),
    ...(options.repositoryConnections ? [repositoryConnectionRoutes(options.repositoryConnections, memberAccess)] : []),
    ...(options.githubArtifacts ? [githubArtifactRoutes(options.githubArtifacts, memberAccess)] : []),
    ...(options.githubSignals ? [githubSignalRoutes(options.githubSignals, memberAccess)] : []),
    ...(options.automations ? [automationRoutes(options.automations, memberAccess)] : []),
    ...(options.importedIdentityAdministration ? [importedIdentityAdministrationRoutes(options.importedIdentityAdministration, memberAccess)] : []),
    ...(options.searches ? [workspaceSearchRoutes(options.searches, memberAccess)] : []),
    ...(options.agentGrants ? [agentGrantRoutes(options.agentGrants, memberAccess,
      { ...(options.notes ? { notes: options.notes } : {}), ...(options.tasks ? { tasks: options.tasks } : {}) })] : []),
  ] : [];
  const applicationRoutes = [
    boardSurfaceRoute(),
    noteEditorAssetRoute(),
    noteEditorRoute(),
    noteLibraryRoute(),
    ...(options.oidcManagement && options.passwordAuth ? [oidcManagementRoute(options.oidcManagement, options.passwordAuth)] : []),
    ...(options.oidcAuth && oidcCallbackOrigin ? [oidcAuthRoute(options.oidcAuth, oidcCallbackOrigin)] : []),
    ...(options.accountRecovery && options.passwordAuth ? [accountRecoveryRoute(options.accountRecovery, {
      resolve: (authorization) => options.passwordAuth!.authenticateBearer(authorization),
    })] : []),
    ...(options.passwordAuth ? [passwordAuthRoute(options.passwordAuth)] : []),
    diagnosticsSchemaRoute(diagnostics),
    requireInstanceAdministrator(options.instanceAdminToken, diagnosticsAdminRoute(diagnostics)),
    requireInstanceAdministrator(options.instanceAdminToken, instanceAdminRoute(acceleration)),
    ...(options.instanceBackups ? [requireInstanceAdministrator(options.instanceAdminToken, instanceBackupRoute(options.instanceBackups, options.instanceBackupRoot, options.instanceBackupRestoreTarget))] : []),
    ...(options.instanceUpgrades ? [requireInstanceAdministrator(options.instanceAdminToken, instanceUpgradeRoute(options.instanceUpgrades))] : []),
    requireInstanceAdministrator(
      options.instanceAdminToken,
      ownerBootstrapRoute(options.ownerBootstrap),
    ),
    ...(options.portableWorkspaceImports
      ? [requireInstanceAdministrator(options.instanceAdminToken, portableWorkspaceImportRoute(options.portableWorkspaceImports))] : []),
    ...publicDomainRoutes,
    ...(options.mobileCaptures && (options.memberAccess ?? options.passwordAuth)
      ? [mobileCaptureRoutes(options.mobileCaptures, (options.memberAccess ?? options.passwordAuth)!)]
      : []),
  ];
  const routes = [
    ...(options.githubSignals ? [githubWebhookRoute(options.githubSignals)] : []),
    ...(options.agentGrants ? [mcpRoute(options.agentGrants, options.mcpEnabled === true,
      { ...(options.notes ? { notes: options.notes } : {}), ...(options.tasks ? { tasks: options.tasks } : {}) })] : []),
    publicDomainApiRoute(publicDomainRoutes), ...applicationRoutes,
  ];

  let activeApplicationRequests = 0;
  const restoreDrainWaiters = new Set<() => void>();
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

    if (request.method === "GET" && url.pathname === "/" && !options.webClientRoot) {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end(browserSurface);
      return;
    }

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
    if (url.pathname.startsWith("/api/") && !operationalRestoreRequest && !operationalUpgradeRequest) trackApplicationRequest(response);

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
        } catch {
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
