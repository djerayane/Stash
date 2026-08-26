import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";

import { createAuthenticationSecretCodec } from "../../src/authentication-secrets.js";
import { EmbeddedInstanceStore } from "../../src/embedded-instance-store.js";
import { NoteTreeService } from "../../src/knowledge-authoring/note-tree.js";
import { NoteLinkService } from "../../src/note-links.js";
import { NoteService } from "../../src/notes.js";
import { WorkspaceProjectService } from "../../src/workspaces-projects.js";

describe("Note Tree", () => {
  const ownerId = "10101010-1010-4010-8010-101010101010";
  const organizationId = "20202020-2020-4020-8020-202020202020";
  let store: EmbeddedInstanceStore;
  let workspaceId: string;
  let service: NoteTreeService;
  let roadmapId = "";
  let researchId = "";
  let questionsId = "";
  let evidenceId = "";

  before(async () => {
    store = await EmbeddedInstanceStore.open(
      await mkdtemp(join(tmpdir(), "stash-note-tree-")),
      createAuthenticationSecretCodec(randomBytes(32).toString("base64")),
    );
    await store.database.createFirstOrganizationOwner({
      organizationId,
      organizationName: "Field Notes",
      ownerId,
      ownerName: "Ada",
      ownerEmail: "ada@example.test",
      passwordHash: "test-only",
      role: "Owner",
    });
    const workspace = await new WorkspaceProjectService(store.database).createWorkspace(ownerId, {
      name: "Research",
      owner: { type: "organization", organizationId },
    });
    assert.equal(workspace.status, "created");
    if (workspace.status !== "created") throw new Error("workspace setup failed");
    workspaceId = workspace.workspace.id;
    service = new NoteTreeService(store.database.noteTreeRepository());
  });

  after(async () => store.close());

  test("Members create ordered root, child, and sibling Notes", async () => {
    const roadmap = await service.create(ownerId, workspaceId, { title: "Roadmap" });
    assert.equal(roadmap.status, "created");
    if (roadmap.status !== "created") return;
    roadmapId = roadmap.node.id;
    const research = await service.create(ownerId, workspaceId, { title: "Research", beforeId: roadmap.node.id });
    const questions = await service.create(ownerId, workspaceId, { title: "Questions", parentId: roadmap.node.id });
    const evidence = await service.create(ownerId, workspaceId, { title: "Evidence", parentId: roadmap.node.id, beforeId: questions.status === "created" ? questions.node.id : undefined });
    assert.equal(research.status, "created");
    assert.equal(questions.status, "created");
    assert.equal(evidence.status, "created");
    if (research.status !== "created" || questions.status !== "created" || evidence.status !== "created") return;
    researchId = research.node.id;
    questionsId = questions.node.id;
    evidenceId = evidence.node.id;

    const tree = await service.list(ownerId, workspaceId);
    assert.equal(tree.status, "found");
    if (tree.status !== "found") return;
    assert.deepEqual(tree.nodes.map(({ title, parentId, childCount }) => ({ title, parentId, childCount })), [
      { title: "Research", parentId: undefined, childCount: 0 },
      { title: "Roadmap", parentId: undefined, childCount: 2 },
      { title: "Evidence", parentId: roadmap.node.id, childCount: 0 },
      { title: "Questions", parentId: roadmap.node.id, childCount: 0 },
    ]);
  });

  test("branch moves are atomic, reject cycles, and preserve one unambiguous breadcrumb path", async () => {
    assert.deepEqual(await service.moveNoteBranch(roadmapId, { parentId: questionsId }, ownerId), { status: "cycle" });
    const unchanged = await service.list(ownerId, workspaceId);
    assert.equal(unchanged.status, "found");
    if (unchanged.status !== "found") return;
    assert.equal(unchanged.nodes.find(({ id }) => id === roadmapId)?.parentId, undefined);
    assert.equal(unchanged.nodes.find(({ id }) => id === questionsId)?.parentId, roadmapId);

    const moved = await service.moveNoteBranch(evidenceId, { beforeId: researchId }, ownerId);
    assert.deepEqual(moved, { status: "moved", movedIds: [evidenceId], projectAccessChanges: [] });
    const context = await service.context(ownerId, questionsId);
    assert.equal(context.status, "found");
    if (context.status !== "found") return;
    assert.deepEqual(context.context.breadcrumbs, [
      { id: roadmapId, title: "Roadmap" },
      { id: questionsId, title: "Questions" },
    ]);
  });

  test("move previews inherit Project membership while ordinary links change neither containment nor access", async () => {
    const projects = new WorkspaceProjectService(store.database);
    const project = await projects.createProject(ownerId, workspaceId, { name: "Launch", key: "LAUNCH" });
    assert.equal(project.status, "created");
    if (project.status !== "created") return;
    const organized = await new NoteService(store.database).triage(ownerId, workspaceId, roadmapId, {
      action: "organize",
      projectId: project.project.id,
    });
    assert.equal(organized.status, "updated");

    const preview = await service.preview(ownerId, evidenceId, { action: "move", parentId: roadmapId, beforeId: questionsId });
    assert.equal(preview.status, "found");
    if (preview.status !== "found") return;
    assert.deepEqual(preview.impact.projectAccessChanges, [
      { noteId: evidenceId, projectId: project.project.id, effect: "gained" },
    ]);
    const moved = await service.moveNoteBranch(evidenceId, { parentId: roadmapId, beforeId: questionsId }, ownerId);
    assert.equal(moved.status, "moved");
    if (moved.status !== "moved") return;
    assert.deepEqual(moved.projectAccessChanges, preview.impact.projectAccessChanges);

    const linked = await new NoteLinkService(store.database).create(ownerId, researchId, {
      targetNoteId: evidenceId,
      label: "Supporting evidence",
      relationshipType: "supports",
    });
    assert.equal(linked.status, "created");
    const researchContext = await service.context(ownerId, researchId);
    const evidenceContext = await service.context(ownerId, evidenceId);
    assert.equal(researchContext.status, "found");
    assert.equal(evidenceContext.status, "found");
    if (researchContext.status !== "found" || evidenceContext.status !== "found") return;
    assert.equal(researchContext.context.outgoingLinks[0]?.relationshipType, "supports");
    assert.equal(evidenceContext.context.backlinks[0]?.noteId, researchId);
    assert.deepEqual(researchContext.context.projectIds, []);
    assert.deepEqual(evidenceContext.context.projectIds, [project.project.id]);
    assert.equal((await service.list(ownerId, workspaceId)).status, "found");
  });

  test("archive and trash preview and recover the complete branch structure in portable state", async () => {
    const preview = await service.preview(ownerId, roadmapId, { action: "archive" });
    assert.equal(preview.status, "found");
    if (preview.status !== "found") return;
    assert.equal(preview.impact.descendantCount, 2);
    assert.deepEqual(preview.impact.externalLinks, [
      { noteId: researchId, title: "Research", direction: "incoming" },
    ]);
    assert.equal(preview.impact.collectionCount, 0);

    const archived = await service.remove(ownerId, roadmapId, "archived");
    assert.deepEqual(archived.status, "updated");
    const hiddenAfterArchive = await service.list(ownerId, workspaceId);
    assert.equal(hiddenAfterArchive.status, "found");
    if (hiddenAfterArchive.status !== "found") return;
    assert.equal(hiddenAfterArchive.nodes.some(({ id }) => [roadmapId, evidenceId, questionsId].includes(id)), false);
    assert.deepEqual(await service.restore(ownerId, roadmapId), {
      status: "restored",
      restoredIds: [roadmapId, evidenceId, questionsId],
      parentRestored: true,
    });

    assert.equal((await service.remove(ownerId, roadmapId, "trashed")).status, "updated");
    assert.equal((await service.context(ownerId, evidenceId)).status, "note_not_found");
    assert.equal((await service.restore(ownerId, roadmapId)).status, "restored");
    const restored = await service.list(ownerId, workspaceId);
    assert.equal(restored.status, "found");
    if (restored.status !== "found") return;
    assert.equal(restored.nodes.find(({ id }) => id === evidenceId)?.parentId, roadmapId);
    assert.equal(restored.nodes.find(({ id }) => id === questionsId)?.parentId, roadmapId);

    const exported = await store.database.readExportSnapshot(ownerId, workspaceId);
    assert.equal(exported.status, "found");
    if (exported.status !== "found") return;
    const locations = new Map(exported.snapshot.noteLocations.map((location) => [location.noteId, location]));
    assert.equal(locations.get(evidenceId)?.parentId, roadmapId);
    assert.equal(locations.get(questionsId)?.parentId, roadmapId);
    assert.match(locations.get(evidenceId)?.position ?? "", /^\d+$/);
  });
});
