import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";

import { startInstance, type DatabaseProbe, type RunningInstance } from "../src/instance.js";
import {
  NoteLinkService,
  type NoteLinkRecord,
  type NoteLinkRepository,
  type NoteLocationRecord,
  type PortableNoteLinkStateProjection,
  type PortableNoteLocationProjection,
} from "../src/note-links.js";
import type { MemberAccessResolver } from "../src/workspaces-projects.js";

const workspaceId = "11111111-1111-4111-8111-111111111111";
const sourceId = "22222222-2222-4222-8222-222222222222";
const targetId = "33333333-3333-4333-8333-333333333333";
const replacementId = "44444444-4444-4444-8444-444444444444";

class ProtocolCompatibleNoteLinks implements DatabaseProbe, NoteLinkRepository {
  readonly locations = new Map<string, NoteLocationRecord>([
    [sourceId, { noteId: sourceId, workspaceId, path: "notes/plan.md", aliases: [], revision: 1 }],
    [targetId, { noteId: targetId, workspaceId, path: "notes/design.md", aliases: [], revision: 1 }],
    [replacementId, { noteId: replacementId, workspaceId, path: "archive/design.md", aliases: [], revision: 1 }],
  ]);
  readonly links = new Map<string, NoteLinkRecord>();
  readonly projections: Array<PortableNoteLocationProjection | PortableNoteLinkStateProjection> = [];
  ambiguousTarget = false;
  projectionFailure = false;

  async verifyConnection() {}
  async close() {}
  async moveNote(memberId: string, noteId: string, expectedRevision: number, path: string, projection: PortableNoteLocationProjection) {
    const current = this.locations.get(noteId);
    if (memberId !== "ada" || !current) return { status: "not_found" as const };
    if (current.revision !== expectedRevision) return { status: "changed" as const, location: current };
    if (current.path === path) return { status: "unchanged" as const, location: current };
    if ([...this.locations.values()].some((location) => location.noteId !== noteId && (location.path === path || location.aliases.includes(path))))
      return { status: "path_conflict" as const };
    if (this.projectionFailure) throw new Error("projection unavailable");
    const moved = { ...current, path, aliases: [...new Set([...current.aliases.filter((alias) => alias !== path), current.path])], revision: current.revision + 1 };
    this.locations.set(noteId, moved); this.projections.push({ ...projection, path: moved.path, aliases: moved.aliases, revision: moved.revision });
    return { status: "moved" as const, location: moved };
  }
  async createNoteLink(memberId: string, link: NoteLinkRecord, projection: PortableNoteLinkStateProjection) {
    const source = this.locations.get(link.sourceNoteId); const target = link.targetNoteId ? this.locations.get(link.targetNoteId) : undefined;
    if (memberId !== "ada" || !source) return { status: "source_not_found" as const };
    if (!target || target.workspaceId !== source.workspaceId) return { status: "target_not_found" as const };
    if (this.projectionFailure) throw new Error("projection unavailable");
    const saved = { ...link, workspaceId: source.workspaceId };
    this.links.set(link.id, saved); this.projections.push({ ...projection, workspaceId: source.workspaceId }); return { status: "created" as const, link: saved };
  }
  async createImportedNoteLink(memberId: string, link: NoteLinkRecord, projection: PortableNoteLinkStateProjection) {
    const source = this.locations.get(link.sourceNoteId);
    if (memberId !== "ada" || !source) return { status: "source_not_found" as const };
    if ((link.candidateNoteIds ?? []).some((id) => this.locations.get(id)?.workspaceId !== source.workspaceId))
      return { status: "candidate_not_found" as const };
    const saved = { ...link, workspaceId: source.workspaceId }; this.links.set(saved.id, saved);
    this.projections.push({ ...projection, workspaceId: source.workspaceId }); return { status: "created" as const, link: saved };
  }
  async listNoteLinks(memberId: string, sourceNoteId: string) {
    if (memberId !== "ada" || !this.locations.has(sourceNoteId)) return { status: "not_found" as const };
    return { status: "found" as const, source: this.locations.get(sourceNoteId)!, links: [...this.links.values()].filter((link) => link.sourceNoteId === sourceNoteId).map((link) => {
      const target = link.targetNoteId ? this.locations.get(link.targetNoteId) : undefined;
      if (!link.targetNoteId) { const candidates = (link.candidateNoteIds ?? []).flatMap((id) => this.locations.get(id) ?? []);
        return candidates.length ? { link, state: "ambiguous" as const, candidates } : { link, state: "broken" as const }; }
      return this.ambiguousTarget ? { link, state: "ambiguous" as const, candidates: [target!, this.locations.get(replacementId)!] }
        : target ? { link, state: "resolved" as const, target } : { link, state: "broken" as const };
    }) };
  }
  async repairNoteLink(memberId: string, sourceNoteId: string, linkId: string, targetNoteId: string, expectedRevision: number,
    projection: PortableNoteLinkStateProjection) {
    const link = this.links.get(linkId); const target = this.locations.get(targetNoteId);
    if (memberId !== "ada" || !link || link.sourceNoteId !== sourceNoteId) return { status: "not_found" as const };
    if (!target || target.workspaceId !== link.workspaceId) return { status: "target_not_found" as const };
    if (link.revision !== expectedRevision) return { status: "changed" as const, link };
    if (this.projectionFailure) throw new Error("projection unavailable");
    const repaired = { ...link, targetNoteId, revision: link.revision + 1 };
    this.links.set(linkId, repaired); this.ambiguousTarget = false; this.projections.push({ ...projection, targetNoteId, revision: repaired.revision });
    return { status: "repaired" as const, link: repaired };
  }
}

