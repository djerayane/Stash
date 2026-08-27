import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";

import { createAuthenticationSecretCodec } from "../../src/authentication-secrets.js";
import { EmbeddedInstanceStore } from "../../src/embedded-instance-store.js";
import {
  InvalidRelationshipQuery,
  RelationshipQueryService,
  type RelationshipQueryRepository,
} from "../../src/knowledge-authoring/relationship-query.js";
import { EmptyCollectionImpactInspector, NoteTreeService } from "../../src/knowledge-authoring/note-tree.js";
import { VisualizationBlockService } from "../../src/knowledge-authoring/visualization-block.js";
import { NoteLinkService } from "../../src/note-links.js";
import { NoteService } from "../../src/notes.js";
import { WorkspaceProjectService } from "../../src/workspaces-projects.js";
import { normalizeVisualizationDefinition } from "../../packages/domain-types/src/visualizations.js";

const rootId = "11111111-1111-4111-8111-111111111111";

describe("relationship query contracts", () => {
  test("normalizes a bounded focused query before it reaches persistence", async () => {
    const received: unknown[] = [];
    const repository: RelationshipQueryRepository = {
      async query(_memberId, query) {
        received.push(query);
        return { status: "found", neighborhood: { rootId, depth: query.depth, limit: query.limit,
          direction: query.direction, nodes: [], edges: [], outline: [], hasMore: false } };
      },
      async maintenance() { return { status: "found", orphans: [], brokenLinks: [] }; },
    };
    const service = new RelationshipQueryService(repository);

    await service.query("member", rootId, { depth: 2, limit: 24, direction: "incoming",
      relationTypes: ["supports", "supports", "untyped"], includeHierarchy: false });

    assert.deepEqual(received, [{ rootId, depth: 2, limit: 24, direction: "incoming",
      relationTypes: ["supports", "untyped"], includeHierarchy: false }]);
    await assert.rejects(() => service.query("member", rootId, { depth: 4 }), InvalidRelationshipQuery);
    await assert.rejects(() => service.query("member", rootId, { limit: 101 }), InvalidRelationshipQuery);
  });

  test("normalizes portable Visualization Block state without inventing canonical edges", () => {
    const definition = normalizeVisualizationDefinition({
      schema: "stash.visualization.v1",
      id: "22222222-2222-4222-8222-222222222222",
      kind: "local-graph",
      query: { rootId, depth: 2, limit: 40, direction: "both", relationTypes: ["supports"], includeHierarchy: true },
      filters: { relationTypes: ["supports"], direction: "both" },
      layout: { renderer: "focused", positions: { [rootId]: { x: 20, y: 30 } } },
      viewEdges: [{ id: "edge-local", sourceNoteId: rootId,
        targetNoteId: "33333333-3333-4333-8333-333333333333", relationshipType: "questions" }],
    });

    assert.deepEqual(definition.viewEdges, [{ id: "edge-local", sourceNoteId: rootId,
      targetNoteId: "33333333-3333-4333-8333-333333333333", relationshipType: "questions" }]);
    assert.equal(definition.kind, "local-graph");
    assert.throws(() => normalizeVisualizationDefinition({ ...definition, kind: "third-party-script" }));
    assert.throws(() => normalizeVisualizationDefinition({ ...definition, layout: { renderer: () => "untrusted" } }));
    assert.throws(() => normalizeVisualizationDefinition({ ...definition,
      viewEdges: [definition.viewEdges[0], definition.viewEdges[0]] }));
  });

  test("filters identities, edges, unresolved targets, and pagination metadata before returning a neighborhood", async () => {
    const store = await EmbeddedInstanceStore.open(await mkdtemp(join(tmpdir(), "stash-relationships-")),
      createAuthenticationSecretCodec(randomBytes(32).toString("base64")));
    try {
      const ownerId = "44444444-4444-4444-8444-444444444444";
      const guestId = "55555555-5555-4555-8555-555555555555";
      const organizationId = "66666666-6666-4666-8666-666666666666";
      await store.database.createFirstOrganizationOwner({ organizationId, organizationName: "Studio", ownerId,
        ownerName: "Ada", ownerEmail: "ada@example.test", passwordHash: "test-only", role: "Owner" });
      await store.upgradeDatabase.query("INSERT INTO stash_accounts(id,name,email,password_hash) VALUES($1,'Guest','guest@example.test','test-only')", [guestId]);
      const workspaces = new WorkspaceProjectService(store.database);
      const createdWorkspace = await workspaces.createWorkspace(ownerId, { name: "Notebook", owner: { type: "organization", organizationId } });
      assert.equal(createdWorkspace.status, "created");
      if (createdWorkspace.status !== "created") return;
      const workspaceId = createdWorkspace.workspace.id;
      const project = await workspaces.createProject(ownerId, workspaceId, { name: "Shared", key: "SHARED" });
      assert.equal(project.status, "created");
      if (project.status !== "created") return;

      const notes = new NoteTreeService(store.database.noteTreeRepository(), new EmptyCollectionImpactInspector());
      const visibleRoot = await notes.create(ownerId, workspaceId, { title: "Visible root" });
      assert.equal(visibleRoot.status, "created"); if (visibleRoot.status !== "created") return;
      const visibleChild = await notes.create(ownerId, workspaceId, { title: "Visible child", parentId: visibleRoot.node.id });
      const privateNote = await notes.create(ownerId, workspaceId, { title: "Private strategy" });
      const orphan = await notes.create(ownerId, workspaceId, { title: "Unlinked note" });
      const visibleIsolated = await notes.create(ownerId, workspaceId, { title: "Visible isolated" });
      assert.equal(visibleChild.status, "created"); assert.equal(privateNote.status, "created"); assert.equal(orphan.status, "created");
      assert.equal(visibleIsolated.status, "created");
      if (visibleChild.status !== "created" || privateNote.status !== "created" || orphan.status !== "created" || visibleIsolated.status !== "created") return;
      assert.equal((await new NoteService(store.database).triage(ownerId, workspaceId, visibleRoot.node.id,
        { action: "organize", projectId: project.project.id })).status, "updated");
      assert.equal((await new NoteService(store.database).triage(ownerId, workspaceId, visibleIsolated.node.id,
        { action: "organize", projectId: project.project.id })).status, "updated");
      await store.upgradeDatabase.query("INSERT INTO stash_project_guests(project_id,account_id) VALUES($1,$2)", [project.project.id, guestId]);
      assert.equal((await notes.createContextLink(ownerId, visibleRoot.node.id,
        { targetNoteId: visibleChild.node.id, label: "Supports", relationshipType: "supports" })).status, "created");
      assert.equal((await notes.createContextLink(ownerId, visibleChild.node.id,
        { targetNoteId: privateNote.node.id, label: "Secret contradiction", relationshipType: "contradicts" })).status, "created");
      assert.equal((await notes.createContextLink(ownerId, visibleIsolated.node.id,
        { targetNoteId: privateNote.node.id, label: "Hidden relation", relationshipType: "supports" })).status, "created");
      const unresolved = await new NoteLinkService(store.database).importUnresolved(ownerId, visibleRoot.node.id,
        { targetPath: "notes/missing.md", candidateNoteIds: [privateNote.node.id], label: "Hidden lead" });
      assert.equal(unresolved.status, "created");

      const service = new RelationshipQueryService(store.database.relationshipQueryRepository());
      const guestResult = await service.query(guestId, visibleRoot.node.id,
        { depth: 3, limit: 2, direction: "both", includeHierarchy: true });
      assert.equal(guestResult.status, "found");
      if (guestResult.status !== "found") return;
      assert.deepEqual(guestResult.neighborhood.nodes.map(({ title }) => title), ["Visible root", "Visible child"]);
      assert.equal(guestResult.neighborhood.edges.some((edge) => edge.relationshipType === "contradicts"), false);
      assert.equal(guestResult.neighborhood.hasMore, false, "forbidden nodes must not influence pagination metadata");
      assert.equal(JSON.stringify(guestResult).includes("Private strategy"), false);
      assert.equal(JSON.stringify(guestResult).includes("Hidden lead"), false);
      assert.equal(JSON.stringify(guestResult).includes("notes/missing.md"), false);

      const ownerResult = await service.query(ownerId, visibleRoot.node.id,
        { depth: 1, limit: 20, direction: "outgoing", relationTypes: ["supports"], includeHierarchy: false });
      assert.equal(ownerResult.status, "found");
      if (ownerResult.status === "found") {
        assert.deepEqual(ownerResult.neighborhood.nodes.map(({ title }) => title), ["Visible root", "Visible child"]);
        assert.deepEqual(ownerResult.neighborhood.edges.map(({ relationshipType }) => relationshipType), ["supports"]);
      }

      const guestMaintenance = await service.maintenance(guestId, workspaceId);
      assert.equal(guestMaintenance.status, "found");
      if (guestMaintenance.status === "found") {
        assert.deepEqual(guestMaintenance.brokenLinks, []);
        assert.equal(guestMaintenance.orphans.some(({ id }) => id === visibleIsolated.node.id), true,
          "a forbidden target must not influence derived orphan metadata");
      }
      const ownerMaintenance = await service.maintenance(ownerId, workspaceId);
      assert.equal(ownerMaintenance.status, "found");
      if (ownerMaintenance.status === "found") {
        assert.equal(ownerMaintenance.orphans.some(({ id }) => id === orphan.node.id), true);
        assert.deepEqual(ownerMaintenance.brokenLinks.map(({ label, targetPath, candidates }) => ({ label, targetPath,
          candidates: candidates.map(({ title }) => title) })), [{ label: "Hidden lead", targetPath: "notes/missing.md", candidates: ["Private strategy"] }]);
      }

      const blockId = "77777777-7777-4777-8777-777777777777";
      const visualization = new VisualizationBlockService(store.database.visualizationBlockRepository());
      const beforeLinks = await store.upgradeDatabase.query<{ count: number }>("SELECT count(*)::int count FROM stash_note_links");
      const saved = await visualization.save(ownerId, visibleRoot.node.id, {
        schema: "stash.visualization.v1", id: blockId, kind: "local-graph",
        query: { rootId: visibleRoot.node.id, depth: 2, limit: 40, direction: "both", includeHierarchy: true },
        filters: { relationTypes: [], direction: "both" }, layout: { renderer: "focused", positions: {} },
        viewEdges: [{ id: "view-edge", sourceNoteId: visibleRoot.node.id, targetNoteId: orphan.node.id }],
      });
      assert.equal(saved.status, "saved");
      if (saved.status !== "saved") return;
      assert.equal((await store.upgradeDatabase.query<{ count: number }>("SELECT count(*)::int count FROM stash_note_links")).rows[0]!.count,
        beforeLinks.rows[0]!.count, "saving view-only state must not mutate canonical Note Links");
      const opened = await visualization.read(ownerId, visibleRoot.node.id, blockId);
      assert.equal(opened.status, "found");
      if (opened.status === "found") assert.deepEqual(opened.block.definition.viewEdges,
        [{ id: "view-edge", sourceNoteId: visibleRoot.node.id, targetNoteId: orphan.node.id }]);
      assert.equal((await visualization.save(ownerId, orphan.node.id, {
        ...saved.block.definition, id: blockId,
      })).status, "not_found", "a portable block id cannot be rebound to another owner Note");
      assert.equal((await visualization.read(ownerId, visibleRoot.node.id, blockId)).status, "found");
      assert.equal((await visualization.read(guestId, visibleRoot.node.id, blockId)).status, "not_found");
      const exported = await store.database.readExportSnapshot(ownerId, workspaceId);
      assert.equal(exported.status, "found");
      if (exported.status === "found") assert.equal(exported.snapshot.durableObjects?.some(({ kind, id, schema }) =>
        kind === "VisualizationBlock" && id === blockId && schema === "stash.visualization.v1"), true);

      const promoted = await visualization.promoteViewEdge(ownerId, visibleRoot.node.id, blockId, "view-edge");
      assert.equal(promoted.status, "promoted");
      assert.equal((await store.upgradeDatabase.query<{ count: number }>("SELECT count(*)::int count FROM stash_note_links")).rows[0]!.count,
        beforeLinks.rows[0]!.count + 1);
    } finally { await store.close(); }
  });
});
