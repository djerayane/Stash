import assert from "node:assert/strict";
import { after, describe, it } from "node:test";
import { randomBytes, randomUUID } from "node:crypto";
import { Pool } from "pg";

import { createAuthenticationSecretCodec } from "../src/authentication-secrets.js";
import { NoteService } from "../src/notes.js";
import { OwnerBootstrapService } from "../src/owner-bootstrap.js";
import { PostgresDatabase } from "../src/postgres-database.js";
import { WorkspaceSearchService } from "../src/workspace-search.js";
import { WorkspaceProjectService } from "../src/workspaces-projects.js";

const databaseUrl = process.env.STASH_TEST_DATABASE_URL;

describe("PostgreSQL permission-safe Workspace search", { skip: !databaseUrl }, () => {
  let database: PostgresDatabase; let admin: Pool; let schema: string;
  after(async () => {
    await database?.close();
    if (admin) { await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`); await admin.end(); }
  });

  it("derives matching, totals, facets, and explicit Project errors only from authorized candidates", async () => {
    admin = new Pool({ connectionString: databaseUrl! }); schema = `search_permissions_${randomUUID().replaceAll("-", "")}`;
    await admin.query(`CREATE SCHEMA ${schema}`);
    const scopedUrl = new URL(databaseUrl!); scopedUrl.searchParams.set("options", `-csearch_path=${schema}`);
    database = new PostgresDatabase(scopedUrl.toString(), createAuthenticationSecretCodec(randomBytes(32).toString("base64")));
    const owner = await new OwnerBootstrapService(database).bootstrap({ organizationName: "Search Test", ownerName: "Ada Lovelace",
      ownerEmail: `ada-${randomUUID()}@example.test`, password: "test-password-long-enough" }); assert.ok(owner);
    const workspaces = new WorkspaceProjectService(database);
    const workspace = await workspaces.createWorkspace(owner.ownerId, { name: "Search", owner: { type: "organization", organizationId: owner.organizationId } });
    assert.equal(workspace.status, "created"); if (workspace.status !== "created") return;
    const visibleProject = await workspaces.createProject(owner.ownerId, workspace.workspace.id, { name: "Visible", key: "VISIBLE" });
    const restrictedProject = await workspaces.createProject(owner.ownerId, workspace.workspace.id, { name: "Restricted", key: "RESTRICTED" });
    assert.equal(visibleProject.status, "created"); assert.equal(restrictedProject.status, "created");
    if (visibleProject.status !== "created" || restrictedProject.status !== "created") return;
    const notes = new NoteService(database.knowledgeAuthoringRepositories());
    assert.equal((await notes.capture(owner.ownerId, workspace.workspace.id, { projectId: visibleProject.project.id, content: "launch visible" })).status, "created");
    assert.equal((await notes.capture(owner.ownerId, workspace.workspace.id, { projectId: restrictedProject.project.id, content: "launch restricted-secret" })).status, "created");
    const search = new WorkspaceSearchService(database);
    const ownerResults = await search.search(owner.ownerId, workspace.workspace.id, { q: "launch" });
    assert.equal(ownerResults.status, "found"); if (ownerResults.status !== "found") return;
    assert.equal(ownerResults.total, 2);

    const guestId = randomUUID(); const setup = new Pool({ connectionString: scopedUrl.toString() });
    await setup.query("INSERT INTO stash_accounts(id,name,email,password_hash) VALUES($1,'Grace Guest',$2,'test-hash')",
      [guestId, `grace-${randomUUID()}@example.test`]);
    await setup.query("INSERT INTO stash_project_guests(project_id,account_id) VALUES($1,$2)",
      [visibleProject.project.id, guestId]); await setup.end();
    const guestResults = await search.search(guestId, workspace.workspace.id, { q: "launch" });
    assert.equal(guestResults.status, "found"); if (guestResults.status !== "found") return;
    assert.equal(guestResults.total, 1);
    assert.deepEqual(guestResults.facets.projects, [{ value: visibleProject.project.id, count: 1 }]);
    assert.doesNotMatch(JSON.stringify(guestResults), /restricted-secret/);
    assert.deepEqual(await search.search(guestId, workspace.workspace.id, { q: "launch", projectId: restrictedProject.project.id }), { status: "forbidden" });
    assert.deepEqual(await search.search(guestId, randomUUID(), { q: "launch" }), { status: "forbidden" });
  });
});
