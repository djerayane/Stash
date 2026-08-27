import assert from "node:assert/strict";
import { createHmac, randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";

import { ActivityService } from "../src/activity.js";
import { createAuthenticationSecretCodec } from "../src/authentication-secrets.js";
import { AutomationService } from "../src/automations.js";
import { BoardService } from "../src/boards.js";
import { EmbeddedInstanceStore } from "../src/embedded-instance-store.js";
import { GitHubSignalService } from "../src/github-signals.js";
import { startInstance } from "./support/start-test-instance.js";
import { MobileCaptureService } from "../src/mobile-captures.js";
import { NoteService } from "../src/notes.js";
import { NotificationService } from "../src/notifications.js";
import { PortableWorkspaceExportService } from "../src/portable-workspace-export.js";
import { PortableWorkspaceImportService } from "../src/portable-workspace-import.js";
import { ProjectWorkflowService } from "../src/project-workflows.js";
import { RepositoryConnectionService, type GitHubApp } from "../src/repository-connections.js";
import { LocalAttachmentStorage } from "../src/attachments.js";
import { TaskService } from "../src/tasks.js";
import { WorkspaceProjectService } from "../src/workspaces-projects.js";

const ownerId = "11111111-1111-4111-8111-111111111111";
const organizationId = "22222222-2222-4222-8222-222222222222";
const bearer = "Bearer stable-release-owner";
const webhookSecret = "stable-release-protocol-fake";

describe("first stable release journey through a running Instance", () => {
  const cleanups: Array<() => Promise<void>> = [];
  afterEach(async () => { while (cleanups.length) await cleanups.pop()!(); });

  it("carries captured thinking through planning, development, Automation, and a portable round trip", async () => {
    const root = await mkdtemp(join(tmpdir(), "stash-stable-release-"));
    const codec = createAuthenticationSecretCodec(randomBytes(32).toString("base64"));
    const store = await EmbeddedInstanceStore.open(root, codec);
    await store.database.prepareInstanceStore();
    await store.database.createFirstOrganizationOwner({ organizationId, organizationName: "Release Team", ownerId,
      ownerName: "Release Owner", ownerEmail: "owner@release.test", passwordHash: "fixture-only", role: "Owner" });
    const attachments = new LocalAttachmentStorage(store.paths.attachments);
    const notifications = new NotificationService(store.database.workPlanningRepositories());
    const automations = new AutomationService(store.database.workPlanningRepositories(), notifications);
    const githubApp: GitHubApp = { async inspectRepository(input) { return { installationId: input.installationId,
      repositoryId: "987", repositoryUrl: "https://github.com/acme/stash" }; }, async verifyRepository() {} };
    const connections = new RepositoryConnectionService(store.database.developmentIntegrationRepositories(), githubApp);
    const instance = await startInstance({ database: store.database, host: "127.0.0.1", port: 0, instanceAdminToken: "operator",
      memberAccess: { async authenticateBearer(value) { return value === bearer ? { accountId: ownerId, sessionId: "release-session" } : undefined; } },
      workspaceProjects: new WorkspaceProjectService(store.database.identityAccessRepositories()), notes: new NoteService(store.database.knowledgeAuthoringRepositories()),
      mobileCaptures: new MobileCaptureService(store.database.knowledgeAuthoringRepositories()), tasks: new TaskService(store.database.workPlanningRepositories(), store.database),
      projectWorkflows: new ProjectWorkflowService(store.database.workPlanningRepositories()), boards: new BoardService(store.database.workPlanningRepositories()),
      repositoryConnections: connections, githubSignals: new GitHubSignalService(store.database.developmentIntegrationRepositories(), webhookSecret, automations),
      automations, activities: new ActivityService(store.database.knowledgeAuthoringRepositories()), portableWorkspaceExports: new PortableWorkspaceExportService(store.database.knowledgeAuthoringRepositories(), attachments) });
    cleanups.push(async () => { await instance.close(); await store.close(); await rm(root, { recursive: true, force: true }); });
    const json = (path: string, init: RequestInit = {}) => fetch(`${instance.url}${path}`, { ...init,
      headers: { authorization: bearer, ...(init.body ? { "content-type": "application/json" } : {}), ...init.headers } });

    const workspaceResponse = await json("/api/workspaces", { method: "POST", body: JSON.stringify({ name: "Release Workspace", owner: { type: "organization", organizationId } }) });
    assert.equal(workspaceResponse.status, 201); const workspace = await workspaceResponse.json() as { id: string };
    const projectResponse = await json(`/api/workspaces/${workspace.id}/projects`, { method: "POST", body: JSON.stringify({ name: "Stable Release", key: "REL" }) });
    assert.equal(projectResponse.status, 201); const project = await projectResponse.json() as { id: string };

    const invalidCapture = await json(`/api/mobile/v1/workspaces/${workspace.id}/captures`, { method: "POST", body: JSON.stringify({ content: "lost" }) });
    assert.equal(invalidCapture.status, 422);
    const captureId = randomUUID();
    const capture = await json(`/api/mobile/v1/workspaces/${workspace.id}/captures`, { method: "POST", body: JSON.stringify({
      protocol: "stash.mobile-capture.v1", id: captureId, kind: "text", content: "Ship the first stable release", projectId: project.id,
      tags: ["release"], createdAt: "2026-08-25T08:00:00+02:00",
    }) });
    assert.equal(capture.status, 201); const { noteId } = await capture.json() as { noteId: string };
    assert.equal((await json(`/api/mobile/v1/workspaces/${workspace.id}/captures`, { method: "POST", body: JSON.stringify({
      protocol: "stash.mobile-capture.v1", id: captureId, kind: "text", content: "Ship the first stable release", projectId: project.id,
      tags: ["release"], createdAt: "2026-08-25T08:00:00+02:00",
    }) })).status, 200);
    const note = await (await json(`/api/notes/${noteId}`)).json() as { document: { blocks: Array<{ blockKey: string }> } };
    const taskResponse = await json(`/api/notes/${noteId}/blocks/${note.document.blocks[0]!.blockKey}/tasks`, { method: "POST",
      body: JSON.stringify({ projectId: project.id, title: "Publish Stash" }) });
    assert.equal(taskResponse.status, 201); const { task } = await taskResponse.json() as { task: { key: string } };

    const workflow = await (await json(`/api/projects/${project.id}/workflow`)).json() as { workflow: { statuses: Array<{ id: string; category: string }> } };
    const started = workflow.workflow.statuses.find(({ category }) => category === "started")!;
    const boardResponse = await json(`/api/projects/${project.id}/boards`, { method: "POST", body: JSON.stringify({ name: "Delivery", groupBy: "status" }) });
    assert.equal(boardResponse.status, 201); const { board } = await boardResponse.json() as { board: { id: string } };
    assert.equal((await json(`/api/projects/${project.id}/boards/${board.id}/tasks/${task.key}`, { method: "PATCH", body: JSON.stringify({ statusId: started.id }) })).status, 200);

    const connectionPath = `/api/organizations/${organizationId}/repository-connections`;
    assert.equal((await fetch(`${instance.url}${connectionPath}`, { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ installationId: 42, owner: "acme", name: "stash" }) })).status, 401);
    assert.equal((await json(connectionPath, { method: "POST", body: JSON.stringify({ installationId: "invalid", owner: "acme", name: "stash" }) })).status, 422);
    const connectionResponse = await json(connectionPath, { method: "POST", body: JSON.stringify({ installationId: 42, owner: "acme", name: "stash" }) });
    assert.equal(connectionResponse.status, 201); const connection = await connectionResponse.json() as { id: string; repositoryUrl: string };
    assert.equal(connection.repositoryUrl, "https://github.com/acme/stash");
    assert.equal((await json(`${connectionPath}/${connection.id}/projects/${project.id}`, { method: "POST" })).status, 204);
    const completed = workflow.workflow.statuses.find(({ category }) => category === "completed")!;
    assert.equal((await json(`/api/projects/${project.id}/automations`, { method: "POST", body: JSON.stringify({ trigger: "pull_request_completed", targetStatusId: completed.id }) })).status, 200);
    const webhookBody = JSON.stringify({ action: "closed", installation: { id: 42 }, repository: { id: 987, html_url: "https://github.com/acme/stash" },
      pull_request: { id: 56, number: 56, html_url: "https://github.com/acme/stash/pull/56", title: `${task.key} stable release`, body: "Ready", merged: true } });
    const signature = `sha256=${createHmac("sha256", webhookSecret).update(webhookBody).digest("hex")}`;
    assert.equal((await fetch(`${instance.url}/api/github/webhooks`, { method: "POST", headers: { "x-github-event": "pull_request",
      "x-github-delivery": "stable-release-delivery", "x-hub-signature-256": signature }, body: webhookBody })).status, 202);
    assert.equal((await fetch(`${instance.url}/api/github/webhooks`, { method: "POST", headers: { "x-github-event": "pull_request",
      "x-github-delivery": "forged", "x-hub-signature-256": "sha256=forged" }, body: webhookBody })).status, 401);
    const planned = await (await json(`/api/projects/${project.id}/tasks/${task.key}`)).json() as { task: { status: { category: string }; developmentLinks: unknown[] } };
    assert.equal(planned.task.status.category, "completed"); assert.equal(planned.task.developmentLinks.length, 1);
    assert.equal((await fetch(`${instance.url}/api/workspaces/${workspace.id}/export`)).status, 401);
    const exported = await json(`/api/workspaces/${workspace.id}/export`);
    assert.equal(exported.status, 200); assert.equal(exported.headers.get("content-type"), "application/zip");
    const archive = Buffer.from(await exported.arrayBuffer()); assert.ok(archive.byteLength > 0);

    const destinationRoot = await mkdtemp(join(tmpdir(), "stash-stable-release-import-"));
    const destination = await EmbeddedInstanceStore.open(destinationRoot, codec);
    await destination.database.prepareInstanceStore();
    await destination.database.createFirstOrganizationOwner({ organizationId, organizationName: "Release Team", ownerId,
      ownerName: "Release Owner", ownerEmail: "owner@release.test", passwordHash: "fixture-only", role: "Owner" });
    const destinationAttachments = new LocalAttachmentStorage(destination.paths.attachments);
    const importedInstance = await startInstance({ database: destination.database, host: "127.0.0.1", port: 0, instanceAdminToken: "operator",
      memberAccess: { async authenticateBearer(value) { return value === bearer ? { accountId: ownerId, sessionId: "import-session" } : undefined; } },
      notes: new NoteService(destination.database.knowledgeAuthoringRepositories()), tasks: new TaskService(destination.database.workPlanningRepositories(), destination.database),
      portableWorkspaceImports: new PortableWorkspaceImportService(destination.database.knowledgeAuthoringRepositories(), destinationAttachments),
      portableWorkspaceExports: new PortableWorkspaceExportService(destination.database.knowledgeAuthoringRepositories(), destinationAttachments) });
    cleanups.push(async () => { await importedInstance.close(); await destination.close(); await rm(destinationRoot, { recursive: true, force: true }); });
    const imported = await fetch(`${importedInstance.url}/api/workspace-imports`, { method: "POST", headers: { authorization: "Bearer operator",
      "idempotency-key": randomUUID(), "x-stash-import-owner-account-id": ownerId, "content-type": "application/zip" }, body: archive });
    assert.equal(imported.status, 201); assert.equal((await imported.json() as { status: string }).status, "imported");
    const reexported = await fetch(`${importedInstance.url}/api/workspaces/${workspace.id}/export`, { headers: { authorization: bearer } });
    assert.equal(reexported.status, 200); assert.ok((await reexported.arrayBuffer()).byteLength > 0);
    const importedNotes = await fetch(`${importedInstance.url}/api/workspaces/${workspace.id}/notes`, { headers: { authorization: bearer } });
    assert.equal(importedNotes.status, 200); assert.match(JSON.stringify(await importedNotes.json()), /Ship the first stable release/);
    const importedTask = await fetch(`${importedInstance.url}/api/projects/${project.id}/tasks/${task.key}`, { headers: { authorization: bearer } });
    assert.equal(importedTask.status, 200);
    const importedTaskBody = await importedTask.json() as { task: { title: string; status: { category: string }; developmentLinks: unknown[] } };
    assert.equal(importedTaskBody.task.title, "Publish Stash"); assert.equal(importedTaskBody.task.status.category, "completed");
    assert.equal(importedTaskBody.task.developmentLinks.length, 1);
  });

  it("surfaces a recoverable capture outage without committing or exposing its cause", async () => {
    let unavailable = true; let commits = 0; let committedId: string | undefined;
    const instance = await startInstance({ database: { async verifyConnection() {}, async close() {} }, host: "127.0.0.1", port: 0,
      instanceAdminToken: "operator", memberAccess: { async authenticateBearer(value) { return value === bearer
        ? { accountId: ownerId, sessionId: "failure-session" } : undefined; } }, mobileCaptures: new MobileCaptureService({
        async findPortableMemberIdentity() { return { localAccountId: ownerId, displayName: "Release Owner" }; },
        async createMobileCapture(_memberId, captureId) {
          if (unavailable) throw new Error("postgres://operator:secret@database/stash");
          if (captureId === committedId) return { status: "duplicate" as const, noteId: "44444444-4444-4444-8444-444444444444" };
          commits += 1; committedId = captureId;
          return { status: "created" as const, noteId: "44444444-4444-4444-8444-444444444444" };
        },
        async listMobileCaptureOptions() { return { status: "found", projects: [], tags: [] }; },
      }) });
    cleanups.push(() => instance.close());
    const captureId = randomUUID(); const request = () => fetch(`${instance.url}/api/mobile/v1/workspaces/33333333-3333-4333-8333-333333333333/captures`, {
      method: "POST", headers: { authorization: bearer, "content-type": "application/json" }, body: JSON.stringify({
        protocol: "stash.mobile-capture.v1", id: captureId, kind: "text", content: "Retry this capture",
        createdAt: "2026-08-25T08:00:00+02:00",
      }),
    });
    const response = await request();
    assert.equal(response.status, 503); assert.deepEqual(await response.json(), {
      error: "capture_unavailable", message: "The capture could not be synchronized. Try again.",
    });
    assert.equal(commits, 0);
    unavailable = false;
    assert.equal((await request()).status, 201); assert.equal(commits, 1);
    assert.equal((await request()).status, 200); assert.equal(commits, 1);
  });
});
