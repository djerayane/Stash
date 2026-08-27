import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { describe, it } from "node:test";
import { Pool } from "pg";

import { createAuthenticationSecretCodec } from "../src/authentication-secrets.js";
import { DiscussionService } from "../src/discussions.js";
import { NoteService } from "../src/notes.js";
import { PostgresDatabase } from "../src/postgres-database.js";
import { WorkspaceProjectService } from "../src/workspaces-projects.js";

const databaseUrl = process.env.STASH_TEST_DATABASE_URL;

describe("PostgreSQL Discussion mention notifications", { skip: databaseUrl ? false : "STASH_TEST_DATABASE_URL is not configured" }, () => {
  it("commits permission-filtered Project and Workspace mentions atomically", async () => {
    const connectionString = databaseUrl!; const schema = `mentions_${randomUUID().replaceAll("-", "")}`;
    const administration = new Pool({ connectionString }); await administration.query(`CREATE SCHEMA ${schema}`);
    const separator = connectionString.includes("?") ? "&" : "?";
    const scopedUrl = `${connectionString}${separator}options=-csearch_path%3D${schema}`;
    const database = new PostgresDatabase(scopedUrl, createAuthenticationSecretCodec(randomBytes(32).toString("base64")));
    const sql = new Pool({ connectionString: scopedUrl });
    const ownerId = "11111111-1111-4111-8111-111111111111";
    const recipientId = "22222222-2222-4222-8222-222222222222";
    const inaccessibleId = "33333333-3333-4333-8333-333333333333";
    const organizationId = "44444444-4444-4444-8444-444444444444";
    try {
      await database.createFirstOrganizationOwner({ organizationId, organizationName: "Mention Test", ownerId,
        ownerName: "Ada Lovelace", ownerEmail: "ada-mentions@example.test", passwordHash: "test-only", role: "Owner" });
      await sql.query("INSERT INTO stash_accounts(id,name,email,password_hash) VALUES($1,'Grace Hopper','grace-mentions@example.test','test-only'),($2,'Private Member','private-mentions@example.test','test-only')", [recipientId, inaccessibleId]);
      await sql.query("INSERT INTO stash_organization_memberships(organization_id,account_id,role) VALUES($1,$2,'Member')", [organizationId, recipientId]);
      const workspaces = new WorkspaceProjectService(database.identityAccessRepositories());
      const workspace = await workspaces.createWorkspace(ownerId, { name: "Mentions", owner: { type: "organization", organizationId } });
      assert.equal(workspace.status, "created"); if (workspace.status !== "created") return;
      const project = await workspaces.createProject(ownerId, workspace.workspace.id, { name: "Delivery", key: "DEL" });
      assert.equal(project.status, "created"); if (project.status !== "created") return;
      const notes = new NoteService(database.knowledgeAuthoringRepositories()); const discussions = new DiscussionService(database.knowledgeAuthoringRepositories());
      for (const input of [{ content: "Project note", projectId: project.project.id }, { content: "Workspace note" }]) {
        const note = await notes.capture(ownerId, workspace.workspace.id, input); assert.equal(note.status, "created");
        if (note.status !== "created") continue;
        const discussion = await discussions.create(ownerId, { target: { kind: "note", noteId: note.note.id }, message:
          `Review <@${recipientId}> <@${recipientId}> <@${ownerId}> <@${inaccessibleId}>` });
        assert.equal(discussion.status, "created");
      }
      const inbox = await database.workPlanningRepositories().listNotifications(recipientId);
      assert.equal(inbox.length, 2); assert.equal(inbox.filter(({ projectId }) => projectId === project.project.id).length, 1);
      assert.equal(inbox.filter(({ projectId }) => projectId === undefined).length, 1);
      assert.ok(inbox.every(({ activity }) => activity.actor.localAccountId === ownerId
        && (activity.after.mentionedMemberIds as string[]).length === 1));
      assert.deepEqual(await database.workPlanningRepositories().listNotifications(ownerId), []);

      const note = await notes.capture(ownerId, workspace.workspace.id, { projectId: project.project.id, content: "Rollback" });
      assert.equal(note.status, "created"); if (note.status !== "created") return;
      const discussion = await discussions.create(ownerId, { target: { kind: "note", noteId: note.note.id }, message: "Before" });
      assert.equal(discussion.status, "created"); if (discussion.status !== "created") return;
      await sql.query(`CREATE FUNCTION reject_mention_delivery() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'delivery unavailable'; END $$;
        CREATE TRIGGER reject_mention_delivery BEFORE INSERT ON stash_notifications FOR EACH ROW EXECUTE FUNCTION reject_mention_delivery()`);
      await assert.rejects(discussions.reply(ownerId, discussion.discussion.id, { content: `Fail <@${recipientId}>` }));
      const after = await discussions.get(ownerId, discussion.discussion.id);
      assert.equal(after.status === "found" && after.discussion.messages.length, 1);
      const activity = await sql.query("SELECT 1 FROM stash_workspace_activity WHERE object_id=$1 AND action='discussion_message_mentioned_members'", [discussion.discussion.id]);
      assert.equal(activity.rowCount, 0);
    } finally {
      await database.close().catch(() => undefined); await sql.end();
      await administration.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`).catch(() => undefined); await administration.end();
    }
  });
});
