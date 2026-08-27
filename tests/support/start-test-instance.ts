import { accountRecoveryRoute } from "../../src/account-recovery-routes.js";
import type { AccountRecoveryService } from "../../src/account-recovery.js";
import { accountRegistrationRoute } from "../../src/account-registration-routes.js";
import type { AuthenticationFailureReporter } from "../../src/account-registration-routes.js";
import type { AccountRegistrationService } from "../../src/account-registration.js";
import { activityRoutes } from "../../src/activity-routes.js";
import type { ActivityService } from "../../src/activity.js";
import { agentGrantRoutes } from "../../src/agent-grant-routes.js";
import type { AgentGrantService } from "../../src/agent-grants.js";
import { attachmentRoutes } from "../../src/attachment-routes.js";
import type { AttachmentService } from "../../src/attachments.js";
import { automationRoutes } from "../../src/automation-routes.js";
import type { AutomationService } from "../../src/automations.js";
import { boardRoutes } from "../../src/board-routes.js";
import type { BoardService } from "../../src/boards.js";
import { ownerBootstrapRoute } from "../../src/bootstrap-route.js";
import type { OwnerBootstrapService } from "../../src/owner-bootstrap.js";
import { createCapabilityRegistry, type CapabilityModule } from "../../src/capability-registry.js";
import { diagnosticsAdminRoute, diagnosticsSchemaRoute } from "../../src/diagnostics-routes.js";
import { createDiagnostics } from "../../src/diagnostics.js";
import { discussionRoutes } from "../../src/discussion-routes.js";
import type { DiscussionService } from "../../src/discussions.js";
import { githubArtifactRoutes } from "../../src/github-artifact-routes.js";
import type { GitHubArtifactService } from "../../src/github-artifacts.js";
import { githubSignalRoutes, githubWebhookRoute } from "../../src/github-signal-routes.js";
import type { GitHubSignalService } from "../../src/github-signals.js";
import { requireInstanceAdministrator } from "../../src/http-routing.js";
import { importedIdentityAdministrationRoutes } from "../../src/imported-identity-administration-routes.js";
import type { ImportedIdentityAdministration } from "../../src/imported-identity-administration-routes.js";
import { startInstance as startProductionInstance, type InstanceOptions, type RunningInstance } from "../../src/instance.js";
export type { DatabaseProbe, RunningInstance } from "../../src/instance.js";
import { instanceBackupRoute } from "../../src/instance-backup-routes.js";
import type { InstanceBackupRestoreTarget, InstanceBackupService } from "../../src/instance-backup.js";
import { instanceUpgradeRoute } from "../../src/instance-upgrade-routes.js";
import type { InstanceUpgradeService } from "../../src/instance-upgrade.js";
import { invitationRoutes } from "../../src/invitation-routes.js";
import type { InvitationService } from "../../src/invitations.js";
import { mcpRoute } from "../../src/mcp-route.js";
import { memberLocalizationRoutes } from "../../src/member-localization-routes.js";
import type { MemberLocalizationService } from "../../src/member-localization.js";
import { mobileCaptureRoutes } from "../../src/mobile-capture-routes.js";
import type { MobileCaptureService } from "../../src/mobile-captures.js";
import { noteCollaborationRoutes } from "../../src/note-collaboration-routes.js";
import type { NoteCollaborationService } from "../../src/note-collaboration.js";
import { noteLinkRoutes } from "../../src/note-link-routes.js";
import type { NoteLinkService } from "../../src/note-links.js";
import { noteRoutes } from "../../src/note-routes.js";
import type { NoteService } from "../../src/notes.js";
import { notificationRoutes } from "../../src/notification-routes.js";
import type { NotificationService } from "../../src/notifications.js";
import { oidcAuthRoute, oidcManagementRoute } from "../../src/oidc-auth-routes.js";
import type { OidcAuthService } from "../../src/oidc-auth.js";
import type { OidcManagementService } from "../../src/oidc-management.js";
import { organizationRoleRoutes } from "../../src/organization-role-routes.js";
import type { OrganizationRoleService } from "../../src/organization-roles.js";
import { passwordAuthRoute } from "../../src/password-auth-routes.js";
import type { PasswordAuthService } from "../../src/password-auth.js";
import { portableWorkspaceExportRoute } from "../../src/portable-workspace-export-route.js";
import type { PortableWorkspaceExportService } from "../../src/portable-workspace-export.js";
import { markdownWorkspaceImportRoute, portableWorkspaceImportRoute } from "../../src/portable-workspace-import-route.js";
import type { PortableWorkspaceImportService } from "../../src/portable-workspace-import.js";
import { projectWorkflowRoutes } from "../../src/project-workflow-routes.js";
import type { ProjectWorkflowService } from "../../src/project-workflows.js";
import { repositoryConnectionRoutes } from "../../src/repository-connection-routes.js";
import type { RepositoryConnectionService } from "../../src/repository-connections.js";
import { taskRoutes } from "../../src/task-routes.js";
import type { TaskService } from "../../src/tasks.js";
import { workspaceProjectRoutes } from "../../src/workspace-project-routes.js";
import type { MemberAccessResolver, WorkspaceProjectService } from "../../src/workspaces-projects.js";
import { workspaceSearchRoutes } from "../../src/workspace-search-routes.js";
import type { WorkspaceSearchService } from "../../src/workspace-search.js";
import { validatedOidcCallbackOrigin } from "../../src/identity-access/index.js";

