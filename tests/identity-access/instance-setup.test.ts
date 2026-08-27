import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";

import { createAuthenticationSecretCodec } from "../../src/authentication-secrets.js";
import { createCapabilityRegistry } from "../../src/capability-registry.js";
import { EmbeddedInstanceStore } from "../../src/embedded-instance-store.js";
import { identityAccessCapability } from "../../src/identity-access/index.js";
import {
  InstanceSetupService,
  isLoopbackAddress,
  type FirstPersonalInstanceSetup,
  type InstanceSetupRepository,
} from "../../src/identity-access/instance-setup.js";
import { startInstance, type DatabaseProbe, type RunningInstance } from "../../src/instance.js";
import { knowledgeAuthoringCapability } from "../../src/knowledge-authoring/index.js";
import { NoteTreeService } from "../../src/knowledge-authoring/note-tree.js";
import { NoteService } from "../../src/notes.js";
import { PasswordAuthService } from "../../src/password-auth.js";
import { StarterTutorialService } from "../../src/identity-access/starter-tutorial.js";
import { ProjectlessTaskService } from "../../src/work-planning/projectless-tasks.js";
import { workPlanningCapability } from "../../src/work-planning/index.js";
import { TaskService } from "../../src/tasks.js";

class SetupRepository implements DatabaseProbe, InstanceSetupRepository {
  setup: FirstPersonalInstanceSetup | undefined;
  attempts = 0;
  delay: Promise<void> | undefined;
  failure: Error | undefined;

  async verifyConnection() {}
  async close() {}
  async setupComplete() { return this.setup !== undefined; }
  async createFirstPersonalInstance(setup: FirstPersonalInstanceSetup) {
    this.attempts += 1;
    await this.delay;
    if (this.failure) throw this.failure;
    if (this.setup) return false;
    this.setup = setup;
    return true;
  }
}

const unavailablePasswordAuth = new PasswordAuthService({
  async findAccountByEmail() { return undefined; },
  async findAccountById() { return undefined; },
  async createSession() {},
  async findSessionByTokenHash() { return undefined; },
  async listSessions() { return []; },
  async deleteSession() { return false; },
  async changePasswordAndDeleteOtherSessions() {},
});

