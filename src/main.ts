import { startInstance } from "./instance.js";
import { OwnerBootstrapService } from "./owner-bootstrap.js";
import { PostgresDatabase } from "./postgres-database.js";
import { PasswordAuthService } from "./password-auth.js";
import { OidcAuthService } from "./oidc-auth.js";
import { OidcManagementService } from "./oidc-management.js";
import { NoteService } from "./notes.js";
import { createAuthenticationSecretCodec } from "./authentication-secrets.js";
import { AccountRecoveryService } from "./account-recovery.js";
import { resolveWebAuthnConfiguration, WebAuthnPasskeyVerifier } from "./passkey-verifier.js";
import { createRecoveryEmailSender } from "./recovery-email.js";
import { EmailRecoveryWorker } from "./email-recovery-worker.js";
import { startRedisAcceleration, type RunningRedisAcceleration } from "./redis-acceleration.js";
import { WorkspaceProjectService } from "./workspaces-projects.js";
import { OrganizationRoleService } from "./organization-roles.js";
import { MemberLocalizationService } from "./member-localization.js";
import { InvitationService } from "./invitations.js";
import { GitHubAppClient } from "./github-app.js";
import { RepositoryConnectionService } from "./repository-connections.js";
import { TaskService } from "./tasks.js";
import { AttachmentService, LocalAttachmentStorage } from "./attachments.js";
import { MobileCaptureService } from "./mobile-captures.js";
import { DiscussionService } from "./discussions.js";
import { ProjectWorkflowService } from "./project-workflows.js";
import { PortableWorkspaceExportService } from "./portable-workspace-export.js";
import { PortableWorkspaceImportService } from "./portable-workspace-import.js";
import { BoardService } from "./boards.js";
import { NoteLinkService } from "./note-links.js";
import { ActivityService } from "./activity.js";
import { GitHubArtifactService } from "./github-artifacts.js";
import { GitHubSignalService } from "./github-signals.js";
import { fileURLToPath } from "node:url";
import { InstanceBackupService } from "./instance-backup.js";
import { PostgresLocalInstanceBackupSource, PostgresLocalInstanceRestoreTarget } from "./instance-backup-system.js";
import { NotificationService } from "./notifications.js";
import { AutomationService } from "./automations.js";
import { NoteCollaborationService } from "./note-collaboration.js";
import { WorkspaceSearchService } from "./workspace-search.js";