interface LegacyTestOptions extends Omit<InstanceOptions, "capabilities"> {
  capabilities?: InstanceOptions["capabilities"];
  ownerBootstrap?: OwnerBootstrapService; passwordAuth?: PasswordAuthService; accountRegistration?: AccountRegistrationService;
  reportAuthenticationFailure?: AuthenticationFailureReporter; workspaceProjects?: WorkspaceProjectService; notes?: NoteService;
  noteCollaboration?: NoteCollaborationService; memberAccess?: MemberAccessResolver; organizationRoles?: OrganizationRoleService;
  memberLocalization?: MemberLocalizationService; oidcAuth?: OidcAuthService; oidcManagement?: OidcManagementService;
  oidcCallbackOrigin?: string; allowInsecureOidcCallbackOriginForTest?: boolean; accountRecovery?: AccountRecoveryService;
  invitations?: InvitationService; repositoryConnections?: RepositoryConnectionService; tasks?: TaskService; attachments?: AttachmentService;
  mobileCaptures?: MobileCaptureService; discussions?: DiscussionService; projectWorkflows?: ProjectWorkflowService;
  portableWorkspaceExports?: PortableWorkspaceExportService; portableWorkspaceImports?: PortableWorkspaceImportService; boards?: BoardService;
  noteLinks?: NoteLinkService; activities?: ActivityService; githubArtifacts?: GitHubArtifactService; githubSignals?: GitHubSignalService;
  instanceBackupRoot?: string; instanceBackupRestoreTarget?: InstanceBackupRestoreTarget; notifications?: NotificationService;
  automations?: AutomationService; importedIdentityAdministration?: ImportedIdentityAdministration; searches?: WorkspaceSearchService;
  agentGrants?: AgentGrantService; mcpEnabled?: boolean; instanceBackups?: InstanceBackupService; instanceUpgrades?: InstanceUpgradeService;
}

