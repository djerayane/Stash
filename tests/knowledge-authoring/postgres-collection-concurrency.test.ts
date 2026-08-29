import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { after, describe, test } from "node:test";
import { Pool } from "pg";

import { createAuthenticationSecretCodec } from "../../src/authentication-secrets.js";
import { CollectionService } from "../../src/knowledge-authoring/collections.js";
import { EmptyCollectionImpactInspector, NoteTreeService } from "../../src/knowledge-authoring/note-tree.js";
import { PostgresDatabase } from "../../src/postgres-database.js";
import { WorkspaceProjectService } from "../../src/workspaces-projects.js";

const databaseUrl = process.env.STASH_TEST_DATABASE_URL;

describe("PostgreSQL Collection concurrency", { skip: databaseUrl ? false : "STASH_TEST_DATABASE_URL is not configured" }, () => {
  let database: PostgresDatabase | undefined; let admin: Pool | undefined; let schema = "";
  after(async () => { await database?.close(); if (admin) { await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`); await admin.end(); } });

  test("applies reciprocal Collection relations through one global lock order", async () => {
    admin = new Pool({ connectionString: databaseUrl! }); schema = `collection_concurrency_${randomUUID().replaceAll("-", "")}`;
    await admin.query(`CREATE SCHEMA ${schema}`); const scoped = new URL(databaseUrl!); scoped.searchParams.set("options", `-csearch_path=${schema}`);
    database = new PostgresDatabase(scoped.toString(), createAuthenticationSecretCodec(randomBytes(32).toString("base64")));
    const ownerId = randomUUID(); const organizationId = randomUUID();
    await database.createFirstOrganizationOwner({ organizationId, organizationName: "Collection concurrency", ownerId, ownerName: "Owner",
      ownerEmail: `${ownerId}@stash.test`, passwordHash: "test-only", role: "Owner" });
    const workspace = await new WorkspaceProjectService(database.identityAccessRepositories()).createWorkspace(ownerId,
      { name: "Relations", owner: { type: "organization", organizationId } });
    assert.equal(workspace.status, "created"); if (workspace.status !== "created") return;
    const note = await new NoteTreeService(database.noteTreeRepository(), new EmptyCollectionImpactInspector())
      .create(ownerId, workspace.workspace.id, { title: "Reciprocal records" });
    assert.equal(note.status, "created"); if (note.status !== "created") return;
    const service = new CollectionService(database.collectionRepository());
    const firstCollectionId = randomUUID(); const secondCollectionId = randomUUID();
    const firstPropertyId = randomUUID(); const secondPropertyId = randomUUID();
    const firstRecordId = randomUUID(); const secondRecordId = randomUUID();
    assert.equal((await service.create(ownerId, note.node.id, { schema: "stash.collection.v1", id: firstCollectionId,
      workspaceId: workspace.workspace.id, ownerNoteId: note.node.id, title: "First", properties: [{ id: firstPropertyId,
        name: "Second", type: "relation", position: 1, target: { kind: "collection_records", collectionId: secondCollectionId } }],
      records: [{ id: firstRecordId, position: 1, values: {} }] })).status, "created");
    assert.equal((await service.create(ownerId, note.node.id, { schema: "stash.collection.v1", id: secondCollectionId,
      workspaceId: workspace.workspace.id, ownerNoteId: note.node.id, title: "Second", properties: [{ id: secondPropertyId,
        name: "First", type: "relation", position: 1, target: { kind: "collection_records", collectionId: firstCollectionId } }],
      records: [{ id: secondRecordId, position: 1, values: {} }] })).status, "created");

    const results = await Promise.all([
      service.updateRecord(ownerId, firstCollectionId, firstRecordId,
        { values: { [firstPropertyId]: [{ id: secondRecordId, fallback: "Second" }] } }),
      service.updateRecord(ownerId, secondCollectionId, secondRecordId,
        { values: { [secondPropertyId]: [{ id: firstRecordId, fallback: "First" }] } }),
    ]);
    assert.deepEqual(results.map(({ status }) => status), ["updated", "updated"]);
  });
});
