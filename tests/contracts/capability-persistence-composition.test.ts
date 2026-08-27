import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("the production composition root injects capability-scoped persistence ports", async () => {
  const runtime = await readFile(new URL("../../src/instance-runtime.ts", import.meta.url), "utf8");
  for (const port of [
    "identityAccessRepositories", "knowledgeAuthoringRepositories", "workPlanningRepositories", "developmentIntegrationRepositories",
  ]) assert.match(runtime, new RegExp(`database\\.${port}\\(\\)`));

  assert.doesNotMatch(runtime, /new (?:PasswordAuth|AccountRegistration|Note|NoteCollaboration|Task|WorkspaceProject|ProjectWorkflow|Board|Attachment|Discussion|WorkspaceSearch|RepositoryConnection|GitHubArtifact|GitHubSignal)Service\(database[,)]/);
});

test("redesigned capability persistence remains implemented by focused kernel adapters", async () => {
  const database = await readFile(new URL("../../src/postgres-database.ts", import.meta.url), "utf8");
  for (const adapter of [
    "PostgresInstanceSetupRepository", "PostgresOrganizationRoleRepository", "PostgresNoteTreeRepository",
    "PostgresCollectionRepository", "PostgresRelationshipQueryRepository", "PostgresVisualizationBlockRepository",
    "PostgresProjectlessTaskRepository", "PostgresCanonicalTaskRepository", "PostgresProjectPermissionRepository",
  ]) assert.match(database, new RegExp(`#\\w+Repository: ${adapter}`));
});

test("the Instance exposes capability-owned public routes without registering legacy duplicates", async () => {
  const instance = await readFile(new URL("../../src/instance.ts", import.meta.url), "utf8");
  assert.match(instance, /publicRoutesFromCapabilities/);
  assert.match(instance, /capabilityRouteOwnership/);
  for (const feature of ["password-auth", "notes", "tasks", "github-signals"])
    assert.match(instance, new RegExp(`ownsRoute\\("${feature}"\\)`));
});