const access: MemberAccessResolver = { async authenticateBearer(value) {
  return value === "Bearer member-ada" ? { accountId: "ada", sessionId: "session-ada" }
    : value === "Bearer member-mallory" ? { accountId: "mallory", sessionId: "session-mallory" } : undefined;
} };

describe("durable Note links", () => {
  let instance: RunningInstance | undefined;
  afterEach(async () => instance?.close());
  async function run() { const database = new ProtocolCompatibleNoteLinks(); instance = await startInstance({ database, host: "127.0.0.1", port: 0,
    instanceAdminToken: "admin", memberAccess: access, noteLinks: new NoteLinkService(database) }); return { database, base: instance.url }; }
  const request = (base: string, path: string, init: RequestInit = {}) => fetch(base + path, { ...init,
    headers: { authorization: "Bearer member-ada", "content-type": "application/json", ...init.headers } });

  it("keeps a readable link resolved by stable Note identity across renames and moves", async () => {
    const { database, base } = await run();
    const created = await request(base, `/api/notes/${sourceId}/links`, { method: "POST", body: JSON.stringify({ targetNoteId: targetId, label: "Design" }) });
    assert.equal(created.status, 201); const link = (await created.json() as any).link;
    assert.equal(link.markdown, "[Design](./design.md)");

    const moved = await request(base, `/api/notes/${targetId}/location`, { method: "PUT",
      body: JSON.stringify({ expectedRevision: 1, path: "decisions/system-design.md" }) });
    assert.equal(moved.status, 200); assert.deepEqual((await moved.json() as any).location.aliases, ["notes/design.md"]);

    const listed = await request(base, `/api/notes/${sourceId}/links`); const body = await listed.json() as any;
    assert.equal(body.links[0].state, "resolved"); assert.equal(body.links[0].targetNoteId, targetId);
    assert.equal(body.links[0].markdown, "[Design](../decisions/system-design.md)");
    assert.deepEqual(database.projections.map((projection) => projection.schema), ["stash.note-link.v2", "stash.note-location.v1"]);
  });

  it("surfaces ambiguous and broken relationships for explicit repair without leaking inaccessible Notes", async () => {
    const { database, base } = await run();
    const created = await request(base, `/api/notes/${sourceId}/links`, { method: "POST", body: JSON.stringify({ targetNoteId: targetId }) });
    const link = (await created.json() as any).link; database.ambiguousTarget = true;
    const ambiguous = await request(base, `/api/notes/${sourceId}/links`); const body = await ambiguous.json() as any;
    assert.equal(body.links[0].state, "ambiguous"); assert.deepEqual(body.links[0].candidates.map((candidate: any) => candidate.noteId), [targetId, replacementId]);

    const repaired = await request(base, `/api/notes/${sourceId}/links/${link.id}/repair`, { method: "PUT",
      body: JSON.stringify({ targetNoteId: replacementId, expectedRevision: 1 }) });
    assert.equal(repaired.status, 200); assert.equal((await repaired.json() as any).link.targetNoteId, replacementId);
    database.locations.delete(replacementId);
    assert.equal(((await (await request(base, `/api/notes/${sourceId}/links`)).json() as any).links[0]).state, "broken");

    const forbidden = await fetch(`${base}/api/notes/${sourceId}/links`, { headers: { authorization: "Bearer member-mallory" } });
    assert.equal(forbidden.status, 404); assert.deepEqual(await forbidden.json(), { error: "note_not_found", message: "This Note is unavailable." });
  });

  it("persists imported unresolved paths and requires explicit candidate repair", async () => {
    const { base } = await run();
    const imported = await request(base, `/api/notes/${sourceId}/links/import`, { method: "POST", body: JSON.stringify({
      targetPath: "legacy/design.md", candidateNoteIds: [targetId, replacementId], label: "Imported design",
    }) });
    assert.equal(imported.status, 201); const link = (await imported.json() as any).link;
    const listed = await request(base, `/api/notes/${sourceId}/links`); const body = await listed.json() as any;
    assert.equal(body.links[0].state, "ambiguous"); assert.equal(body.links[0].targetPath, "legacy/design.md");
    assert.deepEqual(body.links[0].candidates.map(({ noteId }: any) => noteId), [targetId, replacementId]);
    const repaired = await request(base, `/api/notes/${sourceId}/links/${link.id}/repair`, { method: "PUT",
      body: JSON.stringify({ targetNoteId: targetId, expectedRevision: 1 }) });
    assert.equal(repaired.status, 200); assert.equal((await repaired.json() as any).link.targetNoteId, targetId);
  });

  it("rejects unsafe paths and stale concurrent moves and rolls back when projection recording fails", async () => {
    const { database, base } = await run();
    for (const path of ["../secret.md", "/absolute.md", "notes/../../secret.md", "notes/design.txt", "notes//design.md"])
      assert.equal((await request(base, `/api/notes/${targetId}/location`, { method: "PUT", body: JSON.stringify({ expectedRevision: 1, path }) })).status, 422);
    const first = await request(base, `/api/notes/${targetId}/location`, { method: "PUT", body: JSON.stringify({ expectedRevision: 1, path: "notes/architecture.md" }) });
    assert.equal(first.status, 200);
    const stale = await request(base, `/api/notes/${targetId}/location`, { method: "PUT", body: JSON.stringify({ expectedRevision: 1, path: "notes/other.md" }) });
    assert.equal(stale.status, 409); assert.equal((await stale.json() as any).location.path, "notes/architecture.md");
    const projectionCount = database.projections.length;
    const unchanged = await request(base, `/api/notes/${targetId}/location`, { method: "PUT",
      body: JSON.stringify({ expectedRevision: 2, path: "notes/architecture.md" }) });
    assert.equal(unchanged.status, 200); const unchangedBody = await unchanged.json() as any;
    assert.equal(unchangedBody.result, "unchanged"); assert.equal(unchangedBody.location.revision, 2);
    assert.deepEqual(unchangedBody.location.aliases, ["notes/design.md"]); assert.equal(database.projections.length, projectionCount);
    database.projectionFailure = true;
    const unavailable = await request(base, `/api/notes/${sourceId}/location`, { method: "PUT", body: JSON.stringify({ expectedRevision: 1, path: "notes/renamed.md" }) });
    assert.equal(unavailable.status, 503); assert.equal(database.locations.get(sourceId)?.path, "notes/plan.md");
  });
});
