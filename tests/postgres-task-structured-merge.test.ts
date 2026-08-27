import assert from "node:assert/strict";
import { after, describe, it } from "node:test";
import { randomBytes, randomUUID } from "node:crypto";
import { Pool } from "pg";

import { createAuthenticationSecretCodec } from "../src/authentication-secrets.js";
import { startInstance, type RunningInstance } from "./support/start-test-instance.js";
import { NoteService } from "../src/notes.js";
import { OwnerBootstrapService } from "../src/owner-bootstrap.js";
import { PostgresDatabase } from "../src/postgres-database.js";
import { ProjectWorkflowService } from "../src/project-workflows.js";
import { TaskService } from "../src/tasks.js";
import { WorkspaceProjectService } from "../src/workspaces-projects.js";
import { BoardService } from "../src/boards.js";

const databaseUrl = process.env.STASH_TEST_DATABASE_URL;

describe("PostgreSQL structured Task collaboration", { skip: !databaseUrl }, () => {
  let database: PostgresDatabase; let instance: RunningInstance; let admin: Pool; let schema: string; let testDatabaseUrl: string;
  after(async () => { if (instance) await instance.close(); else await database?.close();
    if (admin) { await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`); await admin.end(); } });

  it("persists merged fields, retry receipts, conflicts, attribution, and resolution through the running Instance", async () => {
    admin = new Pool({ connectionString: databaseUrl! }); schema = `task_merge_${randomUUID().replaceAll("-", "")}`;
    await admin.query(`CREATE SCHEMA ${schema}`); const scopedUrl = new URL(databaseUrl!); scopedUrl.searchParams.set("options", `-csearch_path=${schema}`);
    testDatabaseUrl = scopedUrl.toString();
    database = new PostgresDatabase(testDatabaseUrl, createAuthenticationSecretCodec(randomBytes(32).toString("base64")));
    const owner = await new OwnerBootstrapService(database).bootstrap({ organizationName: "Merge Test", ownerName: "Ada Lovelace",
      ownerEmail: `ada-${randomUUID()}@example.test`, password: "test-password-long-enough" }); assert.ok(owner);
    const workspaces = new WorkspaceProjectService(database);
    const workspace = await workspaces.createWorkspace(owner.ownerId, { name: "Portable", owner: { type: "organization", organizationId: owner.organizationId } }); assert.equal(workspace.status, "created");
    if (workspace.status !== "created") return;
    const project = await workspaces.createProject(owner.ownerId, workspace.workspace.id, { name: "Stash", key: "STASH" }); assert.equal(project.status, "created");
    if (project.status !== "created") return;
    const destination = await workspaces.createProject(owner.ownerId, workspace.workspace.id, { name: "Delivery", key: "SHIP" }); assert.equal(destination.status, "created");
    if (destination.status !== "created") return;
    const note = await new NoteService(database.knowledgeAuthoringRepositories()).capture(owner.ownerId, workspace.workspace.id, { content: "Plan release" }); assert.equal(note.status, "created");
    if (note.status !== "created") return;
    const tasks = new TaskService(database.workPlanningRepositories(), database); const blockKey = note.note.document.blocks[0]!.blockKey!;
    const created = await tasks.createFromBlock(owner.ownerId, note.note.id, blockKey, { projectId: project.project.id, title: "Plan release" });
    assert.equal(created.status, "created"); if (created.status !== "created") return;
    const otherNote = await new NoteService(database.knowledgeAuthoringRepositories()).capture(owner.ownerId, workspace.workspace.id, { content: "Publish release" }); assert.equal(otherNote.status, "created");
    if (otherNote.status !== "created") return;
    const other = await tasks.createFromBlock(owner.ownerId, otherNote.note.id, otherNote.note.document.blocks[0]!.blockKey!, { projectId: project.project.id, title: "Publish release" });
    assert.equal(other.status, "created"); if (other.status !== "created") return;
    const createTask = async (title: string) => { const captured = await new NoteService(database.knowledgeAuthoringRepositories()).capture(owner.ownerId, workspace.workspace.id, { content: title });
      assert.equal(captured.status, "created"); if (captured.status !== "created") throw new Error("capture failed");
      const task = await tasks.createFromBlock(owner.ownerId, captured.note.id, captured.note.document.blocks[0]!.blockKey!, { projectId: project.project.id, title });
      assert.equal(task.status, "created"); if (task.status !== "created") throw new Error("task creation failed"); return task.task; };
    const differentTask = await createTask("Concurrent different fields"); const sameTask = await createTask("Concurrent same field");
    const retryTask = await createTask("Concurrent retry"); const workflowTask = await createTask("Workflow revision");
    const workflowOverlapTask = await createTask("Workflow overlap");
    const boardOverlapTask = await createTask("Board overlap");
    const reassignedTask = await createTask("Reassign departed Member");
    const conflictReassignedTask = await createTask("Resolve departed Member assignment conflict");
    const workflowService = new ProjectWorkflowService(database.workPlanningRepositories()); const workflowResult = await workflowService.find(owner.ownerId, project.project.id);
    assert.equal(workflowResult.status, "found"); if (workflowResult.status !== "found") return;
    const archivedStatus = workflowResult.workflow.statuses.find(({ name }) => name === "Ready")!;
    const archived = await workflowService.replace(owner.ownerId, project.project.id, { expectedRevision: workflowResult.workflow.revision,
      statuses: workflowResult.workflow.statuses.map(({ id, name, category, archived }) => ({ id, name, category,
        archived: id === archivedStatus.id ? true : archived })) }); assert.equal(archived.status, "updated");
    const setup = new Pool({ connectionString: testDatabaseUrl });
    await setup.query(`DROP TRIGGER IF EXISTS stash_test_delay_task_receipt ON stash_task_edit_operations;
      DROP FUNCTION IF EXISTS stash_test_delay_task_receipt();
      CREATE FUNCTION stash_test_delay_task_receipt() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN PERFORM pg_sleep(0.08); RETURN NEW; END $$;
      CREATE TRIGGER stash_test_delay_task_receipt BEFORE INSERT ON stash_task_edit_operations
      FOR EACH ROW EXECUTE FUNCTION stash_test_delay_task_receipt()`); await setup.end();
    const boardService = new BoardService(database.workPlanningRepositories());
    const boardResult = await boardService.create(owner.ownerId, project.project.id, { name: "Delivery", groupBy: "status" });
    assert.equal(boardResult.status, "created"); if (boardResult.status !== "created") return;
    instance = await startInstance({ database, host: "127.0.0.1", port: 0, instanceAdminToken: "admin", tasks, boards: boardService,
      memberAccess: { async authenticateBearer(value) { return value === "Bearer test" ? { accountId: owner.ownerId, sessionId: "test" } : undefined; } } });
    const base = `${instance.url}/api/projects/${project.project.id}/tasks/${created.task.key}`;
    const taskBase = (key: string, selectedProjectId = project.project.id) => `${instance.url}/api/projects/${selectedProjectId}/tasks/${key}`;
    const concurrentEdit = (key: string, operationId: string, changes: unknown, revision = 1) => fetch(`${taskBase(key)}/edits`, { method: "POST",
      headers: { authorization: "Bearer test", "content-type": "application/json" }, body: JSON.stringify({ operationId, baseRevision: revision, changes }) });
    const departedAssignments = new Pool({ connectionString: testDatabaseUrl });
    const replacementId = randomUUID();
    await departedAssignments.query(`INSERT INTO stash_accounts(id,name,email,password_hash) VALUES($1,'Grace Hopper',$2,'test-hash');
      INSERT INTO stash_organization_memberships(organization_id,account_id,role) VALUES($3,$1,'Member')`,
    [replacementId, `grace-${randomUUID()}@example.test`, owner.organizationId]);
    await departedAssignments.query(`UPDATE stash_tasks SET assignee_ids=$2::jsonb, former_assignee_ids=$2::jsonb
      WHERE id=ANY($1::uuid[])`, [[reassignedTask.id, conflictReassignedTask.id], JSON.stringify([owner.ownerId])]);
    await departedAssignments.end();
    const reassigned = await fetch(taskBase(reassignedTask.key), { method: "PATCH",
      headers: { authorization: "Bearer test", "content-type": "application/json" }, body: JSON.stringify({ assigneeIds: [] }) });
    assert.equal(reassigned.status, 200);
    assert.deepEqual((await reassigned.json() as any).task.formerAssigneeIds, [owner.ownerId]);
    const replacement = await fetch(taskBase(reassignedTask.key), { method: "PATCH",
      headers: { authorization: "Bearer test", "content-type": "application/json" }, body: JSON.stringify({ assigneeIds: [replacementId] }) });
    assert.equal(replacement.status, 200);
    assert.equal("formerAssigneeIds" in ((await replacement.json() as any).task), false);
    assert.equal((await concurrentEdit(conflictReassignedTask.key, randomUUID(), { assigneeIds: [owner.ownerId] })).status, 200);
    const departedConflictResponse = await concurrentEdit(conflictReassignedTask.key, randomUUID(), { assigneeIds: [] });
    assert.equal(departedConflictResponse.status, 409);
    const departedConflict = (await departedConflictResponse.json() as any).conflict;
    const departedResolution = await fetch(`${taskBase(conflictReassignedTask.key)}/conflicts/${departedConflict.id}`, { method: "PUT",
      headers: { authorization: "Bearer test", "content-type": "application/json" },
      body: JSON.stringify({ resolution: "apply_contribution", expectedRevision: 2 }) });
    assert.equal(departedResolution.status, 200);
    assert.deepEqual((await departedResolution.json() as any).task.formerAssigneeIds, [owner.ownerId]);
    assert.equal((await concurrentEdit(conflictReassignedTask.key, randomUUID(), { assigneeIds: [replacementId] }, 3)).status, 200);
    const conflictReplacement = await (await fetch(taskBase(conflictReassignedTask.key), { headers: { authorization: "Bearer test" } })).json() as any;
    assert.equal("formerAssigneeIds" in conflictReplacement.task, false);
    const activeInProgress = workflowResult.workflow.statuses.find(({ name }) => name === "In Progress")!;
    const boardMove = await fetch(`${instance.url}/api/projects/${project.project.id}/boards/${boardResult.board.id}/tasks/${boardOverlapTask.key}`, {
      method: "PATCH", headers: { authorization: "Bearer test", "content-type": "application/json" }, body: JSON.stringify({ statusId: activeInProgress.id }) });
    assert.equal(boardMove.status, 200);
    const boardStale = await concurrentEdit(boardOverlapTask.key, randomUUID(), { statusId: workflowResult.workflow.statuses[0]!.id }, 1);
    assert.equal(boardStale.status, 409); assert.deepEqual((await boardStale.json() as any).conflict.fields, ["statusId"]);
    const boardRead = await (await fetch(taskBase(boardOverlapTask.key), { headers: { authorization: "Bearer test" } })).json() as any;
    assert.equal(boardRead.task.revision, 2); assert.equal(boardRead.task.status.id, activeInProgress.id);
    const future = await concurrentEdit(created.task.key, randomUUID(), { title: "Must not overwrite" }, Number.MAX_SAFE_INTEGER);
    assert.equal(future.status, 409); assert.equal((await future.json() as any).error, "invalid_revision");
    const archivedEdit = await concurrentEdit(created.task.key, randomUUID(), { statusId: archivedStatus.id });
    assert.equal(archivedEdit.status, 409); assert.equal((await archivedEdit.json() as any).error, "task_edit_conflict");
    const unknownStatus = await concurrentEdit(created.task.key, randomUUID(), { statusId: randomUUID() });
    assert.equal(unknownStatus.status, 422); assert.equal((await unknownStatus.json() as any).error, "invalid_reference");
    const different = await Promise.all([concurrentEdit(differentTask.key, randomUUID(), { title: "Changed concurrently" }),
      concurrentEdit(differentTask.key, randomUUID(), { priority: "high" })]); assert.deepEqual(different.map(({ status }) => status).sort(), [200, 200]);
    const differentRead = await (await fetch(taskBase(differentTask.key), { headers: { authorization: "Bearer test" } })).json() as any;
    assert.equal(differentRead.task.title, "Changed concurrently"); assert.equal(differentRead.task.priority, "high");
    const same = await Promise.all([concurrentEdit(sameTask.key, randomUUID(), { title: "Contribution A" }),
      concurrentEdit(sameTask.key, randomUUID(), { title: "Contribution B" })]); assert.deepEqual(same.map(({ status }) => status).sort(), [200, 409]);
    const sameConflict = await same.find(({ status }) => status === 409)!.json() as any; assert.equal(sameConflict.conflict.createdBy.displayName, "Ada Lovelace");
    const patchAndResolve = await Promise.all([fetch(taskBase(sameTask.key), { method: "PATCH", headers: { authorization: "Bearer test", "content-type": "application/json" },
      body: JSON.stringify({ priority: "low" }) }), fetch(`${taskBase(sameTask.key)}/conflicts/${sameConflict.conflict.id}`, { method: "PUT",
      headers: { authorization: "Bearer test", "content-type": "application/json" }, body: JSON.stringify({ resolution: "apply_contribution", expectedRevision: 2 }) })]);
    assert.equal(patchAndResolve[0].status, 200); assert.ok([200, 409].includes(patchAndResolve[1].status));
    const retryId = randomUUID(); const duplicate = await Promise.all([concurrentEdit(retryTask.key, retryId, { priority: "urgent" }),
      concurrentEdit(retryTask.key, retryId, { priority: "urgent" })]); assert.deepEqual(duplicate.map(({ status }) => status), [200, 200]);
    assert.deepEqual((await Promise.all(duplicate.map((response) => response.json() as Promise<any>))).map(({ revision }) => revision), [2, 2]);
    const patchAndEdit = await Promise.all([fetch(taskBase(retryTask.key), { method: "PATCH", headers: { authorization: "Bearer test", "content-type": "application/json" },
      body: JSON.stringify({ labelNames: ["parallel"] }) }), concurrentEdit(retryTask.key, randomUUID(), { title: "Parallel PATCH" }, 1)]);
    assert.deepEqual(patchAndEdit.map(({ status }) => status), [200, 200]);
    const overlapped = await (await fetch(taskBase(retryTask.key), { headers: { authorization: "Bearer test" } })).json() as any;
    assert.equal(overlapped.task.title, "Parallel PATCH"); assert.deepEqual(overlapped.task.labelNames, ["parallel"]);
    const graphAndMove = await Promise.all([fetch(taskBase(differentTask.key), { method: "PATCH", headers: { authorization: "Bearer test", "content-type": "application/json" },
      body: JSON.stringify({ dependencies: [{ taskId: sameTask.id, type: "depends_on" }] }) }),
    fetch(`${taskBase(sameTask.key)}/move`, { method: "POST", headers: { authorization: "Bearer test", "content-type": "application/json" },
      body: JSON.stringify({ destinationProjectId: destination.project.id }) })]);
    assert.deepEqual(graphAndMove.map(({ status }) => status), [200, 200]);
    const edit = (operationId: string, changes: unknown) => fetch(`${base}/edits`, { method: "POST", headers: { authorization: "Bearer test", "content-type": "application/json" },
      body: JSON.stringify({ operationId, baseRevision: 1, changes }) });
    const firstId = randomUUID(); const secondId = randomUUID();
    assert.equal((await edit(firstId, { title: "Published" })).status, 200);
    const merged = await edit(secondId, { priority: "urgent" }); assert.equal(merged.status, 200);
    const retry = await edit(secondId, { priority: "urgent" }); assert.equal(retry.status, 200); assert.equal((await retry.json() as any).revision, 3);
    const patched = await fetch(base, { method: "PATCH", headers: { authorization: "Bearer test", "content-type": "application/json" }, body: JSON.stringify({ priority: "low" }) });
    assert.equal(patched.status, 200);
    const collision = await fetch(`${base}/edits`, { method: "POST", headers: { authorization: "Bearer test", "content-type": "application/json" },
      body: JSON.stringify({ operationId: randomUUID(), baseRevision: 3, changes: { priority: "high" } }) }); assert.equal(collision.status, 409);
    const conflict = (await collision.json() as any).conflict; assert.equal(conflict.createdBy.displayName, "Ada Lovelace"); assert.equal(conflict.createdBy.localAccountId, undefined);
    assert.equal(conflict.currentRevision, 4);
    const probe = new Pool({ connectionString: testDatabaseUrl }); await probe.query("UPDATE stash_accounts SET name='Ada Changed' WHERE id=$1", [owner.ownerId]); await probe.end();
    const listed = await fetch(`${base}/conflicts`, { headers: { authorization: "Bearer test" } });
    assert.equal(((await listed.json() as any).conflicts[0]).createdBy.displayName, "Ada Lovelace");
    assert.equal((await fetch(base, { method: "PATCH", headers: { authorization: "Bearer test", "content-type": "application/json" }, body: JSON.stringify({ labelNames: ["release"] }) })).status, 200);
    const staleResolution = await fetch(`${base}/conflicts/${conflict.id}`, { method: "PUT", headers: { authorization: "Bearer test", "content-type": "application/json" },
      body: JSON.stringify({ resolution: "apply_contribution", expectedRevision: 4 }) }); assert.equal(staleResolution.status, 409);
    const resolution = await fetch(`${base}/conflicts/${conflict.id}`, { method: "PUT", headers: { authorization: "Bearer test", "content-type": "application/json" },
      body: JSON.stringify({ resolution: "apply_contribution", expectedRevision: 5 }) });
    assert.equal(resolution.status, 200); const resolved = await resolution.json() as any;
    assert.equal(resolved.task.title, "Published"); assert.equal(resolved.task.priority, "high"); assert.deepEqual(resolved.task.labelNames, ["release"]); assert.equal(resolved.activity.actor.displayName, "Ada Changed");
    assert.equal((await fetch(base, { method: "PATCH", headers: { authorization: "Bearer test", "content-type": "application/json" },
      body: JSON.stringify({ dependencies: [{ taskId: other.task.id, type: "depends_on" }] }) })).status, 200);
    const inverse = await fetch(`${instance.url}/api/projects/${project.project.id}/tasks/${other.task.key}/edits`, { method: "POST",
      headers: { authorization: "Bearer test", "content-type": "application/json" },
      body: JSON.stringify({ operationId: randomUUID(), baseRevision: 1, changes: { dependencies: [] } }) });
    assert.equal(inverse.status, 409); assert.deepEqual((await inverse.json() as any).conflict.fields, ["dependencies"]);
    const moved = await fetch(`${base}/move`, { method: "POST", headers: { authorization: "Bearer test", "content-type": "application/json" },
      body: JSON.stringify({ destinationProjectId: destination.project.id }) }); assert.equal(moved.status, 200); const movedTask = (await moved.json() as any).task;
    const staleStatus = await fetch(`${instance.url}/api/projects/${destination.project.id}/tasks/${movedTask.key}/edits`, { method: "POST",
      headers: { authorization: "Bearer test", "content-type": "application/json" },
      body: JSON.stringify({ operationId: randomUUID(), baseRevision: 7, changes: { statusId: movedTask.status.id } }) });
    assert.equal(staleStatus.status, 409); assert.deepEqual((await staleStatus.json() as any).conflict.fields, ["statusId"]);

    const beforeRename = await workflowService.find(owner.ownerId, project.project.id); assert.equal(beforeRename.status, "found"); if (beforeRename.status !== "found") return;
    const backlog = beforeRename.workflow.statuses.find(({ name }) => name === "Backlog")!;
    const renamed = await workflowService.replace(owner.ownerId, project.project.id, { expectedRevision: beforeRename.workflow.revision,
      statuses: beforeRename.workflow.statuses.map(({ id, name, category, archived }) => ({ id, name: id === backlog.id ? "Ideas" : name, category, archived })) });
    assert.equal(renamed.status, "updated");
    const workflowStale = await concurrentEdit(workflowTask.key, randomUUID(), { statusId: backlog.id }, 1);
    assert.equal(workflowStale.status, 409); assert.deepEqual((await workflowStale.json() as any).conflict.fields, ["statusId"]);
    const freshTask = await (await fetch(taskBase(workflowTask.key), { headers: { authorization: "Bearer test" } })).json() as any;
    assert.equal(freshTask.task.revision, 2);
    assert.equal((await concurrentEdit(workflowTask.key, randomUUID(), { title: "Uses GET revision" }, freshTask.task.revision)).status, 200);

    const overlapWorkflow = await workflowService.find(owner.ownerId, project.project.id); assert.equal(overlapWorkflow.status, "found"); if (overlapWorkflow.status !== "found") return;
    const inProgress = overlapWorkflow.workflow.statuses.find(({ name }) => name === "In Progress")!;
    const overlapRevision = ((await (await fetch(taskBase(workflowOverlapTask.key), { headers: { authorization: "Bearer test" } })).json() as any).task.revision);
    const blockerPool = new Pool({ connectionString: testDatabaseUrl }); const blocker = await blockerPool.connect();
    const overlapOperationId = randomUUID(); let workflowOutcome: Awaited<ReturnType<typeof workflowService.replace>>; let editOutcome: Response;
    try {
      await blocker.query("BEGIN"); await blocker.query("SELECT id FROM stash_projects WHERE id=$1 FOR UPDATE", [project.project.id]);
      const archivePromise = workflowService.replace(owner.ownerId, project.project.id, { expectedRevision: overlapWorkflow.workflow.revision,
        statuses: overlapWorkflow.workflow.statuses.map(({ id, name, category, archived }) => ({ id, name, category, archived: id === inProgress.id ? true : archived })) });
      await new Promise((resolve) => setTimeout(resolve, 30));
      const editPromise = concurrentEdit(workflowOverlapTask.key, overlapOperationId, { statusId: inProgress.id }, overlapRevision);
      await new Promise((resolve) => setTimeout(resolve, 30)); await blocker.query("COMMIT");
      [workflowOutcome, editOutcome] = await Promise.all([archivePromise, editPromise]);
    } finally { await blocker.query("ROLLBACK").catch(() => undefined); blocker.release(); await blockerPool.end(); }
    assert.equal(workflowOutcome.status, "updated"); assert.equal(editOutcome.status, 409); const overlapConflict = (await editOutcome.json() as any).conflict;
    const overlapRetry = await concurrentEdit(workflowOverlapTask.key, overlapOperationId, { statusId: inProgress.id }, overlapRevision);
    assert.equal(overlapRetry.status, 409); assert.equal((await overlapRetry.json() as any).conflict.id, overlapConflict.id);
    const overlapConflicts = await fetch(`${taskBase(workflowOverlapTask.key)}/conflicts`, { headers: { authorization: "Bearer test" } });
    assert.ok(((await overlapConflicts.json() as any).conflicts as any[]).some(({ id }) => id === overlapConflict.id));
    const dismissed = await fetch(`${taskBase(workflowOverlapTask.key)}/conflicts/${overlapConflict.id}`, { method: "PUT",
      headers: { authorization: "Bearer test", "content-type": "application/json" }, body: JSON.stringify({ resolution: "keep_current", expectedRevision: overlapRevision }) });
    assert.equal(dismissed.status, 200);

    const departureTask = await createTask("Record departed assignment Activity");
    assert.equal((await fetch(taskBase(departureTask.key), { method: "PATCH",
      headers: { authorization: "Bearer test", "content-type": "application/json" },
      body: JSON.stringify({ assigneeIds: [replacementId] }) })).status, 200);
    const departure = await database.removeOrganizationMember(owner.organizationId, owner.ownerId, replacementId);
    assert.equal(typeof departure, "object");
    const activityProbe = new Pool({ connectionString: testDatabaseUrl });
    const activity = await activityProbe.query<{ actor_account_id: string; cause: string; before_state: any; after_state: any }>(
      `SELECT actor_account_id,cause,before_state,after_state FROM stash_workspace_activity
       WHERE object_id=$1 AND action='task_departed_assignee_marked'`, [departureTask.id]);
    await activityProbe.end();
    assert.equal(activity.rowCount, 1);
    assert.equal(activity.rows[0]!.actor_account_id, owner.ownerId);
    assert.match(activity.rows[0]!.cause, /member/);
    assert.deepEqual(activity.rows[0]!.before_state.formerAssigneeIds ?? [], []);
    assert.deepEqual(activity.rows[0]!.after_state.formerAssigneeIds, [replacementId]);
  });
});
