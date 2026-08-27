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
import { PostgresRelationshipQueryRepository } from "../../src/knowledge-authoring/postgres-relationship-query-repository.js";
import { VisualizationBlockService } from "../../src/knowledge-authoring/visualization-block.js";
import { NoteLinkService } from "../../src/note-links.js";
import { NoteService } from "../../src/notes.js";
import { WorkspaceProjectService } from "../../src/workspaces-projects.js";
import { normalizeVisualizationDefinition } from "../../packages/domain-types/src/visualizations.js";
import { knowledgeAuthoringCapability } from "../../src/knowledge-authoring/index.js";
import { PortableWorkspaceExportService } from "../../src/portable-workspace-export.js";
import { PortableWorkspaceImportService } from "../../src/portable-workspace-import.js";

const rootId = "11111111-1111-4111-8111-111111111111";
const emptyAttachments = { async put() {}, async get() { return Buffer.alloc(0); }, async delete() {} };
function visualizationReferences(payload: any): string[] {
  return [payload.ownerNoteId, ...(payload.query?.kind === "relationship" ? [payload.query.input.rootId] : []),
    ...Object.keys(payload.layout?.positions ?? {}),
    ...(payload.viewEdges ?? []).flatMap((edge: any) => [edge.sourceNoteId, edge.targetNoteId])];
}
function assertVisualizationClosure(snapshot: { notes: Array<{ id: string }>; durableObjects?: Array<{ kind: string; payload: unknown }> }) {
  const noteIds = new Set(snapshot.notes.map(({ id }) => id));
  for (const item of snapshot.durableObjects ?? []) if (item.kind === "VisualizationBlock") {
    const missing = visualizationReferences(item.payload).filter((id) => !noteIds.has(id));
    assert.deepEqual(missing, [], `VisualizationBlock escaped its exported Note universe ${JSON.stringify([...noteIds])}: ${JSON.stringify(item.payload)}`);
  }
}

