import { startInstance } from "./instance.js";
import { OwnerBootstrapService } from "./owner-bootstrap.js";
import { PostgresDatabase } from "./postgres-database.js";
import { PasswordAuthService } from "./password-auth.js";
import { OidcAuthService } from "./oidc-auth.js";
import { OidcManagementService } from "./oidc-management.js";
import { createAuthenticationSecretCodec } from "./authentication-secrets.js";
import { AccountRecoveryService } from "./account-recovery.js";
import { WebAuthnPasskeyVerifier } from "./passkey-verifier.js";
import { createRecoveryEmailSender } from "./recovery-email.js";
import { startRedisAcceleration, type RunningRedisAcceleration } from "./redis-acceleration.js";
import { WorkspaceProjectService } from "./workspaces-projects.js";

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
  const publicOrigin = requiredEnvironment("PUBLIC_ORIGIN");
  const origin = new URL(publicOrigin);
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
    ownerBootstrap: new OwnerBootstrapService(database),
    passwordAuth,
    workspaceProjects: new WorkspaceProjectService(database),
    oidcAuth: new OidcAuthService(database),
    oidcManagement: new OidcManagementService(database),
    oidcCallbackOrigin: publicOrigin,
    accountRecovery: new AccountRecoveryService(database, passwordAuth, {
      passkeys: new WebAuthnPasskeyVerifier({
        rpId: process.env.WEBAUTHN_RP_ID?.trim() || origin.hostname,
        rpName: process.env.WEBAUTHN_RP_NAME?.trim() || "Stash",
        expectedOrigin: publicOrigin,
      }),
      secrets: authenticationSecrets,
      ...(recoveryEmail ? { email: recoveryEmail } : {}),
    }),
    ...(redis ? { acceleration: redis.acceleration } : {}),
  });
  console.log(`Stash Instance listening on ${instance.url}`);

  const shutdown = async () => {
    console.log("Stopping Stash Instance");
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
