import assert from "node:assert/strict";
import { createHmac, randomBytes, randomUUID } from "node:crypto";
import { describe, it } from "node:test";
import { Pool } from "pg";

import { createAuthenticationSecretCodec } from "../src/authentication-secrets.js";
import { GitHubSignalService } from "../src/github-signals.js";
import { startInstance, type RunningInstance } from "../src/instance.js";
import { NoteService } from "../src/notes.js";
import { PostgresDatabase } from "../src/postgres-database.js";
import { RepositoryConnectionService, type GitHubApp } from "../src/repository-connections.js";
import { TaskService } from "../src/tasks.js";
import { WorkspaceProjectService } from "../src/workspaces-projects.js";
import { AutomationService } from "../src/automations.js";
import { NotificationService, type NotificationDelivery } from "../src/notifications.js";

const databaseUrl = process.env.STASH_TEST_DATABASE_URL;

describe("PostgreSQL GitHub Signal acceptance", { skip: databaseUrl ? false : "STASH_TEST_DATABASE_URL is not configured" }, () => {
  it("records and notifies each exact failed Automation execution once", async () => {
    const connectionString = databaseUrl!; const schema = `automation_failure_${randomUUID().replaceAll("-", "")}`;
    const administration = new Pool({ connectionString }); await administration.query(`CREATE SCHEMA ${schema}`);
    const separator = connectionString.includes("?") ? "&" : "?"; const scoped = `${connectionString}${separator}options=-csearch_path%3D${schema}`;
    const database = new PostgresDatabase(scoped, createAuthenticationSecretCodec(randomBytes(32).toString("base64")));
    const sql = new Pool({ connectionString: scoped }); let instance: RunningInstance | undefined;
    const ownerId = "11111111-1111-4111-8111-111111111111"; const organizationId = "22222222-2222-4222-8222-222222222222";
    try {
      await database.createFirstOrganizationOwner({ organizationId, organizationName: "Automation organization", ownerId,
        ownerName: "Automation Owner", ownerEmail: "automation-owner@example.test", passwordHash: "test", role: "Owner" });
      const workspaces = new WorkspaceProjectService(database); const notes = new NoteService(database); const tasks = new TaskService(database, database);
      const workspace = await workspaces.createWorkspace(ownerId, { name: "Automation workspace", owner: { type: "organization", organizationId } });
      assert.equal(workspace.status, "created"); if (workspace.status !== "created") throw new Error("workspace setup failed");
      const project = await workspaces.createProject(ownerId, workspace.workspace.id, { name: "Automation project", key: "AUTO" });
      assert.equal(project.status, "created"); if (project.status !== "created") throw new Error("project setup failed");
      const note = await notes.capture(ownerId, workspace.workspace.id, { projectId: project.project.id, content: "Automation source" });
      assert.equal(note.status, "created"); if (note.status !== "created") throw new Error("note setup failed");
      const created = await tasks.createFromBlock(ownerId, note.note.id, note.note.document.blocks[0]!.blockKey!,
        { projectId: project.project.id, title: "Fail visibly" });
      assert.equal(created.status, "created"); if (created.status !== "created") throw new Error("task setup failed");
      const target = await sql.query<{ id: string }>("SELECT id FROM stash_workflow_statuses WHERE project_id=$1 AND category='started' ORDER BY position LIMIT 1", [project.project.id]);
      const notifications = new NotificationService(database); const automations = new AutomationService(database, notifications);
      await automations.enable(ownerId, project.project.id, { trigger: "branch_created", targetStatusId: target.rows[0]!.id });
      const github: GitHubApp = { async inspectRepository(input) { return { installationId: input.installationId, repositoryId: "987", repositoryUrl: "https://github.com/acme/stash" }; }, async verifyRepository() {} };
      const connections = new RepositoryConnectionService(database, github);
      const connection = await connections.connect(ownerId, organizationId, { installationId: 42, owner: "acme", name: "stash" });
      assert.equal(await connections.attachToProject(ownerId, organizationId, connection.connection.id, project.project.id), "attached");
      await sql.query(`CREATE FUNCTION reject_automation_status_update() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
        RAISE EXCEPTION 'forced Automation failure'; END $$;
        CREATE TRIGGER reject_automation_status_update BEFORE UPDATE ON stash_tasks FOR EACH ROW
        WHEN (OLD.workflow_status_id IS DISTINCT FROM NEW.workflow_status_id) EXECUTE FUNCTION reject_automation_status_update()`);
      const secret = "postgres-automation-failure-secret";
      instance = await startInstance({ database, host: "127.0.0.1", port: 0, instanceAdminToken: "admin",
        githubSignals: new GitHubSignalService(database, secret, automations), automations, notifications,
        memberAccess: { async authenticateBearer(value) { return value === "Bearer owner" ? { accountId: ownerId, sessionId: "owner" } : undefined; } } });
      const deliver = async (deliveryId: string) => {
        const body = JSON.stringify({ ref_type: "branch", ref: `AUTO-1-${deliveryId}`, installation: { id: 42 },
          repository: { id: 987, html_url: "https://github.com/acme/stash" } });
        return fetch(`${instance!.url}/api/github/webhooks`, { method: "POST", headers: { "x-github-event": "create",
          "x-github-delivery": deliveryId, "x-hub-signature-256": `sha256=${createHmac("sha256", secret).update(body).digest("hex")}` }, body });
      };
      assert.equal((await deliver("failed-run")).status, 503);
      assert.equal((await deliver("failed-run")).status, 503);
      const inbox = await fetch(`${instance.url}/api/notifications`, { headers: { authorization: "Bearer owner" } });
      const deliveries = (await inbox.json() as { notifications: NotificationDelivery[] }).notifications;
      assert.equal(deliveries.length, 1); assert.equal(deliveries[0]!.memberId, ownerId);
      assert.equal(deliveries[0]!.activity.action, "automation_execution_failed");
      assert.deepEqual(deliveries[0]!.activity.after, { status: "failed" });
      assert.equal((await sql.query("SELECT COUNT(*)::int AS count FROM stash_automation_failures")).rows[0].count, 1);
      assert.equal((await sql.query("SELECT COUNT(*)::int AS count FROM stash_workspace_activity WHERE action='automation_execution_failed'")).rows[0].count, 1);
      assert.equal((await sql.query("SELECT COUNT(*)::int AS count FROM stash_portable_projection_outbox WHERE object_kind='Activity' AND payload->>'action'='automation_execution_failed'")).rows[0].count, 1);
      await sql.query("DELETE FROM stash_organization_memberships WHERE organization_id=$1 AND account_id=$2", [organizationId, ownerId]);
      assert.equal((await deliver("departed-owner-run")).status, 503);
      assert.equal((await sql.query("SELECT COUNT(*)::int AS count FROM stash_notifications")).rows[0].count, 1,
        "a departed configuring Member must not receive a new Project notification");
      assert.equal((await sql.query("SELECT COUNT(*)::int AS count FROM stash_workspace_activity WHERE action='automation_execution_failed'")).rows[0].count, 2,
        "the failed run remains attributed Activity after recipient access is revoked");
    } finally {
      await instance?.close().catch(() => undefined); if (!instance) await database.close().catch(() => undefined); await sql.end();
      await administration.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`).catch(() => undefined); await administration.end();
    }
  });

  it("isolates installations and persists duplicate-safe links, projection, Activity, and authorization", async () => {
    const connectionString = databaseUrl!; const schema = `signals_${randomUUID().replaceAll("-", "")}`;
    const administration = new Pool({ connectionString }); await administration.query(`CREATE SCHEMA ${schema}`);
    const separator = connectionString.includes("?") ? "&" : "?"; const scoped = `${connectionString}${separator}options=-csearch_path%3D${schema}`;
    const database = new PostgresDatabase(scoped, createAuthenticationSecretCodec(randomBytes(32).toString("base64")));
    const sql = new Pool({ connectionString: scoped }); let instance: RunningInstance | undefined;
    const ownerA = "11111111-1111-4111-8111-111111111111"; const ownerB = "22222222-2222-4222-8222-222222222222";
    const currentOwnerA = "55555555-5555-4555-8555-555555555555";
    const orgA = "33333333-3333-4333-8333-333333333333"; const orgB = "44444444-4444-4444-8444-444444444444";
    try {
      await database.createFirstOrganizationOwner({ organizationId: orgA, organizationName: "Alpha", ownerId: ownerA,
        ownerName: "Ada", ownerEmail: "ada-signals@example.test", passwordHash: "test", role: "Owner" });
      await sql.query("INSERT INTO stash_organizations(id,name) VALUES($1,'Beta')", [orgB]);
      await sql.query("INSERT INTO stash_accounts(id,name,email,password_hash) VALUES($1,'Grace','grace-signals@example.test','test')", [ownerB]);
      await sql.query("INSERT INTO stash_organization_memberships(organization_id,account_id,role) VALUES($1,$2,'Owner')", [orgB, ownerB]);
      const workspaces = new WorkspaceProjectService(database); const notes = new NoteService(database); const tasks = new TaskService(database, database);
      async function projectTask(ownerId: string, organizationId: string, workspaceName: string) {
        const workspace = await workspaces.createWorkspace(ownerId, { name: workspaceName, owner: { type: "organization", organizationId } });
        assert.equal(workspace.status, "created"); if (workspace.status !== "created") throw new Error("workspace setup failed");
        const project = await workspaces.createProject(ownerId, workspace.workspace.id, { name: workspaceName, key: "SHARED" });
        assert.equal(project.status, "created"); if (project.status !== "created") throw new Error("project setup failed");
        const note = await notes.capture(ownerId, workspace.workspace.id, { projectId: project.project.id, content: "Signal source" });
        assert.equal(note.status, "created"); if (note.status !== "created") throw new Error("note setup failed");
        const created = await tasks.createFromBlock(ownerId, note.note.id, note.note.document.blocks[0]!.blockKey!, { projectId: project.project.id, title: "Receive Signals" });
        assert.equal(created.status, "created"); if (created.status !== "created") throw new Error("task setup failed");
        return { projectId: project.project.id, task: created.task };
      }
      const alpha = await projectTask(ownerA, orgA, "Alpha project"); const beta = await projectTask(ownerB, orgB, "Beta project");
      const github: GitHubApp = { async inspectRepository(input) { return { installationId: input.installationId, repositoryId: "987", repositoryUrl: "https://github.com/acme/stash" }; }, async verifyRepository() {} };
      const connections = new RepositoryConnectionService(database, github);
      for (const setup of [{ owner: ownerA, org: orgA, installationId: 42, projectId: alpha.projectId }, { owner: ownerB, org: orgB, installationId: 42, projectId: beta.projectId }]) {
        const connection = await connections.connect(setup.owner, setup.org, { installationId: setup.installationId, owner: "acme", name: "stash" });
        assert.equal((await connections.attachToProject(setup.owner, setup.org, connection.connection.id, setup.projectId)), "attached");
      }
      await sql.query("INSERT INTO stash_accounts(id,name,email,password_hash) VALUES($1,'Katherine','katherine-signals@example.test','test')", [currentOwnerA]);
      await sql.query("INSERT INTO stash_organization_memberships(organization_id,account_id,role) VALUES($1,$2,'Owner')", [orgA, currentOwnerA]);
      await sql.query("DELETE FROM stash_organization_memberships WHERE organization_id=$1 AND account_id=$2", [orgA, ownerA]);
      const secret = "postgres-github-signal-secret"; const signals = new GitHubSignalService(database, secret);
      instance = await startInstance({ database, host: "127.0.0.1", port: 0, instanceAdminToken: "admin", githubSignals: signals,
        memberAccess: { async authenticateBearer(value) { return value === "Bearer alpha" ? { accountId: currentOwnerA, sessionId: "alpha" }
          : value === "Bearer beta" ? { accountId: ownerB, sessionId: "beta" } : undefined; } } });
      const body = JSON.stringify({ installation: { id: 42 }, repository: { id: 987, html_url: "https://github.com/acme/stash" },
        ref: "refs/heads/SHARED-1-signals", after: "a".repeat(40), head_commit: { message: "SHARED-1" } });
      const headers = { "x-github-event": "push", "x-github-delivery": "postgres-delivery", "x-hub-signature-256": `sha256=${createHmac("sha256", secret).update(body).digest("hex")}` };
      assert.equal((await fetch(`${instance.url}/api/github/webhooks`, { method: "POST", headers, body })).status, 202);
      assert.equal((await fetch(`${instance.url}/api/github/webhooks`, { method: "POST", headers, body })).status, 202);
      const alphaList = await fetch(`${instance.url}/api/projects/${alpha.projectId}/tasks/SHARED-1/development-signals`, { headers: { authorization: "Bearer alpha" } });
      assert.equal(alphaList.status, 200); assert.equal(((await alphaList.json()) as { signals: unknown[] }).signals.length, 1);
      const betaList = await fetch(`${instance.url}/api/projects/${beta.projectId}/tasks/SHARED-1/development-signals`, { headers: { authorization: "Bearer beta" } });
      assert.equal(betaList.status, 200); assert.equal(((await betaList.json()) as { signals: unknown[] }).signals.length, 1);
      assert.equal((await fetch(`${instance.url}/api/projects/${alpha.projectId}/tasks/SHARED-1/development-signals`, { headers: { authorization: "Bearer beta" } })).status, 404);
      assert.equal((await sql.query("SELECT COUNT(*)::int AS count FROM stash_github_signals")).rows[0].count, 1);
      assert.equal((await sql.query("SELECT COUNT(*)::int AS count FROM stash_workspace_activity WHERE object_id=$1 AND cause::text LIKE '%signal%'", [alpha.task.id])).rows[0].count, 1);
      const projection = await sql.query("SELECT payload FROM stash_portable_projection_outbox WHERE object_kind='Task' AND object_id=$1 ORDER BY revision DESC LIMIT 1", [alpha.task.id]);
      assert.equal(projection.rows[0].payload.developmentLinks.length, 1);
    } finally {
      await instance?.close().catch(() => undefined); if (!instance) await database.close().catch(() => undefined); await sql.end();
      await administration.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`).catch(() => undefined); await administration.end();
    }
  });
});