describe("relationship query contracts", () => {
  test("registers core relationship navigation without the optional saved-view service", () => {
    const repository: RelationshipQueryRepository = { async query() { return { status: "not_found" }; },
      async maintenance() { return { status: "workspace_forbidden" }; } };
    const capability = knowledgeAuthoringCapability({ notes: {} as never, relationships: new RelationshipQueryService(repository),
      memberAccess: { async authenticateBearer() { return undefined; } } });
    const routes = capability.routes();
    assert.equal(routes.some((route) => route.matches({} as never, new URL(`http://stash.test/api/notes/${rootId}/relationships`))), true);
    assert.equal(routes.some((route) => route.matches({} as never,
      new URL(`http://stash.test/api/notes/${rootId}/visualizations/22222222-2222-4222-8222-222222222222`))), false);
  });
  test("normalizes a bounded focused query before it reaches persistence", async () => {
    const received: unknown[] = []; const maintenanceReceived: unknown[] = [];
    const repository: RelationshipQueryRepository = {
      async query(_memberId, query) {
        received.push(query);
        return { status: "found", neighborhood: { rootId, depth: query.depth, limit: query.limit,
          direction: query.direction, nodes: [], edges: [], outline: [], hasMore: false } };
      },
      async maintenance(_memberId, _workspaceId, query) { maintenanceReceived.push(query); return { status: "found", orphans: [], brokenLinks: [] }; },
    };
    const service = new RelationshipQueryService(repository);

    await service.query("member", rootId, { depth: 2, limit: 24, direction: "incoming",
      relationTypes: ["supports", "supports", "untyped"], includeHierarchy: false });

    assert.deepEqual(received, [{ rootId, depth: 2, limit: 24, direction: "incoming",
      relationTypes: ["supports", "untyped"], includeHierarchy: false }]);
    await assert.rejects(() => service.query("member", rootId, { depth: 4 }), InvalidRelationshipQuery);
    await assert.rejects(() => service.query("member", rootId, { limit: 101 }), InvalidRelationshipQuery);
    await service.maintenance("member", "99999999-9999-4999-8999-999999999999",
      { limit: 12, orphanCursor: "24", brokenCursor: "36" });
    assert.deepEqual(maintenanceReceived, [{ limit: 12, orphanOffset: 24, brokenOffset: 36 }]);
    await assert.rejects(() => service.maintenance("member", "99999999-9999-4999-8999-999999999999",
      { cursor: "12" }), InvalidRelationshipQuery);
  });

  test("normalizes portable Visualization Block state without inventing canonical edges", () => {
    const definition = normalizeVisualizationDefinition({
      schema: "stash.visualization.v1",
      id: "22222222-2222-4222-8222-222222222222",
      kind: "local-graph",
      query: { kind: "relationship", input: { rootId, depth: 2, limit: 40, direction: "both", relationTypes: ["supports"], includeHierarchy: true } },
      filters: { relationTypes: ["supports"], direction: "both" },
      layout: { kind: "focused", positions: { [rootId]: { x: 20, y: 30 } } },
      viewEdges: [{ id: "edge-local", sourceNoteId: rootId,
        targetNoteId: "33333333-3333-4333-8333-333333333333", relationshipType: "questions" }],
    });

    assert.deepEqual(definition.viewEdges, [{ id: "edge-local", sourceNoteId: rootId,
      targetNoteId: "33333333-3333-4333-8333-333333333333", relationshipType: "questions" }]);
    assert.equal(definition.kind, "local-graph");
    assert.deepEqual(normalizeVisualizationDefinition({ ...definition, layout: undefined }).layout,
      { kind: "focused", positions: {} });
    assert.throws(() => normalizeVisualizationDefinition({ ...definition, kind: "third-party-script" }));
    assert.throws(() => normalizeVisualizationDefinition({ ...definition, layout: { kind: "force", positions: {} } }));
    assert.throws(() => normalizeVisualizationDefinition({ ...definition, query: { kind: "search", input: { text: "all", limit: 20 } } }));
    assert.throws(() => normalizeVisualizationDefinition({ ...definition,
      viewEdges: [definition.viewEdges[0], definition.viewEdges[0]] }));
    for (const coordinate of ["20", Number.NaN, Number.POSITIVE_INFINITY])
      assert.throws(() => normalizeVisualizationDefinition({ ...definition,
        layout: { kind: "focused", positions: { [rootId]: { x: coordinate, y: 30 } } } }),
      "positions require finite native numbers");

    const wordCloud = normalizeVisualizationDefinition({ schema: "stash.visualization.v1",
      id: "44444444-4444-4444-8444-444444444444", kind: "word-cloud",
      query: { kind: "facet", input: { field: "relationshipType", terms: ["supports"], limit: 40 } },
      filters: { terms: ["supports"] }, layout: { kind: "word-cloud", minFontSize: 12, maxFontSize: 40 }, viewEdges: [] });
    assert.equal(wordCloud.query.kind, "facet");
    assert.deepEqual(normalizeVisualizationDefinition(wordCloud), wordCloud);
    const aggregateCloud = normalizeVisualizationDefinition({ ...wordCloud, id: "45454545-4545-4545-8545-454545454545",
      query: { kind: "aggregate", input: { field: "relationshipType", operation: "count", terms: [], limit: 30 } } });
    assert.equal(aggregateCloud.query.kind, "aggregate");
    for (const fontSize of ["12", Number.NaN, Number.NEGATIVE_INFINITY])
      assert.throws(() => normalizeVisualizationDefinition({ ...wordCloud,
        layout: { kind: "word-cloud", minFontSize: fontSize, maxFontSize: 40 } }),
      "word-cloud sizes require finite native numbers");

    const canvas = normalizeVisualizationDefinition({ schema: "stash.visualization.v1",
      id: "55555555-5555-4555-8555-555555555555", kind: "canvas",
      query: { kind: "search", input: { text: "decision", terms: ["supports"], limit: 30 } }, filters: { terms: ["supports"] },
      layout: { kind: "spatial", positions: { [rootId]: { x: 1, y: 2 } } },
      viewEdges: [{ id: "canvas-edge", sourceNoteId: rootId, targetNoteId: "33333333-3333-4333-8333-333333333333" }] });
    assert.equal(canvas.query.kind, "search"); assert.deepEqual(normalizeVisualizationDefinition(canvas), canvas);
    const relationshipCanvas = normalizeVisualizationDefinition({ ...canvas, id: "56565656-5656-4656-8656-565656565656",
      query: definition.query, filters: definition.filters });
    assert.equal(relationshipCanvas.query.kind, "relationship");
    assert.throws(() => normalizeVisualizationDefinition({ ...wordCloud, layout: { kind: "spatial", positions: {} } }));
    assert.throws(() => normalizeVisualizationDefinition({ ...wordCloud, viewEdges: canvas.viewEdges }));
    assert.throws(() => normalizeVisualizationDefinition({ ...definition, kind: "word-cloud" }));
    for (const hostileKind of ["toString", "constructor", "__proto__"])
      assert.throws(() => normalizeVisualizationDefinition({ ...definition, kind: hostileKind }));
    const { kind: _kind, ...kindless } = definition;
    assert.throws(() => normalizeVisualizationDefinition(Object.assign(Object.create({ kind: "local-graph" }), kindless)),
      "inherited kind values must never satisfy the portable interface");
    assert.throws(() => normalizeVisualizationDefinition({ ...definition,
      query: Object.assign(Object.create({ kind: "relationship" }), { input: definition.query.input }) }));
    assert.throws(() => normalizeVisualizationDefinition({ ...definition,
      layout: Object.assign(Object.create({ kind: "focused" }), { positions: {} }) }));
  });

  test("bounds PostgreSQL traversal rounds and every candidate read", async () => {
    const calls: Array<{ sql: string; values: readonly unknown[] }> = []; let candidateRound = 0;
    const client = { async query(sql: string, values: readonly unknown[] = []) {
      calls.push({ sql, values });
      if (sql.includes("note.workspace_id") && !sql.includes("WITH candidates")) return { rows: [{ id: rootId, title: "Root", parent_id: null,
        workspace_id: "99999999-9999-4999-8999-999999999999" }], rowCount: 1 };
      if (sql.includes("WITH candidates")) { candidateRound += 1; return { rows: candidateRound <= 3
        ? [{ id: `${String(candidateRound).padStart(8, "0")}-8888-4888-8888-888888888888`, title: `Depth ${candidateRound}`, parent_id: null }] : [], rowCount: candidateRound <= 3 ? 1 : 0 }; }
      return { rows: [], rowCount: 0 };
    } };
    const kernel = { async withSession<T>(work: (session: typeof client) => Promise<T>) { return work(client); } };
    const repository = new PostgresRelationshipQueryRepository(kernel as never, async () => undefined);
    const result = await repository.query("member", { rootId, depth: 3, limit: 100, direction: "both", includeHierarchy: true });
    assert.equal(result.status, "found");
    const operational = calls.filter(({ sql }) => !sql.includes("CREATE INDEX"));
    assert.equal(operational.length, 6, "root + at most depth rounds + one continuation probe + bounded edges");
    const bounded = calls.filter(({ sql }) => sql.includes("WITH candidates"));
    assert.equal(bounded.length, 4);
    assert.equal(bounded.every(({ values }) => Number(values[5]) <= 101), true);
    assert.equal(operational.at(-1)?.values[2], 401, "edge reads are capped independently of graph density");
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
      assert.equal((await new NoteService(store.database.knowledgeAuthoringRepositories()).triage(ownerId, workspaceId, visibleRoot.node.id,
        { action: "organize", projectId: project.project.id })).status, "updated");
      assert.equal((await new NoteService(store.database.knowledgeAuthoringRepositories()).triage(ownerId, workspaceId, visibleIsolated.node.id,
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
      const archivedBrokenSource = await notes.create(ownerId, workspaceId, { title: "Archived broken source" });
      const trashedBrokenSource = await notes.create(ownerId, workspaceId, { title: "Trashed broken source" });
      const activeWithInactiveTarget = await notes.create(ownerId, workspaceId, { title: "AA active with inactive target" });
      const inactiveTarget = await notes.create(ownerId, workspaceId, { title: "Archived target" });
      assert.equal(archivedBrokenSource.status, "created"); assert.equal(trashedBrokenSource.status, "created");
      assert.equal(activeWithInactiveTarget.status, "created"); assert.equal(inactiveTarget.status, "created");
      if (archivedBrokenSource.status !== "created" || trashedBrokenSource.status !== "created"
        || activeWithInactiveTarget.status !== "created" || inactiveTarget.status !== "created") return;
      const linkService = new NoteLinkService(store.database);
      assert.equal((await linkService.importUnresolved(ownerId, archivedBrokenSource.node.id,
        { targetPath: "archived-missing.md", candidateNoteIds: [], label: "Archived unresolved" })).status, "created");
      assert.equal((await linkService.importUnresolved(ownerId, trashedBrokenSource.node.id,
        { targetPath: "trashed-missing.md", candidateNoteIds: [], label: "Trashed unresolved" })).status, "created");
      assert.equal((await notes.createContextLink(ownerId, activeWithInactiveTarget.node.id,
        { targetNoteId: inactiveTarget.node.id, label: "Soon inactive" })).status, "created");
      assert.equal((await notes.remove(ownerId, archivedBrokenSource.node.id, "archived")).status, "updated");
      assert.equal((await notes.remove(ownerId, trashedBrokenSource.node.id, "trashed")).status, "updated");
      assert.equal((await notes.remove(ownerId, inactiveTarget.node.id, "archived")).status, "updated");

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
        assert.equal(ownerMaintenance.orphans.some(({ id }) => id === activeWithInactiveTarget.node.id), true,
          "a link to an inactive target must not make an active Note appear connected");
        assert.equal(JSON.stringify(ownerMaintenance).includes(archivedBrokenSource.node.id), false);
        assert.equal(JSON.stringify(ownerMaintenance).includes(trashedBrokenSource.node.id), false);
        assert.equal(JSON.stringify(ownerMaintenance).includes(inactiveTarget.node.id), false);
        assert.deepEqual(ownerMaintenance.brokenLinks.map(({ label, targetPath, candidates }) => ({ label, targetPath,
          candidates: candidates.map(({ title }) => title) })), [{ label: "Hidden lead", targetPath: "notes/missing.md", candidates: ["Private strategy"] }]);
      }

      const blockId = "77777777-7777-4777-8777-777777777777";
      const visualization = new VisualizationBlockService(store.database.visualizationBlockRepository());
      const beforeLinks = await store.upgradeDatabase.query<{ count: number }>("SELECT count(*)::int count FROM stash_note_links");
      assert.equal((await notes.restore(ownerId, archivedBrokenSource.node.id)).status, "restored");
      assert.equal((await notes.restore(ownerId, trashedBrokenSource.node.id)).status, "restored");
      const createSaveKey = "11111111-1111-4111-8111-111111111111";
      const saved = await visualization.save(ownerId, visibleRoot.node.id, {
        schema: "stash.visualization.v1", id: blockId, kind: "local-graph",
        query: { kind: "relationship", input: { rootId: visibleRoot.node.id, depth: 2, limit: 40, direction: "both",
          relationTypes: ["supports", "contradicts"], includeHierarchy: true } },
        filters: { relationTypes: ["supports", "contradicts"], direction: "both" }, layout: { kind: "focused", positions: {
          [visibleRoot.node.id]: { x: 10, y: 20 }, [orphan.node.id]: { x: 30, y: 40 },
          [archivedBrokenSource.node.id]: { x: 50, y: 60 }, [trashedBrokenSource.node.id]: { x: 70, y: 80 } } },
        viewEdges: [{ id: "view-edge", sourceNoteId: visibleRoot.node.id, targetNoteId: orphan.node.id, relationshipType: "contradicts" },
          { id: "visible-view-edge", sourceNoteId: visibleRoot.node.id, targetNoteId: visibleChild.node.id, relationshipType: "supports" },
          { id: "archived-view-edge", sourceNoteId: visibleRoot.node.id, targetNoteId: archivedBrokenSource.node.id },
          { id: "trashed-view-edge", sourceNoteId: visibleRoot.node.id, targetNoteId: trashedBrokenSource.node.id }],
      }, undefined, createSaveKey);
      assert.equal(saved.status, "saved");
      if (saved.status !== "saved") return;
      const duplicateSave = await visualization.save(ownerId, visibleRoot.node.id, saved.block.definition, undefined, createSaveKey);
      assert.deepEqual(duplicateSave, saved, "the same saved-view command must replay without another revision or Activity");
      assert.equal((await visualization.save(ownerId, visibleRoot.node.id, { ...saved.block.definition,
        filters: { relationTypes: ["supports"], direction: "both" } }, undefined, createSaveKey)).status, "idempotency_conflict");
      assert.equal((await store.upgradeDatabase.query<{ count: number }>("SELECT count(*)::int count FROM stash_workspace_activity WHERE action='visualization_block_created'")).rows[0]!.count, 1);
      assert.equal((await store.upgradeDatabase.query<{ count: number }>("SELECT count(*)::int count FROM stash_note_links")).rows[0]!.count,
        beforeLinks.rows[0]!.count, "saving view-only state must not mutate canonical Note Links");
      const opened = await visualization.read(ownerId, visibleRoot.node.id, blockId);
      assert.equal(opened.status, "found");
      if (opened.status === "found") assert.equal(opened.block.definition.viewEdges.length, 4);
      assert.equal((await visualization.save(ownerId, orphan.node.id, {
        ...saved.block.definition, id: blockId,
      }, undefined, "22222222-2222-4222-8222-222222222222")).status, "not_found", "a portable block id cannot be rebound to another owner Note");
      assert.equal((await visualization.read(ownerId, visibleRoot.node.id, blockId)).status, "found");
      const guestView = await visualization.read(guestId, visibleRoot.node.id, blockId);
      assert.equal(guestView.status, "found");
      if (guestView.status === "found") {
        assert.deepEqual(guestView.block.definition.viewEdges,
          [{ id: "visible-view-edge", sourceNoteId: visibleRoot.node.id, targetNoteId: visibleChild.node.id, relationshipType: "supports" }]);
        assert.equal("positions" in guestView.block.definition.layout, true);
        if ("positions" in guestView.block.definition.layout)
          assert.deepEqual(Object.keys(guestView.block.definition.layout.positions), [visibleRoot.node.id]);
        assert.equal(JSON.stringify(guestView.block).includes(orphan.node.id), false);
        assert.equal(JSON.stringify(guestView.block).includes("contradicts"), false);
        assert.equal(JSON.stringify(guestView.block).includes("supports"), true);
      }
      assert.equal((await visualization.save(guestId, visibleRoot.node.id, saved.block.definition, undefined,
        "33333333-3333-4333-8333-333333333333")).status, "not_found");
      assert.equal((await visualization.save(guestId, visibleRoot.node.id, saved.block.definition, undefined, createSaveKey)).status, "not_found",
        "an idempotency receipt must not bypass current save authority");
      const updated = await visualization.save(ownerId, visibleRoot.node.id, saved.block.definition, 1,
        "44444444-4444-4444-8444-444444444445");
      assert.equal(updated.status, "saved");
      if (updated.status === "saved") assert.equal(updated.block.revision, 2);
      assert.equal((await store.upgradeDatabase.query<{ count: number }>("SELECT count(*)::int count FROM stash_workspace_activity WHERE action='visualization_block_updated'")).rows[0]!.count, 1);
      assert.equal((await notes.remove(ownerId, archivedBrokenSource.node.id, "archived")).status, "updated");
      assert.equal((await notes.remove(ownerId, trashedBrokenSource.node.id, "trashed")).status, "updated");
      const exported = await store.database.readExportSnapshot(ownerId, workspaceId);
      assert.equal(exported.status, "found");
      if (exported.status === "found") {
        assert.equal(exported.snapshot.durableObjects?.some(({ kind, id, schema }) =>
          kind === "VisualizationBlock" && id === blockId && schema === "stash.visualization.v1"), true,
        JSON.stringify(exported.snapshot.durableObjects));
        const saveActivities = (exported.snapshot.activities ?? []).filter(({ object }) => object.kind === "VisualizationBlock" && object.id === blockId);
        assert.deepEqual(saveActivities.map(({ action }) => action), ["visualization_block_created", "visualization_block_updated"]);
        assert.deepEqual(saveActivities.map(({ actor, cause }) => ({ actor: actor.displayName, cause: cause.kind })),
          [{ actor: "Ada", cause: "member" }, { actor: "Ada", cause: "member" }]);
        assert.deepEqual(saveActivities[0]?.before, { present: false });
        assert.equal((saveActivities[1]?.before as { revision?: number }).revision, 1);
        assert.equal((saveActivities[1]?.after as { revision?: number }).revision, 2);
        assertVisualizationClosure(exported.snapshot);
        assert.equal(exported.snapshot.notes.some(({ id }) => id === archivedBrokenSource.node.id), true);
        assert.equal(exported.snapshot.notes.some(({ id }) => id === trashedBrokenSource.node.id), true);
        assert.equal(exported.snapshot.noteLocations.find(({ noteId }) => noteId === archivedBrokenSource.node.id)?.archivedAt !== undefined, true);
        assert.equal(exported.snapshot.noteLocations.find(({ noteId }) => noteId === trashedBrokenSource.node.id)?.trashedAt !== undefined, true);
        const ownerBlock = exported.snapshot.durableObjects?.find(({ kind, id }) => kind === "VisualizationBlock" && id === blockId);
        assert.equal(JSON.stringify(ownerBlock).includes(archivedBrokenSource.node.id), true);
        assert.equal(JSON.stringify(ownerBlock).includes(trashedBrokenSource.node.id), true);
      }
      const guestExport = await store.database.readExportSnapshot(guestId, workspaceId);
      assert.equal(guestExport.status, "found");
      if (guestExport.status === "found") {
        assert.deepEqual(guestExport.snapshot.notes.map(({ id }) => id).sort(),
          [visibleRoot.node.id, visibleChild.node.id, visibleIsolated.node.id].sort());
        assertVisualizationClosure(guestExport.snapshot);
        const guestPortable = guestExport.snapshot.durableObjects?.find(({ kind, id }) => kind === "VisualizationBlock" && id === blockId);
        assert.equal(JSON.stringify(guestPortable).includes("contradicts"), false);
        assert.equal(JSON.stringify(guestPortable).includes("supports"), true);
      }

      for (const [memberId, importId, destinationOwnerId] of [[ownerId, "91919191-9191-4191-8191-919191919191", "92929292-9292-4292-8292-929292929292"],
        [guestId, "93939393-9393-4393-8393-939393939393", "94949494-9494-4494-8494-949494949494"]] as const) {
        const archive = await new PortableWorkspaceExportService(store.database, emptyAttachments).export(memberId, workspaceId);
        assert.equal(archive.status, "exported"); if (archive.status !== "exported") continue;
        const destination = await EmbeddedInstanceStore.open(await mkdtemp(join(tmpdir(), "stash-relationship-import-")),
          createAuthenticationSecretCodec(randomBytes(32).toString("base64")));
        try {
          await destination.database.createFirstOrganizationOwner({ organizationId: `${destinationOwnerId.slice(0, -1)}1`, organizationName: "Destination",
            ownerId: destinationOwnerId, ownerName: "Importer", ownerEmail: `${destinationOwnerId}@example.test`, passwordHash: "test-only", role: "Owner" });
          const imported = await new PortableWorkspaceImportService(destination.database, emptyAttachments).import(importId, destinationOwnerId, archive.archive);
          assert.equal(imported.status, "imported");
          const roundTrip = await destination.database.readExportSnapshot(destinationOwnerId, workspaceId);
          assert.equal(roundTrip.status, "found"); if (roundTrip.status === "found") assertVisualizationClosure(roundTrip.snapshot);
        } finally { await destination.close(); }
      }

      assert.equal((await visualization.promoteViewEdge(guestId, visibleRoot.node.id, blockId, "view-edge",
        "66666666-6666-4666-8666-666666666666")).status, "not_found");
      const [promoted, promotedAgain] = await Promise.all([
        visualization.promoteViewEdge(ownerId, visibleRoot.node.id, blockId, "view-edge",
          "55555555-5555-4555-8555-555555555555"),
        visualization.promoteViewEdge(ownerId, visibleRoot.node.id, blockId, "view-edge",
          "55555555-5555-4555-8555-555555555555"),
      ]);
      assert.equal(promoted.status, "promoted");
      assert.deepEqual(promotedAgain, promoted);
      assert.equal((await store.upgradeDatabase.query<{ count: number }>("SELECT count(*)::int count FROM stash_workspace_activity WHERE action='visualization_edge_promoted'")).rows[0]!.count, 1);
      assert.equal((await store.upgradeDatabase.query<{ count: number }>("SELECT count(*)::int count FROM stash_note_links")).rows[0]!.count,
        beforeLinks.rows[0]!.count + 1);

      for (let index = 0; index < 80; index += 1) {
        const child = await notes.create(ownerId, workspaceId, { title: `Wide ${String(index).padStart(2, "0")}`, parentId: visibleRoot.node.id });
        assert.equal(child.status, "created");
      }
      const indexes = await store.upgradeDatabase.query<{ indexname: string }>(`SELECT indexname FROM pg_indexes
        WHERE indexname IN ('stash_note_links_incoming_active_idx','stash_note_links_workspace_unresolved_idx') ORDER BY indexname`);
      assert.deepEqual(indexes.rows.map(({ indexname }) => indexname),
        ["stash_note_links_incoming_active_idx", "stash_note_links_workspace_unresolved_idx"]);
      const firstWidePage = await service.query(ownerId, visibleRoot.node.id,
        { depth: 1, limit: 24, direction: "both", relationTypes: ["not-a-link-type"], includeHierarchy: true });
      assert.equal(firstWidePage.status, "found");
      if (firstWidePage.status === "found") { assert.equal(firstWidePage.neighborhood.nodes.length, 24); assert.equal(firstWidePage.neighborhood.hasMore, true); }
      const expandedWidePage = await service.query(ownerId, visibleRoot.node.id,
        { depth: 1, limit: 100, direction: "both", relationTypes: ["not-a-link-type"], includeHierarchy: true });
      assert.equal(expandedWidePage.status, "found");
      if (expandedWidePage.status === "found") assert.equal(expandedWidePage.neighborhood.nodes.length > 25, true);
      const firstMaintenancePage = await service.maintenance(ownerId, workspaceId, { limit: 10, orphanCursor: "0", brokenCursor: "0" });
      assert.equal(firstMaintenancePage.status, "found");
      if (firstMaintenancePage.status === "found") {
        assert.equal(firstMaintenancePage.orphans.length, 10); assert.equal(firstMaintenancePage.nextCursors?.orphans, "10");
        const secondMaintenancePage = await service.maintenance(ownerId, workspaceId,
          { limit: 10, orphanCursor: firstMaintenancePage.nextCursors?.orphans, brokenCursor: "0" });
        assert.equal(secondMaintenancePage.status, "found");
        if (secondMaintenancePage.status === "found") assert.equal(secondMaintenancePage.orphans.some(({ id }) =>
          firstMaintenancePage.orphans.some((first) => first.id === id)), false);
      }
    } finally { await store.close(); }
  });
});