describe("fresh Instance setup", () => {
  let instance: RunningInstance | undefined;
  const directories: string[] = [];
  afterEach(async () => {
    await instance?.close();
    instance = undefined;
    await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
  });

  it("recognizes only valid loopback socket addresses", () => {
    assert.equal(isLoopbackAddress("127.0.0.1"), true);
    assert.equal(isLoopbackAddress("::ffff:127.0.0.2"), true);
    assert.equal(isLoopbackAddress("::1"), true);
    assert.equal(isLoopbackAddress("127.999.999.999"), false);
    assert.equal(isLoopbackAddress("10.0.0.1"), false);
  });

  it("reports direct setup only when the Instance and connection are genuinely loopback-bound", async () => {
    const repository = new SetupRepository();
    const setup = new InstanceSetupService(repository, { boundHost: "127.0.0.1", output() {} });
    instance = await startInstance({
      database: repository,
      host: "127.0.0.1",
      port: 0,
      instanceAdminToken: "test-admin-token",
      capabilities: createCapabilityRegistry([
        identityAccessCapability({ passwordAuth: unavailablePasswordAuth, instanceSetup: setup }),
      ]),
    });

    const response = await fetch(`${instance.url}/api/instance/setup-state`, {
      headers: { host: "attacker.example", forwarded: "for=203.0.113.9", "x-forwarded-for": "203.0.113.9" },
    });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { state: "available-local" });
  });

  it("requires the startup code for a non-loopback bind and ignores spoofed forwarding headers", async () => {
    const repository = new SetupRepository();
    const output: string[] = [];
    const setup = new InstanceSetupService(repository, {
      boundHost: "0.0.0.0",
      code: "STASH-ONE",
      output(message) { output.push(message); },
    });
    instance = await startInstance({
      database: repository, host: "0.0.0.0", port: 0, instanceAdminToken: "test-admin-token",
      capabilities: createCapabilityRegistry([identityAccessCapability({ passwordAuth: unavailablePasswordAuth, instanceSetup: setup })]),
    });
    const headers = { host: "localhost", forwarded: "for=127.0.0.1", "x-forwarded-for": "127.0.0.1" };
    assert.deepEqual(await (await fetch(`${instance.url}/api/instance/setup-state`, { headers })).json(), { state: "code-required" });
    const missing = await postSetup(instance.url, { name: "Ada", email: "ada@example.test",
      password: "correct horse battery staple", workspaceName: "Ada's Workspace" }, headers);
    assert.equal(missing.status, 403);
    assert.equal((await missing.json() as { error: string }).error, "setup_code_required");
    assert.equal(repository.setup, undefined);
    assert.equal(output.length, 1);
    assert.match(output[0]!, /STASH-ONE/);
  });

  it("creates the personal Member, Workspace, authenticated session, and real starter contribution atomically", async () => {
    const repository = new SetupRepository();
    const setup = new InstanceSetupService(repository, { boundHost: "127.0.0.1", output() {} });
    instance = await runSetupInstance(repository, setup, "127.0.0.1");
    const response = await postSetup(instance.url, { name: " Ada Lovelace ", email: "ADA@EXAMPLE.TEST",
      password: "correct horse battery staple", workspaceName: " My Workspace " });
    assert.equal(response.status, 201);
    const body = await response.json() as { token: string; workspaceId: string; starterNoteId: string };
    assert.ok(body.token);
    assert.equal(body.workspaceId, repository.setup?.workspace.id);
    assert.equal(body.starterNoteId, repository.setup?.starter.notes[0]?.id);
    assert.equal(repository.setup?.account.name, "Ada Lovelace");
    assert.equal(repository.setup?.account.email, "ada@example.test");
    assert.notEqual(repository.setup?.account.passwordHash, "correct horse battery staple");
    assert.equal(repository.setup?.workspace.name, "My Workspace");
    assert.equal(repository.setup?.starter.notes.length, 3);
    assert.equal(repository.setup?.starter.notes.filter(({ parentId }) => parentId === body.starterNoteId).length, 2);
    assert.equal(repository.setup?.starter.links.length, 1);
    assert.equal(repository.setup?.starter.tasks.length, 2);
    assert.equal(repository.setup?.starter.contribution.schema, "stash.starter-tutorial.v1");
    assert.equal(repository.setup?.starter.contribution.collection.ownerNoteId, repository.setup?.starter.notes[1]?.id);
    assert.deepEqual(repository.setup?.starter.contribution.taskView.source,
      { kind: "tasks", workspaceId: body.workspaceId, project: "none" });
  });

  it("accepts a current code once, serializes concurrent claims, and then reports completion", async () => {
    const repository = new SetupRepository();
    let release!: () => void;
    repository.delay = new Promise<void>((resolve) => { release = resolve; });
    const setup = new InstanceSetupService(repository, { boundHost: "0.0.0.0", code: "ONLY-ONCE", output() {} });
    instance = await runSetupInstance(repository, setup, "0.0.0.0");
    const input = { setupCode: "ONLY-ONCE", name: "Ada", email: "ada@example.test",
      password: "correct horse battery staple", workspaceName: "Personal" };
    const first = postSetup(instance.url, input);
    const second = postSetup(instance.url, { ...input, email: "grace@example.test" });
    await new Promise((resolve) => setImmediate(resolve));
    release();
    const responses = await Promise.all([first, second]);
    assert.deepEqual(responses.map(({ status }) => status).sort(), [201, 409]);
    assert.equal(repository.attempts, 1);
    assert.deepEqual(await (await fetch(`${instance.url}/api/instance/setup-state`)).json(), { state: "complete" });
    assert.equal((await postSetup(instance.url, input)).status, 409);
  });

  it("rejects wrong and expired codes without consuming a valid retry", async () => {
    const repository = new SetupRepository();
    let now = 1_000;
    const setup = new InstanceSetupService(repository, { boundHost: "0.0.0.0", code: "FRESH-CODE", codeTtlMs: 500,
      now: () => now, output() {} });
    instance = await runSetupInstance(repository, setup, "0.0.0.0");
    const input = { name: "Ada", email: "ada@example.test", password: "correct horse battery staple", workspaceName: "Personal" };
    const wrong = await postSetup(instance.url, { ...input, setupCode: "WRONG" });
    assert.equal(wrong.status, 403);
    assert.equal((await wrong.json() as { error: string }).error, "invalid_setup_code");
    now = 1_500;
    const expired = await postSetup(instance.url, { ...input, setupCode: "FRESH-CODE" });
    assert.equal(expired.status, 410);
    assert.equal((await expired.json() as { error: string }).error, "setup_code_expired");
    assert.equal(repository.attempts, 0);
  });

  it("keeps the code reusable when the atomic repository command fails", async () => {
    const repository = new SetupRepository();
    repository.failure = new Error("postgres://secret");
    const setup = new InstanceSetupService(repository, { boundHost: "0.0.0.0", code: "RETRY-ME", output() {} });
    instance = await runSetupInstance(repository, setup, "0.0.0.0");
    const input = { setupCode: "RETRY-ME", name: "Ada", email: "ada@example.test",
      password: "correct horse battery staple", workspaceName: "Personal" };
    const failed = await postSetup(instance.url, input);
    assert.equal(failed.status, 503);
    assert.doesNotMatch(await failed.text(), /postgres|secret/i);
    repository.failure = undefined;
    assert.equal((await postSetup(instance.url, input)).status, 201);
    assert.equal(repository.attempts, 2);
  });

  it("commits a usable authenticated personal Workspace and starter Note branch in the real store", async () => {
    const directory = await mkdtemp(join(tmpdir(), "stash-setup-test-"));
    directories.push(directory);
    const store = await EmbeddedInstanceStore.open(directory,
      createAuthenticationSecretCodec(randomBytes(32).toString("base64")));
    const passwordAuth = new PasswordAuthService(store.database);
    const setupRepository = store.database.instanceSetupRepository();
    const setup = new InstanceSetupService(setupRepository, { boundHost: "127.0.0.1", output() {} });
    instance = await startInstance({
      database: store.database, host: "127.0.0.1", port: 0, instanceAdminToken: "test-admin-token",
      passwordAuth,
      capabilities: createCapabilityRegistry([
        identityAccessCapability({ passwordAuth, instanceSetup: setup,
          starterTutorials: new StarterTutorialService(setupRepository), memberAccess: passwordAuth }),
        knowledgeAuthoringCapability({ notes: new NoteService(store.database),
          noteTree: new NoteTreeService(store.database.noteTreeRepository(), setupRepository),
          memberAccess: passwordAuth }),
        workPlanningCapability({ tasks: new TaskService(store.database, store.database), memberAccess: passwordAuth,
          projectlessTasks: new ProjectlessTaskService(store.database.projectlessTaskRepository()) }),
      ]),
    });
    const created = await postSetup(instance.url, { name: "Ada", email: "ada@example.test",
      password: "correct horse battery staple", workspaceName: "Personal Lab" });
    assert.equal(created.status, 201);
    const result = await created.json() as { token: string; workspaceId: string; starterNoteId: string };
    const authorization = { authorization: `Bearer ${result.token}` };
    const session = await fetch(`${instance.url}/api/client-session`, { headers: authorization });
    assert.equal(session.status, 200);
    const sessionBody = await session.json() as {
      authenticated: boolean; member: { id: string; name: string; email: string }; workspace: { id: string; name: string };
    };
    assert.equal(sessionBody.authenticated, true);
    assert.match(sessionBody.member.id, /^[0-9a-f-]{36}$/);
    assert.equal(sessionBody.member.name, "Ada");
    assert.equal(sessionBody.member.email, "ada@example.test");
    assert.deepEqual(sessionBody.workspace, { id: result.workspaceId, name: "Personal Lab" });
    const tree = await fetch(`${instance.url}/api/workspaces/${result.workspaceId}/note-tree`, { headers: authorization });
    assert.equal(tree.status, 200);
    const nodes = (await tree.json() as { nodes: Array<{ id: string; parentId?: string; title: string }> }).nodes;
    assert.equal(nodes.length, 3);
    assert.equal(nodes[0]?.id, result.starterNoteId);
    assert.equal(nodes.filter(({ parentId }) => parentId === result.starterNoteId).length, 2);
    const linkedNode = nodes.find(({ title }) => title === "Connect your thinking")!;
    const context = await fetch(`${instance.url}/api/notes/${linkedNode.id}/context`, { headers: authorization });
    assert.equal(context.status, 200);
    const contextBody = await context.json() as { outgoingLinks: Array<{ label: string }> };
    assert.deepEqual(contextBody.outgoingLinks.map(({ label }) => label), ["Continue planning"]);
    const tutorial = await fetch(`${instance.url}/api/notes/${result.starterNoteId}/starter-tutorial`, { headers: authorization });
    assert.equal(tutorial.status, 200);
    const tutorialBody = await tutorial.json() as any;
    assert.equal(tutorialBody.tutorial.schema, "stash.starter-tutorial.v1");
    assert.deepEqual(tutorialBody.tutorial.notes.map(({ title, parentId }: any) => ({ title, parentId: parentId ? "child" : undefined })), [
      { title: "Start here", parentId: undefined },
      { title: "Connect your thinking", parentId: "child" },
      { title: "Plan the next step", parentId: "child" },
    ]);
    assert.deepEqual(tutorialBody.tutorial.links.map(({ label }: any) => label), ["Continue planning"]);
    assert.deepEqual(tutorialBody.tutorial.collection, {
      id: tutorialBody.tutorial.collection.id,
      ownerNoteId: linkedNode.id,
      name: "Ideas to explore",
      properties: [{ id: tutorialBody.tutorial.collection.properties[0].id, name: "Idea", type: "text" }],
      records: [{ id: tutorialBody.tutorial.collection.records[0].id, values: { [tutorialBody.tutorial.collection.properties[0].id]: "Shape your first idea" } }],
    });
    assert.deepEqual(tutorialBody.tutorial.taskView, {
      id: tutorialBody.tutorial.taskView.id,
      noteId: nodes.find(({ title }) => title === "Plan the next step")!.id,
      name: "First moves",
      source: { kind: "tasks", workspaceId: result.workspaceId, project: "none" },
      presentation: "list",
    });
    const projectlessTasks = await fetch(`${instance.url}/api/workspaces/${result.workspaceId}/tasks?scope=projectless`, { headers: authorization });
    assert.equal(projectlessTasks.status, 200);
    const projectlessBody = await projectlessTasks.json() as { tasks: Array<{ id: string; title: string; status: { id: string; name: string; category: string } }> };
    assert.deepEqual(projectlessBody.tasks.map(({ title, status }) => ({ title, status: { name: status.name, category: status.category } })), [
      { title: "Shape your first idea", status: { name: "Ready", category: "unstarted" } },
      { title: "Turn one Note into action", status: { name: "Ready", category: "unstarted" } },
    ]);
    assert.ok(projectlessBody.tasks.every(({ status }) => /^[0-9a-f-]{36}$/.test(status.id)));
    const renamed = await fetch(`${instance.url}/api/notes/${result.starterNoteId}/starter-tutorial/collection`, {
      method: "PUT", headers: { ...authorization, "content-type": "application/json" }, body: JSON.stringify({ name: "Questions worth keeping" }),
    });
    assert.equal(renamed.status, 200);
    assert.equal(((await renamed.json() as any).tutorial.collection.name), "Questions worth keeping");
    const removed = await fetch(`${instance.url}/api/notes/${result.starterNoteId}/trash`, {
      method: "POST", headers: authorization,
    });
    assert.equal(removed.status, 200);
    assert.equal((await removed.json() as { affectedIds: string[] }).affectedIds.length, 3);
    const emptyTree = await fetch(`${instance.url}/api/workspaces/${result.workspaceId}/note-tree`, { headers: authorization });
    assert.deepEqual((await emptyTree.json() as { nodes: unknown[] }).nodes, []);
    assert.equal((await fetch(`${instance.url}/api/notes/${result.starterNoteId}/starter-tutorial`, { headers: authorization })).status, 404);
    const tasksAfterRemoval = await fetch(`${instance.url}/api/workspaces/${result.workspaceId}/tasks?scope=projectless`, { headers: authorization });
    assert.deepEqual(await tasksAfterRemoval.json(), { tasks: [] });
    assert.equal((await fetch(`${instance.url}/api/notes/${linkedNode.id}/context`, { headers: authorization })).status, 404);
    const cleanup = await store.upgradeDatabase.query<{ tutorials: number; tasks: number; links: number; statuses: number }>(`SELECT
      (SELECT COUNT(*)::int FROM stash_starter_tutorials WHERE workspace_id=$1) tutorials,
      (SELECT COUNT(*)::int FROM stash_tasks WHERE workspace_id=$1 AND project_id IS NULL) tasks,
      (SELECT COUNT(*)::int FROM stash_note_links WHERE workspace_id=$1) links,
      (SELECT COUNT(*)::int FROM stash_workspace_workflow_statuses WHERE workspace_id=$1) statuses`, [result.workspaceId]);
    assert.deepEqual(cleanup.rows[0], { tutorials: 0, tasks: 0, links: 0, statuses: 0 });
  });
});

async function runSetupInstance(repository: SetupRepository, setup: InstanceSetupService, host: string) {
  return startInstance({ database: repository, host, port: 0, instanceAdminToken: "test-admin-token",
    capabilities: createCapabilityRegistry([identityAccessCapability({ passwordAuth: unavailablePasswordAuth, instanceSetup: setup })]) });
}

function postSetup(baseUrl: string, body: unknown, headers: Record<string, string> = {}) {
  return fetch(`${baseUrl}/api/instance/setup`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
}
