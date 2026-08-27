import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { createAuthenticationSecretCodec } from "../../src/authentication-secrets.js";
import { EmbeddedInstanceStore } from "../../src/embedded-instance-store.js";
import { CanonicalTaskService } from "../../src/work-planning/canonical-tasks.js";
import { WorkspaceProjectService } from "../../src/workspaces-projects.js";

test("keeps one canonical Workspace Task across optional Projects, keys, Workflow, and Subtasks", async () => {
  const store = await EmbeddedInstanceStore.open(await mkdtemp(join(tmpdir(), "stash-canonical-tasks-")),
    createAuthenticationSecretCodec(randomBytes(32).toString("base64")));
  try {
    const ownerId = "11111111-1111-4111-8111-111111111111";
    await store.database.createFirstOrganizationOwner({ organizationId: "22222222-2222-4222-8222-222222222222",
      organizationName: "Studio", ownerId, ownerName: "Ada", ownerEmail: "ada@example.test", passwordHash: "test", role: "Owner" });
    const workspaces = new WorkspaceProjectService(store.database);
    const workspace = await workspaces.createWorkspace(ownerId, { name: "Notebook", owner: { type: "personal" } });
    assert.equal(workspace.status, "created"); if (workspace.status !== "created") return;
    const alpha = await workspaces.createProject(ownerId, workspace.workspace.id, { name: "Alpha", key: "ALP" });
    const beta = await workspaces.createProject(ownerId, workspace.workspace.id, { name: "Beta", key: "BET" });
    assert.equal(alpha.status, "created"); assert.equal(beta.status, "created");
    if (alpha.status !== "created" || beta.status !== "created") return;

    const tasks = new CanonicalTaskService(store.database.canonicalTaskRepository());
    const created = await tasks.create(ownerId, workspace.workspace.id, { title: "Ship canonical work" });
    assert.equal(created.status, "created"); if (created.status !== "created") return;
    assert.deepEqual(created.task.projectAssociations, []);
    assert.equal(created.task.projectKeys.length, 0);

    const associated = await tasks.associate(ownerId, created.task.id, { projectIds: [alpha.project.id, beta.project.id] });
    assert.equal(associated.status, "updated"); if (associated.status !== "updated") return;
    assert.deepEqual(associated.task.projectKeys.map(({ key }) => key).sort(), ["ALP-1", "BET-1"]);
    assert.equal(associated.task.title, created.task.title);
    const guestId = "12121212-1212-4212-8212-121212121212";
    await store.upgradeDatabase.query("INSERT INTO stash_accounts(id,name,email,password_hash) VALUES($1,'Guest','guest@example.test','test')", [guestId]);
    await store.upgradeDatabase.query("INSERT INTO stash_project_guests(project_id,account_id) VALUES($1,$2)", [alpha.project.id, guestId]);
    const guestList = await tasks.list(guestId, workspace.workspace.id);
    assert.equal(guestList.status, "found"); if (guestList.status !== "found") return;
    assert.deepEqual(guestList.tasks.map(({ id }) => id), [created.task.id]);
    assert.deepEqual(guestList.tasks[0]?.projectKeys, [{ projectId: alpha.project.id, key: "ALP-1" }],
      "Project access reveals the Task without leaking another inaccessible association");

    const statuses = await tasks.workflow(ownerId, workspace.workspace.id);
    assert.equal(statuses.status, "found"); if (statuses.status !== "found") return;
    const started = statuses.workflow.statuses.find(({ category }) => category === "started")!;
    const configured = await tasks.configureWorkflow(ownerId, workspace.workspace.id, { statuses: statuses.workflow.statuses.map((status) =>
      status.id === started.id ? { ...status, name: "Doing" } : status) });
    assert.equal(configured.status, "updated");
    assert.equal(configured.status === "updated" ? configured.workflow.statuses.find(({ id }) => id === started.id)?.name : "", "Doing");
    const moved = await tasks.update(ownerId, created.task.id, { statusId: started.id, title: "Ship one truth" });
    assert.equal(moved.status, "updated"); if (moved.status !== "updated") return;
    assert.equal(moved.task.status.id, started.id);

    const child = await tasks.create(ownerId, workspace.workspace.id, { title: "Independent Subtask", parentTaskId: created.task.id,
      projectIds: [beta.project.id] });
    assert.equal(child.status, "created"); if (child.status !== "created") return;
    assert.deepEqual(child.task.projectAssociations, [beta.project.id]);
    assert.equal((await tasks.setParent(ownerId, created.task.id, { parentTaskId: child.task.id })).status, "cycle");
    assert.equal((await tasks.setProjectParent(ownerId, beta.project.id, { parentProjectId: alpha.project.id })).status, "updated");
    assert.equal((await tasks.setProjectParent(ownerId, alpha.project.id, { parentProjectId: beta.project.id })).status, "cycle");
    const ownerAggregate = await tasks.listProject(ownerId, alpha.project.id);
    assert.equal(ownerAggregate.status, "found");
    assert.deepEqual(ownerAggregate.status === "found" ? ownerAggregate.tasks.map(({ id }) => id).sort() : [], [child.task.id, created.task.id].sort());
    const guestAggregate = await tasks.listProject(guestId, alpha.project.id);
    assert.equal(guestAggregate.status, "found");
    assert.deepEqual(guestAggregate.status === "found" ? guestAggregate.tasks.map(({ id }) => id) : [], [created.task.id],
      "parent aggregation excludes child Project work the guest cannot see");

    const removed = await tasks.associate(ownerId, created.task.id, { projectIds: [beta.project.id] });
    assert.equal(removed.status, "updated"); if (removed.status !== "updated") return;
    assert.deepEqual(removed.task.keyAliases, [{ projectId: alpha.project.id, key: "ALP-1" }]);
    const resolved = await tasks.resolveKey(ownerId, alpha.project.id, "ALP-1");
    assert.equal(resolved.status, "found");
    assert.equal(resolved.status === "found" ? resolved.task.id : "", created.task.id);

    const preview = await tasks.associate(ownerId, created.task.id, { projectIds: [alpha.project.id, beta.project.id] });
    assert.equal(preview.status,"audience_broadening"); if(preview.status!=="audience_broadening")return;
    assert.deepEqual({projectIds:preview.projectIds,memberIds:preview.memberIds},{projectIds:[alpha.project.id],memberIds:[guestId]});
    const restored = await tasks.associate(ownerId, created.task.id, { projectIds: [alpha.project.id, beta.project.id], impactToken: preview.impactToken });
    assert.equal(restored.status, "updated"); if (restored.status !== "updated") return;
    assert.deepEqual(restored.audienceBroadenedProjectIds, [alpha.project.id], "association warns when it broadens the Task audience");
    assert.equal(restored.task.projectKeys.find(({ projectId }) => projectId === alpha.project.id)?.key, "ALP-1");
    assert.deepEqual(restored.task.keyAliases, []);
    assert.equal(restored.task.status.id, started.id, "Project changes never fork canonical Workflow status");
  } finally { await store.close(); }
});
