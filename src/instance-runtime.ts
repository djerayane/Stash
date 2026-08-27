import { fileURLToPath } from "node:url";

import { AccountRecoveryService } from "./account-recovery.js";
import { AccountRegistrationService } from "./account-registration.js";
import { createAuthenticationSecretCodec } from "./authentication-secrets.js";
import { AgentGrantService } from "./agent-grants.js";
import { ActivityService } from "./activity.js";
import { AttachmentService, LocalAttachmentStorage } from "./attachments.js";
import { AutomationService } from "./automations.js";
import { BoardService } from "./boards.js";
import { DiscussionService } from "./discussions.js";
import { createDiagnostics } from "./diagnostics.js";
import { databaseUrlFromEnvironment, openRegistrationFromEnvironment, validateComposeExposure } from "./deployment-configuration.js";
import { EmailRecoveryWorker } from "./email-recovery-worker.js";
import { EmbeddedInstanceStore } from "./embedded-instance-store.js";
import { GitHubAppClient } from "./github-app.js";
import { GitHubArtifactService } from "./github-artifacts.js";
import { GitHubSignalService } from "./github-signals.js";
import { InstanceBackupService } from "./instance-backup.js";
import { EmbeddedLocalInstanceBackupSource, EmbeddedLocalInstanceRestoreTarget, PostgresLocalInstanceBackupSource, PostgresLocalInstanceRestoreTarget } from "./instance-backup-system.js";
import { startInstance, type RunningInstance } from "./instance.js";
import { InstanceUpgradeService } from "./instance-upgrade.js";
import { InvitationService } from "./invitations.js";
import { MemberLocalizationService } from "./member-localization.js";
import { MobileCaptureService } from "./mobile-captures.js";
import { NoteCollaborationService } from "./note-collaboration.js";
import { NoteLinkService } from "./note-links.js";
import { NoteService } from "./notes.js";
import { NotificationService } from "./notifications.js";
import { OidcAuthService } from "./oidc-auth.js";
import { OidcManagementService } from "./oidc-management.js";
import { OrganizationRoleService } from "./organization-roles.js";
import { OwnerBootstrapService } from "./owner-bootstrap.js";
import { PasswordAuthService } from "./password-auth.js";
import { resolveWebAuthnConfiguration, WebAuthnPasskeyVerifier } from "./passkey-verifier.js";
import { PortableWorkspaceExportService } from "./portable-workspace-export.js";
import { PortableWorkspaceImportService } from "./portable-workspace-import.js";
import { PostgresDatabase } from "./postgres-database.js";
import { PostgresInstanceUpgradeTarget } from "./postgres-instance-upgrade.js";
import { ProjectWorkflowService } from "./project-workflows.js";
import { createRecoveryEmailSender } from "./recovery-email.js";
import { startRedisAcceleration, type RunningRedisAcceleration } from "./redis-acceleration.js";
import { RepositoryConnectionService } from "./repository-connections.js";
import { readStashReleaseVersion } from "./release-version.js";
import { s3AttachmentStorageFromEnvironment } from "./s3-attachment-storage.js";
import { TaskService } from "./tasks.js";
import { WorkspaceProjectService } from "./workspaces-projects.js";
import { WorkspaceSearchService } from "./workspace-search.js";
import { createCapabilityRegistry } from "./capability-registry.js";
import { developmentIntegrationCapability } from "./development-integration/index.js";
import { identityAccessCapability } from "./identity-access/index.js";
import { InstanceSetupService } from "./identity-access/instance-setup.js";
import { TutorialContributionService } from "./knowledge-authoring/collections.js";
import { instanceOperationsCapability } from "./instance-operations/index.js";
import { knowledgeAuthoringCapability } from "./knowledge-authoring/index.js";
import { NoteTreeService } from "./knowledge-authoring/note-tree.js";
import { workPlanningCapability } from "./work-planning/index.js";
import { ProjectlessTaskService } from "./work-planning/projectless-tasks.js";

