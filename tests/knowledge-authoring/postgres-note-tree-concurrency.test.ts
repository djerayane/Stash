import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { after, describe, test } from "node:test";
import { Pool } from "pg";

import { createAuthenticationSecretCodec } from "../../src/authentication-secrets.js";
import { NoteTreeService } from "../../src/knowledge-authoring/note-tree.js";
import { PostgresDatabase } from "../../src/postgres-database.js";
import { WorkspaceProjectService } from "../../src/workspaces-projects.js";

const databaseUrl = process.env.STASH_TEST_DATABASE_URL;

describe("PostgreSQL Note Tree concurrency", { skip: databaseUrl ? false : "STASH_TEST_DATABASE_URL is not configured" }, () => {
  let database: PostgresDatabase | undefined; let admin: Pool | undefined; let schema = "";
  after(async () => { await database?.close(); if (admin) { await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`); await admin.end(); } });

  test("serializes inverse branch moves before checking cycles", async () => {
    admin = new Pool({ connectionString: databaseUrl! }); schema = `note_tree_${randomUUID().replaceAll("-", "")}`;
    await admin.query(`CREATE SCHEMA ${schema}`); const scoped = new URL(databaseUrl!); scoped.searchParams.set("options", `-csearch_path=${schema}`);
    database = new PostgresDatabase(scoped.toString(), createAuthenticationSecretCodec(randomBytes(32).toString("base64")));
    const ownerId = randomUUID(); const organizationId = randomUUID();
    await database.createFirstOrganizationOwner({ organizationId, organizationName: "Tree concurrency", ownerId, ownerName: "Owner",
      ownerEmail: `${ownerId}@stash.test`, passwordHash: "test-only", role: "Owner" });
    const workspace = await new WorkspaceProjectService(database).createWorkspace(ownerId,
      { name: "Tree", owner: { type: "organization", organizationId } });
    assert.equal(workspace.status, "created"); if (workspace.status !== "created") return;
    const service = new NoteTreeService(database.noteTreeRepository());
    const first = await service.create(ownerId, workspace.workspace.id, { title: "First" });
    const second = await service.create(ownerId, workspace.workspace.id, { title: "Second" });
    assert.equal(first.status, "created"); assert.equal(second.status, "created");
    if (first.status !== "created" || second.status !== "created") return;

    const results = await Promise.all([
      service.moveNoteBranch(first.node.id, { parentId: second.node.id }, ownerId),
      service.moveNoteBranch(second.node.id, { parentId: first.node.id }, ownerId),
    ]);
    assert.equal(results.filter(({ status }) => status === "moved").length, 1);
    assert.equal(results.filter(({ status }) => status === "cycle").length, 1);
    const tree = await service.list(ownerId, workspace.workspace.id); assert.equal(tree.status, "found"); if (tree.status !== "found") return;
    const parent = new Map(tree.nodes.map((node) => [node.id, node.parentId]));
    for (const start of [first.node.id, second.node.id]) { const seen = new Set<string>(); let cursor: string | undefined = start;
      while (cursor) { assert.equal(seen.has(cursor), false); seen.add(cursor); cursor = parent.get(cursor); } }
  });
});
