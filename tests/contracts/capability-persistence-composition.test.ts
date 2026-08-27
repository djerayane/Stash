import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("the production composition root injects capability-scoped persistence ports", async () => {
  const runtime = await readFile(new URL("../../src/instance-runtime.ts", import.meta.url), "utf8");
  for (const port of [
    "identityAccessRepositories", "knowledgeAuthoringRepositories", "workPlanningRepositories", "developmentIntegrationRepositories",
  ]) assert.match(runtime, new RegExp(`database\\.${port}\\(\\)`));

  const productionStart = runtime.slice(runtime.indexOf("const instance = await startInstance"));
  assert.doesNotMatch(productionStart, /\b(?:notes|tasks|boards|discussions|searches|automations|repositoryConnections):?\s*(?:,|})/);

  assert.doesNotMatch(runtime, /new (?:PasswordAuth|AccountRegistration|Note|NoteCollaboration|Task|WorkspaceProject|ProjectWorkflow|Board|Attachment|Discussion|WorkspaceSearch|RepositoryConnection|GitHubArtifact|GitHubSignal)Service\(database[,)]/);
});

test("redesigned capability persistence remains implemented by focused kernel adapters", async () => {
  const database = await readFile(new URL("../../src/postgres-database.ts", import.meta.url), "utf8");
  for (const adapter of [
    "PostgresInstanceSetupRepository", "PostgresOrganizationRoleRepository", "PostgresNoteTreeRepository",
    "PostgresCollectionRepository", "PostgresRelationshipQueryRepository", "PostgresVisualizationBlockRepository",
    "PostgresProjectlessTaskRepository", "PostgresCanonicalTaskRepository", "PostgresProjectPermissionRepository",
  ]) assert.match(database, new RegExp(`#\\w+Repository: ${adapter}`));
  assert.match(database, /PostgresDevelopmentIntegrationRepositories/);
  assert.doesNotMatch(database, /Repositories\(\)[^{]*\{\s*return this;\s*\}/s);
  assert.doesNotMatch(database, /\bProxy\b|\bReflect\.get\b/);

  const developmentIntegration = await readFile(new URL(
    "../../src/development-integration/postgres-development-integration-repositories.ts",
    import.meta.url,
  ), "utf8");
  assert.match(developmentIntegration, /class PostgresDevelopmentIntegrationRepositories/);
  assert.match(developmentIntegration, /implements DevelopmentIntegrationPostgresRepositories/);
  for (const method of ["createRepositoryConnection", "linkArtifact", "matchingTasks", "receive", "confirm"])
    assert.match(developmentIntegration, new RegExp(`\\b${method}\\(`));

  const knowledgeAuthoring = await readFile(new URL(
    "../../src/knowledge-authoring/postgres-knowledge-authoring-repositories.ts",
    import.meta.url,
  ), "utf8");
  for (const method of ["triageNote", "applyTriageChange", "organizeInboxNote", "archiveInboxNote", "linkInboxNote", "createTaskFromInbox"])
    assert.match(knowledgeAuthoring, new RegExp(`\\b${method}\\(`));
  assert.doesNotMatch(database, /\b(?:triageNote|applyTriageChange|organizeInboxNote|archiveInboxNote|linkInboxNote|createTaskFromInbox)\(/);
});

test("the Instance exposes capability-owned public routes without registering legacy duplicates", async () => {
  const instance = await readFile(new URL("../../src/instance.ts", import.meta.url), "utf8");
  assert.match(instance, /publicRoutesFromCapabilities/);
  assert.match(instance, /routesFromCapabilities\(options\.capabilities\)/);
  assert.doesNotMatch(instance, /legacyPublicDomainRoutes|capabilityRouteOwnership|ownsRoute/);
  for (const routeFactory of ["passwordAuthRoute", "noteRoutes", "taskRoutes", "githubSignalRoutes"])
    assert.doesNotMatch(instance, new RegExp(`\\b${routeFactory}\\b`));
});