function required(environment: NodeJS.ProcessEnv, name: string): string {
  const value = environment[name]?.trim();
  if (!value) throw new Error(`${name} must be configured`);
  return value;
}

export interface ComposedInstanceRuntime {
  instance: RunningInstance;
  database: PostgresDatabase;
  close(): Promise<void>;
}

/** Composes the production Instance service graph for every supported storage adapter. */
export async function composeInstanceRuntime(environment: NodeJS.ProcessEnv): Promise<ComposedInstanceRuntime> {
  validateComposeExposure(environment);
  const masterKey = required(environment, "INSTANCE_MASTER_KEY");
  const authenticationSecrets = createAuthenticationSecretCodec(masterKey);
  const embeddedDataDirectory = environment.STASH_DATA_DIR?.trim();
  if (embeddedDataDirectory && environment.DATABASE_URL?.trim()) throw new Error("Configure STASH_DATA_DIR or DATABASE_URL, not both");
  const databaseUrl = embeddedDataDirectory ? undefined : databaseUrlFromEnvironment(environment);
  const embeddedStore = embeddedDataDirectory ? await EmbeddedInstanceStore.open(embeddedDataDirectory, authenticationSecrets) : undefined;
  const database = embeddedStore?.database ?? new PostgresDatabase(databaseUrl!, authenticationSecrets);
  await database.verifyConnection();
  if (embeddedStore) await database.prepareInstanceStore();

  let redis: RunningRedisAcceleration | undefined;
  const redisUrl = environment.REDIS_URL?.trim();
  if (redisUrl) redis = startRedisAcceleration(redisUrl, ({ operation, key, cause }) => console.warn(`Redis acceleration degraded (${operation} ${key}): ${cause.message}`));
  const port = Number.parseInt(environment.PORT ?? "3000", 10);
  if (!Number.isInteger(port) || port < 0 || port > 65_535) throw new Error("PORT must be an integer between 0 and 65535");
  const host = environment.HOST ?? "0.0.0.0";
  const publicOrigin = required(environment, "PUBLIC_ORIGIN");
  const passwordAuth = new PasswordAuthService(database);
  const notifications = new NotificationService(database);
  const automations = new AutomationService(database, notifications);
  const attachmentStoragePath = embeddedStore?.paths.attachments ?? (environment.ATTACHMENT_STORAGE_PATH?.trim() || "/var/lib/stash/attachments");
  if (embeddedStore && environment.ATTACHMENT_STORAGE_PATH?.trim()) throw new Error("Embedded Instance Attachments must remain beneath STASH_DATA_DIR");
  const s3AttachmentStorage = s3AttachmentStorageFromEnvironment(environment);
  if (embeddedStore && s3AttachmentStorage) throw new Error("Embedded Instance storage requires local Attachments beneath STASH_DATA_DIR");
  const attachmentStorage = s3AttachmentStorage ?? new LocalAttachmentStorage(attachmentStoragePath);
  const attachmentStorageKind = s3AttachmentStorage ? "s3" as const : "local" as const;
  const githubAppId = environment.GITHUB_APP_ID?.trim();
  const githubAppPrivateKey = environment.GITHUB_APP_PRIVATE_KEY?.replace(/\\n/g, "\n").trim();
  if (Boolean(githubAppId) !== Boolean(githubAppPrivateKey)) throw new Error("GITHUB_APP_ID and GITHUB_APP_PRIVATE_KEY must be configured together");
  const githubApp = githubAppId && githubAppPrivateKey ? new GitHubAppClient(githubAppId, githubAppPrivateKey) : undefined;
  const instanceBackups = new InstanceBackupService(embeddedStore
    ? new EmbeddedLocalInstanceBackupSource({ store: embeddedStore, publicOrigin })
    : new PostgresLocalInstanceBackupSource({ databaseUrl: databaseUrl!, attachmentRoot: attachmentStoragePath,
      ...(s3AttachmentStorage ? { attachmentStorage: s3AttachmentStorage } : {}), attachmentStorageKind, publicOrigin }), { masterKey });
  const instanceBackupRoot = environment.INSTANCE_BACKUP_PATH?.trim() ?? embeddedStore?.paths.backups;
  const restoreTarget = embeddedStore ? new EmbeddedLocalInstanceRestoreTarget({ store: embeddedStore, publicOrigin })
    : new PostgresLocalInstanceRestoreTarget({ databaseUrl: databaseUrl!, attachmentRoot: attachmentStoragePath,
      ...(s3AttachmentStorage ? { attachmentStorage: s3AttachmentStorage } : {}), attachmentStorageKind, publicOrigin });
  const upgrades = instanceBackupRoot ? new InstanceUpgradeService({ backups: instanceBackups, backupRoot: instanceBackupRoot,
    targetVersion: await readStashReleaseVersion(), target: new PostgresInstanceUpgradeTarget(databaseUrl ?? "embedded://local",
      async (backupPath) => { await instanceBackups.restore(backupPath, restoreTarget, { dryRun: false }); }, embeddedStore?.upgradeDatabase) }) : undefined;
  const recoveryEmail = createRecoveryEmailSender({ ...(environment.SMTP_URL?.trim() ? { smtpUrl: environment.SMTP_URL.trim() } : {}),
    ...(environment.EMAIL_RECOVERY_FROM?.trim() ? { from: environment.EMAIL_RECOVERY_FROM.trim() } : {}), publicOrigin });
  const githubWebhookSecret = environment.GITHUB_WEBHOOK_SECRET?.trim();
  const instanceAdminToken = required(environment, "INSTANCE_ADMIN_TOKEN");
  const reportAuthenticationFailure = ({ operation, cause }: { operation: string; cause: unknown }) => {
    const causeType = cause instanceof Error ? cause.name : "UnknownFailure";
    const candidateCode = cause && typeof cause === "object" && "code" in cause ? String(cause.code) : "";
    const causeCode = /^(?:[A-Z0-9]{5}|E[A-Z_]{2,31})$/.test(candidateCode) ? candidateCode : "unclassified";
    console.warn(`Authentication operation unavailable (operation=${operation}, cause=${causeType}, code=${causeCode}).`);
  };
  const instanceSetup = new InstanceSetupService(database.instanceSetupRepository(), {
    boundHost: host,
    output(message) { console.warn(message); },
  });
  const diagnostics = createDiagnostics({
    instanceVersion: "0.1.0",
    transport: { async submit() { throw new Error("No diagnostic transport is configured"); } },
  });
  const accountRegistration = openRegistrationFromEnvironment(environment) ? new AccountRegistrationService(database) : undefined;
  const notes = new NoteService(database);
  const tasks = new TaskService(database, database);
  const workspaceProjects = new WorkspaceProjectService(database);
  const starterTutorials = new TutorialContributionService(database.tutorialContributionRepository());
  const projectlessTasks = new ProjectlessTaskService(database.projectlessTaskRepository());
  const repositoryConnections = githubApp ? new RepositoryConnectionService(database, githubApp) : undefined;
  const githubArtifacts = githubApp ? new GitHubArtifactService(database, githubApp) : undefined;
  const githubSignals = githubWebhookSecret ? new GitHubSignalService(database, githubWebhookSecret, automations) : undefined;
  const capabilities = createCapabilityRegistry([
    identityAccessCapability({ passwordAuth, instanceAdminToken, instanceSetup,
      ...(accountRegistration ? { accountRegistration } : {}), reportAuthenticationFailure }),
    knowledgeAuthoringCapability({ notes, noteTree: new NoteTreeService(database.noteTreeRepository(),
      database.tutorialContributionRepository()), starterTutorials, memberAccess: passwordAuth }),
    workPlanningCapability({ tasks, workspaceProjects, projectlessTasks, memberAccess: passwordAuth }),
    developmentIntegrationCapability({ memberAccess: passwordAuth,
      ...(repositoryConnections ? { repositoryConnections } : {}), ...(githubArtifacts ? { githubArtifacts } : {}),
      ...(githubSignals ? { githubSignals } : {}) }),
    instanceOperationsCapability({ instanceAdminToken, diagnostics }),
  ]);
  const instance = await startInstance({ database, host, port,
    instanceAdminToken, capabilities, diagnostics,
    webClientRoot: environment.WEB_CLIENT_ROOT?.trim() || fileURLToPath(new URL("../apps/web/dist", import.meta.url)),
    passwordAuth, ...(accountRegistration ? { accountRegistration } : {}), reportAuthenticationFailure,
    organizationRoles: new OrganizationRoleService(database), invitations: new InvitationService(database),
    ...(repositoryConnections ? { repositoryConnections } : {}), ...(githubArtifacts ? { githubArtifacts } : {}),
    ...(githubSignals ? { githubSignals } : {}), automations,
    notes, noteCollaboration: new NoteCollaborationService(database), agentGrants: new AgentGrantService(database),
    mcpEnabled: environment.MCP_ENABLED?.trim().toLowerCase() === "true", noteLinks: new NoteLinkService(database), tasks,
    projectWorkflows: new ProjectWorkflowService(database), boards: new BoardService(database), attachments: new AttachmentService(database, attachmentStorage),
    portableWorkspaceExports: new PortableWorkspaceExportService(database, attachmentStorage), portableWorkspaceImports: new PortableWorkspaceImportService(database, attachmentStorage),
    importedIdentityAdministration: database, mobileCaptures: new MobileCaptureService(database), discussions: new DiscussionService(database),
    activities: new ActivityService(database), searches: new WorkspaceSearchService(database), instanceBackups, instanceBackupRestoreTarget: restoreTarget,
    ...(instanceBackupRoot ? { instanceBackupRoot } : {}), ...(upgrades ? { instanceUpgrades: upgrades } : {}), notifications,
    memberLocalization: new MemberLocalizationService(database), oidcAuth: new OidcAuthService(database), oidcManagement: new OidcManagementService(database),
    oidcCallbackOrigin: publicOrigin, accountRecovery: new AccountRecoveryService(database, passwordAuth, {
      passkeys: new WebAuthnPasskeyVerifier(resolveWebAuthnConfiguration(publicOrigin, {
        ...(environment.WEBAUTHN_RP_ID ? { rpId: environment.WEBAUTHN_RP_ID } : {}), ...(environment.WEBAUTHN_RP_NAME ? { rpName: environment.WEBAUTHN_RP_NAME } : {}) })),
      secrets: authenticationSecrets, ...(recoveryEmail ? { email: recoveryEmail } : {}) }), ...(redis ? { acceleration: redis.acceleration } : {}) });
  const emailRecoveryWorker = recoveryEmail ? new EmailRecoveryWorker(database, authenticationSecrets, recoveryEmail) : undefined;
  const emailRecoveryTimer = emailRecoveryWorker ? setInterval(() => {
    void emailRecoveryWorker.processNext()
      .then((status) => { if (status === "retry_scheduled") console.warn("Email recovery delivery failed; a retry was scheduled."); })
      .catch((error: unknown) => {
        const message = error instanceof Error ? error.message : "unknown worker failure";
        console.warn(`Email recovery delivery worker unavailable: ${message}`);
      });
  }, 1_000) : undefined;
  emailRecoveryTimer?.unref();
  return { instance, database, async close() { if (emailRecoveryTimer) clearInterval(emailRecoveryTimer); await instance.close(); await embeddedStore?.close(); await redis?.close(); } };
}
