import { startInstance } from "./instance.js";
import { OwnerBootstrapService } from "./owner-bootstrap.js";
import { PostgresDatabase } from "./postgres-database.js";
import { PasswordAuthService } from "./password-auth.js";
import { createAuthenticationSecretCodec } from "./authentication-secrets.js";
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
  const instance = await startInstance({
    database,
    host: process.env.HOST ?? "0.0.0.0",
    port,
    instanceAdminToken: requiredEnvironment("INSTANCE_ADMIN_TOKEN"),
    ownerBootstrap: new OwnerBootstrapService(database),
    passwordAuth,
    workspaceProjects: new WorkspaceProjectService(database),
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
