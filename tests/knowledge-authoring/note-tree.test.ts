import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";

import { createAuthenticationSecretCodec } from "../../src/authentication-secrets.js";
import { EmbeddedInstanceStore } from "../../src/embedded-instance-store.js";
import { EmptyCollectionImpactInspector, NoteTreeService } from "../../src/knowledge-authoring/note-tree.js";
import { NoteService } from "../../src/notes.js";
import { WorkspaceProjectService } from "../../src/workspaces-projects.js";

describe("Note Tree", () => {
  const ownerId = "10101010-1010-4010-8010-101010101010";
  const guestId = "18181818-1818-4818-8818-181818181818";
  const organizationId = "20202020-2020-4020-8020-202020202020";
  let store: EmbeddedInstanceStore;
  let workspaceId: string;
  let service: NoteTreeService;
  let roadmapId = "";
  let researchId = "";
  let questionsId = "";
  let evidenceId = "";
  let launchProjectId = "";
  let strategyProjectId = "";

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
    await store.upgradeDatabase.query("INSERT INTO stash_accounts(id,name,email,password_hash) VALUES($1,'Grace Guest','grace@example.test','test-only')", [guestId]);
    const workspace = await new WorkspaceProjectService(store.database.identityAccessRepositories()).createWorkspace(ownerId, {
      name: "Research",
      owner: { type: "organization", organizationId },
    });
    assert.equal(workspace.status, "created");
    if (workspace.status !== "created") throw new Error("workspace setup failed");
    workspaceId = workspace.workspace.id;
    service = new NoteTreeService(store.database.noteTreeRepository(), new EmptyCollectionImpactInspector());
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

  test("concurrent inverse moves serialize on the Workspace and cannot commit a cycle", async () => {
    const results = await Promise.all([
      service.moveNoteBranch(roadmapId, { parentId: researchId }, ownerId),
      service.moveNoteBranch(researchId, { parentId: roadmapId }, ownerId),
    ]);
    assert.equal(results.filter(({ status }) => status === "moved").length, 1);
    assert.equal(results.filter(({ status }) => status === "cycle").length, 1);
    const tree = await service.list(ownerId, workspaceId);
    assert.equal(tree.status, "found");
    if (tree.status !== "found") return;
    const parentById = new Map(tree.nodes.map(({ id, parentId }) => [id, parentId]));
    for (const start of [roadmapId, researchId]) { const seen = new Set<string>(); let cursor: string | undefined = start;
      while (cursor) { assert.equal(seen.has(cursor), false); seen.add(cursor); cursor = parentById.get(cursor); } }
    if (parentById.get(roadmapId)) assert.equal((await service.moveNoteBranch(roadmapId, {}, ownerId)).status, "moved");
    if (parentById.get(researchId)) assert.equal((await service.moveNoteBranch(researchId, {}, ownerId)).status, "moved");
  });

  test("move previews inherit Project membership while ordinary links change neither containment nor access", async () => {
    const projects = new WorkspaceProjectService(store.database.identityAccessRepositories());
    const project = await projects.createProject(ownerId, workspaceId, { name: "Launch", key: "LAUNCH" });
    const strategy = await projects.createProject(ownerId, workspaceId, { name: "Strategy", key: "STRATEGY" });
    const review = await projects.createProject(ownerId, workspaceId, { name: "Review", key: "REVIEW" });
    assert.equal(project.status, "created"); assert.equal(strategy.status, "created"); assert.equal(review.status, "created");
    if (project.status !== "created" || strategy.status !== "created" || review.status !== "created") return;
    launchProjectId = project.project.id; strategyProjectId = strategy.project.id;
    const organized = await new NoteService(store.database.knowledgeAuthoringRepositories()).triage(ownerId, workspaceId, roadmapId, {
      action: "organize",
      projectId: project.project.id,
    });
    assert.equal(organized.status, "updated");
    assert.equal((await new NoteService(store.database.knowledgeAuthoringRepositories()).triage(ownerId, workspaceId, questionsId, {
      action: "organize", projectId: review.project.id,
    })).status, "updated");

    const preview = await service.preview(ownerId, evidenceId, { action: "move", parentId: roadmapId, beforeId: questionsId });
    assert.equal(preview.status, "found");
    if (preview.status !== "found") return;
    assert.deepEqual(preview.impact.projectAccessChanges, [
      { noteId: evidenceId, noteTitle: "Evidence", projectId: project.project.id, projectName: "Launch", effect: "gained" },
    ]);
    const moved = await service.moveNoteBranch(evidenceId, { parentId: roadmapId, beforeId: questionsId }, ownerId);
    assert.equal(moved.status, "moved");
    if (moved.status !== "moved") return;
    assert.deepEqual(moved.projectAccessChanges, preview.impact.projectAccessChanges);

    const linked = await service.createContextLink(ownerId, researchId, {
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
    assert.equal(evidenceContext.context.state, "active");
    assert.deepEqual(evidenceContext.context.parent, { id: roadmapId, title: "Roadmap" });
    assert.equal(evidenceContext.context.access, "edit");
    assert.equal(evidenceContext.context.accessSource, "workspace");
    assert.equal(evidenceContext.context.revision, 1);
    assert.match(evidenceContext.context.createdAt, /^\d{4}-\d{2}-\d{2}T/);
    assert.equal(evidenceContext.context.historyCount >= 1, true);
    assert.equal((await service.list(ownerId, workspaceId)).status, "found");

    const strategyRoot = await service.create(ownerId, workspaceId, { title: "Strategy home" });
    assert.equal(strategyRoot.status, "created"); if (strategyRoot.status !== "created") return;
    assert.equal((await new NoteService(store.database.knowledgeAuthoringRepositories()).triage(ownerId, workspaceId, strategyRoot.node.id, {
      action: "organize", projectId: strategy.project.id,
    })).status, "updated");
    const inherited = await service.preview(ownerId, roadmapId, { action: "move", parentId: strategyRoot.node.id });
    assert.equal(inherited.status, "found"); if (inherited.status !== "found") return;
    assert.deepEqual(inherited.impact.projectAccessChanges, [
      { noteId: roadmapId, noteTitle: "Roadmap" },
      { noteId: evidenceId, noteTitle: "Evidence" },
      { noteId: questionsId, noteTitle: "Questions" },
    ].map((note) => ({ ...note, projectId: strategy.project.id, projectName: "Strategy", effect: "gained" as const })));
    assert.equal((await service.moveNoteBranch(roadmapId, { parentId: strategyRoot.node.id }, ownerId)).status, "moved");

    await store.upgradeDatabase.query("INSERT INTO stash_project_guests(project_id,account_id) VALUES($1,$2)", [project.project.id, guestId]);
    assert.equal((await service.createContextLink(ownerId, evidenceId, {
      targetNoteId: researchId, label: "Private research",
    })).status, "created");
    const guestContext = await service.context(guestId, evidenceId);
    assert.equal(guestContext.status, "found"); if (guestContext.status !== "found") return;
    assert.deepEqual(guestContext.context.breadcrumbs.map(({ id }) => id), [roadmapId, evidenceId]);
    assert.deepEqual(guestContext.context.outgoingLinks, []);
    assert.deepEqual(guestContext.context.backlinks, []);
    assert.deepEqual(guestContext.context.projectIds, [project.project.id]);
    assert.equal(guestContext.context.access, "read");
    assert.equal(guestContext.context.accessSource, "project");
  });

  test("archive and trash preview and recover the complete branch structure in portable state", async () => {
    const preview = await service.preview(ownerId, roadmapId, { action: "archive" });
    assert.equal(preview.status, "found");
    if (preview.status !== "found") return;
    assert.equal(preview.impact.descendantCount, 2);
    assert.deepEqual(preview.impact.descendants, [
      { noteId: evidenceId, title: "Evidence" },
      { noteId: questionsId, title: "Questions" },
    ]);
    assert.deepEqual(preview.impact.externalLinks, [
      { noteId: researchId, title: "Research", direction: "incoming" },
      { noteId: researchId, title: "Research", direction: "outgoing" },
    ]);
    assert.equal(preview.impact.collectionCount, 0);
    assert.equal(preview.impact.projectAccessChanges.length, 7);
    assert.deepEqual(preview.impact.projectAccessChanges.filter(({ noteId }) => noteId === evidenceId),
      [{ noteId: evidenceId, noteTitle: "Evidence", projectId: launchProjectId, projectName: "Launch", effect: "lost" as const },
        { noteId: evidenceId, noteTitle: "Evidence", projectId: strategyProjectId, projectName: "Strategy", effect: "lost" as const }]
        .sort((left, right) => left.projectId.localeCompare(right.projectId)));

    const archived = await service.remove(ownerId, roadmapId, "archived");
    assert.deepEqual(archived.status, "updated");
    const hiddenAfterArchive = await service.list(ownerId, workspaceId);
    assert.equal(hiddenAfterArchive.status, "found");
    if (hiddenAfterArchive.status !== "found") return;
    assert.equal(hiddenAfterArchive.nodes.some(({ id }) => [roadmapId, evidenceId, questionsId].includes(id)), false);
    const removed = await service.removed(ownerId, workspaceId);
    assert.equal(removed.status, "found");
    if (removed.status === "found") assert.deepEqual(removed.branches.map(({ id, state }) => ({ id, state })), [{ id: roadmapId, state: "archived" }]);
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

    const exported = await store.database.knowledgeAuthoringRepositories().readExportSnapshot(ownerId, workspaceId);
    assert.equal(exported.status, "found");
    if (exported.status !== "found") return;
    const locations = new Map(exported.snapshot.noteLocations.map((location) => [location.noteId, location]));
    assert.equal(locations.get(evidenceId)?.parentId, roadmapId);
    assert.equal(locations.get(questionsId)?.parentId, roadmapId);
    assert.match(locations.get(evidenceId)?.position ?? "", /^\d+$/);
  });

  test("branch impact passes the action through the focused Collection inspector seam", async () => {
    const inspected: Array<{ noteIds: string[]; action: "archive" | "trash" | "move" }> = [];
    const inspectedService = new NoteTreeService(store.database.noteTreeRepository(), { async inspect(_memberId: string,
      noteIds: readonly string[], action: "archive" | "trash" | "move") {
      inspected.push({ noteIds: [...noteIds], action });
      return { collectionCount: 3, collectionRelocationRequired: action === "trash" };
    } });
    for (const action of ["archive", "move", "trash"] as const) {
      const preview = await inspectedService.preview(ownerId, roadmapId, { action });
      assert.equal(preview.status, "found"); if (preview.status !== "found") return;
      assert.equal(preview.impact.collectionCount, 3);
      assert.equal(preview.impact.collectionRelocationRequired, action === "trash");
    }
    assert.deepEqual(inspected, (["archive", "move", "trash"] as const).map((action) => ({
      noteIds: [roadmapId, evidenceId, questionsId], action,
    })));
  });
});
