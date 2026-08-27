import assert from "node:assert/strict";
import { after, describe, it } from "node:test";
import { randomBytes, randomUUID } from "node:crypto";
import { Pool } from "pg";
import * as Y from "yjs";

import { createAuthenticationSecretCodec } from "../src/authentication-secrets.js";
import { NoteCollaborationService } from "../src/note-collaboration.js";
import { NoteService } from "../src/notes.js";
import { OwnerBootstrapService } from "../src/owner-bootstrap.js";
import { collaborativeDocumentFromRichText, PostgresDatabase } from "../src/postgres-database.js";
import { WorkspaceProjectService } from "../src/workspaces-projects.js";

const databaseUrl = process.env.STASH_TEST_DATABASE_URL;

describe("PostgreSQL Note collaboration", { skip: databaseUrl ? false : "STASH_TEST_DATABASE_URL is not configured" }, () => {
  let database: PostgresDatabase; let admin: Pool; let probe: Pool; let schema: string;
  after(async () => { await database?.close(); await probe?.end();
    if (admin) { await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`); await admin.end(); } });

  it("atomically materializes canonical Note state, projection, history, and attributed activity", async () => {
    admin = new Pool({ connectionString: databaseUrl! }); schema = `note_collaboration_${randomUUID().replaceAll("-", "")}`;
    await admin.query(`CREATE SCHEMA ${schema}`); const scopedUrl = new URL(databaseUrl!);
    scopedUrl.searchParams.set("options", `-csearch_path=${schema}`); const scopedDatabaseUrl = scopedUrl.toString();
    database = new PostgresDatabase(scopedDatabaseUrl, createAuthenticationSecretCodec(randomBytes(32).toString("base64")));
    const owner = await new OwnerBootstrapService(database).bootstrap({ organizationName: "Collaboration", ownerName: "Creator",
      ownerEmail: `creator-${randomUUID()}@example.test`, password: "test-password-long-enough" }); assert.ok(owner);
    const workspaces = new WorkspaceProjectService(database.identityAccessRepositories());
    const workspace = await workspaces.createWorkspace(owner.ownerId, { name: "Shared", owner: { type: "organization", organizationId: owner.organizationId } });
    assert.equal(workspace.status, "created"); if (workspace.status !== "created") return;
    const project = await workspaces.createProject(owner.ownerId, workspace.workspace.id, { name: "Notes", key: "NOTE" });
    assert.equal(project.status, "created"); if (project.status !== "created") return;
    const captured = await new NoteService(database.knowledgeAuthoringRepositories()).capture(owner.ownerId, workspace.workspace.id, { content: "Original", projectId: project.project.id });
    assert.equal(captured.status, "created"); if (captured.status !== "created") return;
    const editorId = randomUUID(); const readerId = randomUUID(); probe = new Pool({ connectionString: scopedDatabaseUrl });
    await probe.query("INSERT INTO stash_accounts(id,name,email,password_hash) VALUES($1,'Editor',$2,'unused'),($3,'Reader',$4,'unused')",
      [editorId, `editor-${randomUUID()}@example.test`, readerId, `reader-${randomUUID()}@example.test`]);
    await probe.query("INSERT INTO stash_organization_memberships(organization_id,account_id,role) VALUES($1,$2,'Member')", [owner.organizationId, editorId]);
    await probe.query("INSERT INTO stash_project_guests(project_id,account_id) VALUES($1,$2)", [project.project.id, readerId]);
    const collaboration = new NoteCollaborationService(database.knowledgeAuthoringRepositories());
    assert.ok(await collaboration.load(readerId, captured.note.id));
    const denied = new Y.Doc(); denied.getText("note").insert(0, "denied");
    assert.equal(await collaboration.apply(readerId, captured.note.id, Y.encodeStateAsUpdate(denied)), undefined); denied.destroy();
    const initial = await collaboration.load(editorId, captured.note.id); assert.ok(initial);
    const document = new Y.Doc(); Y.applyUpdate(document, initial.update); const stateVector = Y.encodeStateVector(document);
    const paragraph = document.getXmlFragment("default").get(0)! as Y.XmlElement;
    const text = paragraph.get(0) as Y.XmlText; text.delete(0, text.length); text.insert(0, "Edited together");
    const editUpdate = Y.encodeStateAsUpdate(document, stateVector);
    const applied = await collaboration.apply(editorId, captured.note.id, editUpdate);
    assert.equal(applied?.sequence, 1); document.destroy();
    const retry = await collaboration.apply(editorId, captured.note.id, editUpdate); assert.equal(retry?.sequence, 1);
    const structured = collaborativeDocumentFromRichText({ type: "doc", blocks: [
      { type: "check", checked: true, id: "11111111-1111-4111-8111-111111111111", content: [{ text: "Parent" }], children: [{ type: "bullet", items: [
        { id: "22222222-2222-4222-8222-222222222222", content: [{ text: "Nested" }] },
      ] }] },
      { type: "callout", kind: "warning", id: "33333333-3333-4333-8333-333333333333", paragraphs: [
        { id: "44444444-4444-4444-8444-444444444444", content: [{ text: "First paragraph" }] },
        { id: "55555555-5555-4555-8555-555555555555", content: [{ text: "Second paragraph" }] },
      ] },
    ] });
    const structuredResult = await collaboration.apply(editorId, captured.note.id, Y.encodeStateAsUpdate(structured));
    assert.equal(structuredResult?.sequence, 2); structured.destroy();
    const canonical = (await probe.query<any>("SELECT content,document,revision,created_by_account_id FROM stash_notes WHERE id=$1", [captured.note.id])).rows[0];
    assert.match(canonical.content, /  - Nested/); assert.match(canonical.content, />\n> Second paragraph/);
    assert.equal(canonical.document.blocks.find((block: any) => block.type === "check").children[0].items[0].id, "22222222-2222-4222-8222-222222222222");
    assert.equal(canonical.document.blocks.find((block: any) => block.type === "callout").paragraphs.length, 2);
    assert.equal(canonical.revision, 3); assert.equal(canonical.created_by_account_id, owner.ownerId);
    const projection = (await probe.query<any>(`SELECT payload FROM stash_portable_projection_outbox
      WHERE object_kind='Note' AND object_id=$1 ORDER BY revision DESC LIMIT 1`, [captured.note.id])).rows[0].payload;
    assert.equal(projection.content, canonical.content); assert.equal(projection.createdBy.localAccountId, owner.ownerId);
    const history = (await probe.query<any>("SELECT revision,actor_account_id,content FROM stash_note_history WHERE note_id=$1 ORDER BY revision", [captured.note.id])).rows;
    assert.deepEqual(history.map(({ revision, actor_account_id, content }) => [revision, actor_account_id, content]),
      [[1, owner.ownerId, "Original"], [2, editorId, "Edited together"], [3, editorId, canonical.content]]);
    const activity = (await probe.query<any>(`SELECT action,actor_account_id,after_state FROM stash_workspace_activity
      WHERE object_kind='Note' AND object_id=$1 ORDER BY occurred_at DESC LIMIT 1`, [captured.note.id])).rows[0];
    assert.equal(activity.action, "note_edited"); assert.equal(activity.actor_account_id, editorId); assert.equal(activity.after_state.revision, 2);
  });
});
