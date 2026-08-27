import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { describe, it } from "node:test";
import { Pool } from "pg";
import { createAuthenticationSecretCodec } from "../src/authentication-secrets.js";
import { DiscussionService } from "../src/discussions.js";
import { NoteService } from "../src/notes.js";
import { PostgresDatabase } from "../src/postgres-database.js";
import { TaskService } from "../src/tasks.js";
import { WorkspaceProjectService } from "../src/workspaces-projects.js";

const databaseUrl = process.env.STASH_TEST_DATABASE_URL;
describe("PostgreSQL followed Project notifications", { skip: databaseUrl ? false : "STASH_TEST_DATABASE_URL is not configured" }, () => {
  it("delivers canonical Project Note Activity and rechecks recipient membership", async () => {
    const schema = `followed_${randomUUID().replaceAll("-", "")}`; const administration = new Pool({ connectionString: databaseUrl! });
    await administration.query(`CREATE SCHEMA ${schema}`); const separator = databaseUrl!.includes("?") ? "&" : "?";
    const scopedUrl = `${databaseUrl}${separator}options=-csearch_path%3D${schema}`;
    const database = new PostgresDatabase(scopedUrl, createAuthenticationSecretCodec(randomBytes(32).toString("base64")));
    const sql = new Pool({ connectionString: scopedUrl }); const ownerId = "11111111-1111-4111-8111-111111111111";
    const recipientId = "22222222-2222-4222-8222-222222222222"; const organizationId = "33333333-3333-4333-8333-333333333333";
    const followerId = "44444444-4444-4444-8444-444444444444";
    try {
      await database.createFirstOrganizationOwner({ organizationId, organizationName: "Follow Test", ownerId,
        ownerName: "Ada Lovelace", ownerEmail: "ada-follow@example.test", passwordHash: "test-only", role: "Owner" });
      await sql.query(`INSERT INTO stash_accounts(id,name,email,password_hash) VALUES
        ($1,'Grace Hopper','grace-follow@example.test','test-only'),($2,'Katherine Johnson','katherine-follow@example.test','test-only')`, [recipientId, followerId]);
      await sql.query("INSERT INTO stash_organization_memberships(organization_id,account_id,role) VALUES($1,$2,'Member'),($1,$3,'Member')", [organizationId, recipientId, followerId]);
      const workspaces = new WorkspaceProjectService(database.identityAccessRepositories()); const workspace = await workspaces.createWorkspace(ownerId,
        { name: "Follow", owner: { type: "organization", organizationId } }); assert.equal(workspace.status, "created"); if (workspace.status !== "created") return;
      const project = await workspaces.createProject(ownerId, workspace.workspace.id, { name: "Delivery", key: "DEL" }); assert.equal(project.status, "created"); if (project.status !== "created") return;
      assert.equal(await database.workPlanningRepositories().saveProjectFollow!(recipientId, project.project.id, true), true);
      assert.equal(await database.workPlanningRepositories().saveProjectFollow!(followerId, project.project.id, true), true);
      await database.workPlanningRepositories().saveNotificationPreferences(recipientId, project.project.id, { activity: "followed", digest: "off" });
      const created = await new NoteService(database.knowledgeAuthoringRepositories()).capture(ownerId, workspace.workspace.id, { projectId: project.project.id, content: "Canonical change" });
      assert.equal(created.status, "created"); const inbox = await database.workPlanningRepositories().listNotifications(recipientId);
      assert.equal(inbox.length, 1); assert.equal(inbox[0]?.trigger, "followed_change"); assert.equal(inbox[0]?.activity.object.kind, "Note");
      assert.equal(inbox[0]?.activity.actor.localAccountId, ownerId);
      if (created.status === "created") {
        const discussion = await new DiscussionService(database.knowledgeAuthoringRepositories()).create(ownerId, { target: { kind: "note", noteId: created.note.id },
          message: `Review this <@${recipientId}>` }); assert.equal(discussion.status, "created");
        const mentioned = (await database.workPlanningRepositories().listNotifications(recipientId)).filter(({ activity: item }) => item.action === "discussion_message_mentioned_members");
        const follower = (await database.workPlanningRepositories().listNotifications(followerId)).filter(({ activity: item }) => item.action === "discussion_message_mentioned_members");
        assert.deepEqual(mentioned.map(({ trigger }) => trigger), ["direct_mention"], "the mentioned Member receives only the specific trigger");
        assert.deepEqual(follower.map(({ trigger }) => trigger), ["followed_change"], "other Project followers receive the canonical Discussion Activity");
      }
      if (created.status === "created") {
        const blockKey = created.note.document.blocks[0]!.id!; const tasks = new TaskService(database.workPlanningRepositories(), database);
        const task = await tasks.createFromBlock(ownerId, created.note.id, blockKey, { projectId: project.project.id, title: "Assign once" });
        assert.equal(task.status, "created"); if (task.status === "created") {
          await tasks.updateByKey(ownerId, project.project.id, task.task.key, { assigneeIds: [recipientId] });
          const deliveries = await database.workPlanningRepositories().listNotifications(recipientId); const assigned = deliveries.filter(({ activity }) => activity.after.assigneeIds !== undefined);
          assert.equal(assigned.length, 1); assert.equal(assigned[0]?.trigger, "assignment",
            "the specific assignment trigger replaces followed_change for the same Member and Activity");
        }
      }
      await sql.query("DELETE FROM stash_organization_memberships WHERE organization_id=$1 AND account_id=$2", [organizationId, recipientId]);
      assert.deepEqual(await database.workPlanningRepositories().listNotifications(recipientId), [], "revoked Project access hides prior delivery");
    } finally { await database.close().catch(() => undefined); await sql.end();
      await administration.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`).catch(() => undefined); await administration.end(); }
  });
});