/** Test-only adapter for old fixtures. The production Instance still receives only capability modules. */
export async function startInstance(options: LegacyTestOptions): Promise<RunningInstance> {
  const existing = options.capabilities?.modules ?? [];
  const owned = new Set(existing.flatMap(({ owns }) => [...(owns ?? [])]));
  const owns = (name: string) => owned.has(name);
  const existingMemberAccess = existing.flatMap((module) => module.memberAccess ? [module.memberAccess] : [])[0];
  const memberAccess = existingMemberAccess ?? options.memberAccess ?? options.passwordAuth;
  const diagnostics = options.diagnostics ?? createDiagnostics({ instanceVersion: "0.1.0", transport: { async submit() { throw new Error("No diagnostic transport is configured"); } } });
  const passwordAuth = options.passwordAuth;
  const oidcCallbackOrigin = options.oidcAuth
    ? validatedOidcCallbackOrigin(options.oidcCallbackOrigin, options.allowInsecureOidcCallbackOriginForTest)
    : undefined;
  const publicRoutes = memberAccess ? [
    ...(options.memberLocalization ? [memberLocalizationRoutes(options.memberLocalization, memberAccess)] : []),
    ...(!owns("workspace-projects") && options.workspaceProjects ? [workspaceProjectRoutes(options.workspaceProjects, memberAccess)] : []),
    ...(options.organizationRoles ? [organizationRoleRoutes(options.organizationRoles, memberAccess)] : []),
    ...(options.invitations ? [invitationRoutes(options.invitations, memberAccess)] : []),
    ...(!owns("notes") && options.notes ? [noteRoutes(options.notes, memberAccess)] : []),
    ...(!owns("note-collaboration") && options.noteCollaboration ? [noteCollaborationRoutes(options.noteCollaboration, memberAccess)] : []),
    ...(!owns("note-links") && options.noteLinks ? [noteLinkRoutes(options.noteLinks, memberAccess)] : []),
    ...(!owns("tasks") && options.tasks ? [taskRoutes(options.tasks, memberAccess)] : []),
    ...(!owns("project-workflows") && options.projectWorkflows ? [projectWorkflowRoutes(options.projectWorkflows, memberAccess)] : []),
    ...(!owns("boards") && options.boards ? [boardRoutes(options.boards, memberAccess)] : []),
    ...(!owns("attachments") && options.attachments ? [attachmentRoutes(options.attachments, memberAccess)] : []),
    ...(!owns("discussions") && options.discussions ? [discussionRoutes(options.discussions, memberAccess)] : []),
    ...(!owns("portable-export") && options.portableWorkspaceExports ? [portableWorkspaceExportRoute(options.portableWorkspaceExports, memberAccess)] : []),
    ...(!owns("markdown-import") && options.portableWorkspaceImports ? [markdownWorkspaceImportRoute(options.portableWorkspaceImports, memberAccess)] : []),
    ...(!owns("activities") && options.activities ? [activityRoutes(options.activities, memberAccess)] : []),
    ...(!owns("notifications") && options.notifications ? [notificationRoutes(options.notifications, memberAccess)] : []),
    ...(!owns("repository-connections") && options.repositoryConnections ? [repositoryConnectionRoutes(options.repositoryConnections, memberAccess)] : []),
    ...(!owns("github-artifacts") && options.githubArtifacts ? [githubArtifactRoutes(options.githubArtifacts, memberAccess)] : []),
    ...(!owns("github-signals") && options.githubSignals ? [githubSignalRoutes(options.githubSignals, memberAccess)] : []),
    ...(!owns("automations") && options.automations ? [automationRoutes(options.automations, memberAccess)] : []),
    ...(options.importedIdentityAdministration ? [importedIdentityAdministrationRoutes(options.importedIdentityAdministration, memberAccess)] : []),
    ...(!owns("search") && options.searches ? [workspaceSearchRoutes(options.searches, memberAccess)] : []),
    ...(options.agentGrants ? [agentGrantRoutes(options.agentGrants, memberAccess, { ...(options.notes ? { notes: options.notes } : {}), ...(options.tasks ? { tasks: options.tasks } : {}) })] : []),
  ] : [];
  const module: CapabilityModule = {
    name: "test-fixture-composition",
    ...(!existingMemberAccess && memberAccess ? { memberAccess } : {}),
    publicRoutes: () => publicRoutes,
    routes: () => [
      ...(!owns("oidc-management") && options.oidcManagement && options.passwordAuth ? [oidcManagementRoute(options.oidcManagement, options.passwordAuth)] : []),
      ...(!owns("oidc-auth") && options.oidcAuth && oidcCallbackOrigin ? [oidcAuthRoute(options.oidcAuth, oidcCallbackOrigin)] : []),
      ...(!owns("account-recovery") && options.accountRecovery && passwordAuth ? [accountRecoveryRoute(options.accountRecovery, { resolve: (authorization) => passwordAuth.authenticateBearer(authorization) })] : []),
      ...(!owns("account-registration") ? [accountRegistrationRoute(options.accountRegistration, options.reportAuthenticationFailure)] : []),
      ...(!owns("password-auth") && options.passwordAuth ? [passwordAuthRoute(options.passwordAuth, options.reportAuthenticationFailure)] : []),
      ...(!owns("diagnostics") ? [diagnosticsSchemaRoute(diagnostics), requireInstanceAdministrator(options.instanceAdminToken, diagnosticsAdminRoute(diagnostics))] : []),
      ...(!owns("instance-backups") && options.instanceBackups ? [requireInstanceAdministrator(options.instanceAdminToken, instanceBackupRoute(options.instanceBackups, options.instanceBackupRoot, options.instanceBackupRestoreTarget))] : []),
      ...(!owns("instance-upgrades") && options.instanceUpgrades ? [requireInstanceAdministrator(options.instanceAdminToken, instanceUpgradeRoute(options.instanceUpgrades))] : []),
      ...(!owns("owner-bootstrap") ? [requireInstanceAdministrator(options.instanceAdminToken, ownerBootstrapRoute(options.ownerBootstrap))] : []),
      ...(!owns("portable-import") && options.portableWorkspaceImports ? [requireInstanceAdministrator(options.instanceAdminToken, portableWorkspaceImportRoute(options.portableWorkspaceImports))] : []),
      ...publicRoutes,
      ...(!owns("mobile-capture") && options.mobileCaptures && memberAccess ? [mobileCaptureRoutes(options.mobileCaptures, memberAccess)] : []),
      ...(!owns("github-signals") && options.githubSignals ? [githubWebhookRoute(options.githubSignals)] : []),
      ...(!owns("mcp") && options.agentGrants ? [mcpRoute(options.agentGrants, options.mcpEnabled === true, { ...(options.notes ? { notes: options.notes } : {}), ...(options.tasks ? { tasks: options.tasks } : {}) })] : []),
    ],
  };
  return startProductionInstance({ ...options, capabilities: createCapabilityRegistry([...existing, module]) });
}