function requiredEnvironment(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} must be configured`);
  return value;
}

async function main(): Promise<void> {
  const authenticationSecrets = createAuthenticationSecretCodec(requiredEnvironment("INSTANCE_MASTER_KEY"));
  const database = new PostgresDatabase(requiredEnvironment("DATABASE_URL"), authenticationSecrets);
  await database.verifyConnection();
  const redisUrl = process.env.REDIS_URL?.trim();
  let redis: RunningRedisAcceleration | undefined;
  if (redisUrl) {
    redis = startRedisAcceleration(redisUrl, ({ operation, key, cause }) => {
      console.warn(`Redis acceleration degraded (${operation} ${key}): ${cause.message}`);
    });
  }
  const port = Number.parseInt(process.env.PORT ?? "3000", 10);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error("PORT must be an integer between 1 and 65535");
  }

  const passwordAuth = new PasswordAuthService(database);
  const notifications = new NotificationService(database);
  const automations = new AutomationService(database, notifications);
  const attachmentStoragePath = process.env.ATTACHMENT_STORAGE_PATH?.trim() || "/var/lib/stash/attachments";
  const attachmentStorage = new LocalAttachmentStorage(attachmentStoragePath);
  const githubAppId = process.env.GITHUB_APP_ID?.trim();
  const githubAppPrivateKey = process.env.GITHUB_APP_PRIVATE_KEY?.replace(/\\n/g, "\n").trim();
  if (Boolean(githubAppId) !== Boolean(githubAppPrivateKey)) throw new Error("GITHUB_APP_ID and GITHUB_APP_PRIVATE_KEY must be configured together");
  const githubApp = githubAppId && githubAppPrivateKey ? new GitHubAppClient(githubAppId, githubAppPrivateKey) : undefined;
  const githubWebhookSecret = process.env.GITHUB_WEBHOOK_SECRET?.trim();
  const publicOrigin = requiredEnvironment("PUBLIC_ORIGIN");
  const instanceBackups = new InstanceBackupService(new PostgresLocalInstanceBackupSource({
    databaseUrl: requiredEnvironment("DATABASE_URL"), attachmentRoot: attachmentStoragePath, publicOrigin,
  }), { masterKey: requiredEnvironment("INSTANCE_MASTER_KEY") });
  const smtpUrl = process.env.SMTP_URL?.trim();
  const emailRecoveryFrom = process.env.EMAIL_RECOVERY_FROM?.trim();
  const recoveryEmail = createRecoveryEmailSender({
    ...(smtpUrl ? { smtpUrl } : {}),
    ...(emailRecoveryFrom ? { from: emailRecoveryFrom } : {}),
    publicOrigin,
  });
  const instance = await startInstance({
    database,
    host: process.env.HOST ?? "0.0.0.0",
    port,
    instanceAdminToken: requiredEnvironment("INSTANCE_ADMIN_TOKEN"),
    webClientRoot: process.env.WEB_CLIENT_ROOT?.trim() || fileURLToPath(new URL("../apps/web/dist", import.meta.url)),
    ownerBootstrap: new OwnerBootstrapService(database),
    passwordAuth,
    workspaceProjects: new WorkspaceProjectService(database),
    organizationRoles: new OrganizationRoleService(database),
    invitations: new InvitationService(database),
    ...(githubApp ? { repositoryConnections: new RepositoryConnectionService(database, githubApp) } : {}),
    ...(githubApp ? { githubArtifacts: new GitHubArtifactService(database, githubApp) } : {}),
    ...(githubWebhookSecret ? { githubSignals: new GitHubSignalService(database, githubWebhookSecret, automations) } : {}),
    automations,
    notes: new NoteService(database),
    noteCollaboration: new NoteCollaborationService(database),
    noteLinks: new NoteLinkService(database),
    tasks: new TaskService(database, database),
    projectWorkflows: new ProjectWorkflowService(database),
    boards: new BoardService(database),
    attachments: new AttachmentService(database, attachmentStorage),
    portableWorkspaceExports: new PortableWorkspaceExportService(database, attachmentStorage),
    portableWorkspaceImports: new PortableWorkspaceImportService(database, attachmentStorage),
    importedIdentityAdministration: database,
    mobileCaptures: new MobileCaptureService(database),
    discussions: new DiscussionService(database),
    activities: new ActivityService(database),
    searches: new WorkspaceSearchService(database),
    instanceBackups,
    instanceBackupRestoreTarget: new PostgresLocalInstanceRestoreTarget({ databaseUrl: requiredEnvironment("DATABASE_URL"), attachmentRoot: attachmentStoragePath, publicOrigin }),
    ...(process.env.INSTANCE_BACKUP_PATH?.trim() ? { instanceBackupRoot: process.env.INSTANCE_BACKUP_PATH.trim() } : {}),
    notifications,
    memberLocalization: new MemberLocalizationService(database),
    oidcAuth: new OidcAuthService(database),
    oidcManagement: new OidcManagementService(database),
    oidcCallbackOrigin: publicOrigin,
    accountRecovery: new AccountRecoveryService(database, passwordAuth, {
      passkeys: new WebAuthnPasskeyVerifier(resolveWebAuthnConfiguration(publicOrigin, {
        ...(process.env.WEBAUTHN_RP_ID ? { rpId: process.env.WEBAUTHN_RP_ID } : {}),
        ...(process.env.WEBAUTHN_RP_NAME ? { rpName: process.env.WEBAUTHN_RP_NAME } : {}),
      })),
      secrets: authenticationSecrets,
      ...(recoveryEmail ? { email: recoveryEmail } : {}),
    }),
    ...(redis ? { acceleration: redis.acceleration } : {}),
  });
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
  console.log(`Stash Instance listening on ${instance.url}`);

  const shutdown = async () => {
    console.log("Stopping Stash Instance");
    if (emailRecoveryTimer) clearInterval(emailRecoveryTimer);
    await instance.close();
    await redis?.close();
    process.exit(0);
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : "unknown startup failure";
  console.error(`Stash Instance failed to start: ${message}`);
  process.exitCode = 1;
});
