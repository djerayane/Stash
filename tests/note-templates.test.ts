import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";

import { startInstance, type DatabaseProbe, type RunningInstance } from "../src/instance.js";
import { NoteService, type NoteRecord, type NoteRepository, type PortableNoteProjection } from "../src/notes.js";
import type { MemberAccessResolver } from "../src/workspaces-projects.js";

const workspaceId = "11111111-1111-4111-8111-111111111111";
const projectId = "22222222-2222-4222-8222-222222222222";

class TemplateNoteDatabase implements DatabaseProbe, NoteRepository {
  readonly notes = new Map<string, NoteRecord>();
  readonly projections: PortableNoteProjection[] = [];
  failure?: Error;

  async verifyConnection() {}
  async close() {}
  async findPortableMemberIdentity(memberId: string) {
    return memberId === "ada" ? { localAccountId: "ada", displayName: "Ada Lovelace" }
      : memberId === "grace" ? { localAccountId: "grace", displayName: "Grace Hopper" } : undefined;
  }
  async createNote(memberId: string, note: NoteRecord, projection: PortableNoteProjection) {
    if (this.failure) throw this.failure;
    if (memberId !== "ada" || note.workspaceId !== workspaceId) return "workspace_forbidden" as const;
    if (note.projectId && note.projectId !== projectId) return "project_forbidden" as const;
    this.notes.set(note.id, note); this.projections.push(projection); return "created" as const;
  }
  async listNotesByTag(memberId: string, requestedWorkspaceId: string, tag: string) {
    if (this.failure) throw this.failure;
    if (!["ada", "grace"].includes(memberId) || requestedWorkspaceId !== workspaceId) return { status: "workspace_forbidden" as const };
    return { status: "found" as const, notes: [...this.notes.values()].filter((note) => !note.archivedAt && note.tags.includes(tag)
      && (memberId === "ada" || note.projectId === projectId)) };
  }
  async listNotes(memberId: string, requestedWorkspaceId: string) {
    if (this.failure) throw this.failure;
    if (!["ada", "grace"].includes(memberId) || requestedWorkspaceId !== workspaceId) return { status: "workspace_forbidden" as const };
    return { status: "found" as const, notes: [...this.notes.values()].filter((note) => !note.archivedAt
      && (memberId === "ada" || note.projectId === projectId)) };
  }
  async listInboxNotes() { return { status: "found" as const, notes: [] }; }
  async triageNote() { return { status: "note_not_found" as const }; }
  async findNoteForMember(memberId: string, noteId: string) { return memberId === "ada" ? this.notes.get(noteId) : undefined; }
  async applyNoteOperations() { return { status: "not_found" as const }; }
  async listNoteEditConflicts() { return { status: "not_found" as const }; }
  async resolveNoteEditConflict() { return { status: "not_found" as const }; }
}

const access: MemberAccessResolver = {
  async authenticateBearer(header) {
    return header === "Bearer member-ada" ? { accountId: "ada", sessionId: "session-ada" }
      : header === "Bearer guest-grace" ? { accountId: "grace", sessionId: "session-grace" } : undefined;
  },
};

describe("Note Templates and Decision Notes", () => {
  let instance: RunningInstance | undefined;
  afterEach(async () => { await instance?.close(); instance = undefined; });

  async function run() {
    const database = new TemplateNoteDatabase();
    instance = await startInstance({ database, host: "127.0.0.1", port: 0, instanceAdminToken: "admin",
      notes: new NoteService(database), memberAccess: access });
    return { database, baseUrl: instance.url };
  }

  const authorized = { authorization: "Bearer member-ada" };

  it("offers an optional Decision template and creates an ordinary portable Note from it", async () => {
    const { database, baseUrl } = await run();
    const templates = await fetch(`${baseUrl}/api/workspaces/${workspaceId}/note-templates`, { headers: authorized });
    assert.equal(templates.status, 200);
    assert.deepEqual(await templates.json(), { templates: [{ id: "decision", name: "Decision Note",
      description: "Record a settled choice, its context, and resulting work.", suggestedTags: ["decision"] }] });

    const response = await fetch(`${baseUrl}/api/workspaces/${workspaceId}/notes`, { method: "POST",
      headers: { ...authorized, "content-type": "application/json" }, body: JSON.stringify({ templateId: "decision", projectId }) });
    assert.equal(response.status, 201);
    const note = await response.json() as NoteRecord & { portableProjection: { format: string; state: string } };
    assert.match(note.content, /^# Decision\n\n## Context\n/);
    assert.match(note.content, /## Resulting work/);
    assert.deepEqual(note.document.blocks.map(({ type }) => type), ["heading", "heading", "paragraph", "heading", "paragraph", "heading", "paragraph"]);
    assert.ok(note.document.blocks.every(({ blockKey }) => typeof blockKey === "string"));
    assert.deepEqual(note.tags, ["decision"]);
    assert.equal((note as unknown as Record<string, unknown>).templateId, undefined);
    assert.equal(database.notes.get(note.id)?.projectId, projectId);
    assert.deepEqual(database.projections[0]?.tags, ["decision"]);
    assert.equal(database.projections[0]?.schema, "stash.note.v1");
  });

  it("lets Members customize starter content and properties without creating a Note type", async () => {
    const { baseUrl } = await run();
    const response = await fetch(`${baseUrl}/api/workspaces/${workspaceId}/notes`, { method: "POST",
      headers: { ...authorized, "content-type": "application/json" }, body: JSON.stringify({
        templateId: "decision", content: "# Decision\n\nUse PostgreSQL.", tags: ["architecture"], projectId,
      }) });
    assert.equal(response.status, 201);
    const note = await response.json() as NoteRecord;
    assert.equal(note.content, "# Decision\n\nUse PostgreSQL.");
    assert.deepEqual(note.tags, ["architecture"]);

    const withoutSuggestedProperties = await fetch(`${baseUrl}/api/workspaces/${workspaceId}/notes`, { method: "POST",
      headers: { ...authorized, "content-type": "application/json" }, body: JSON.stringify({
        templateId: "decision", tags: [],
      }) });
    assert.equal(withoutSuggestedProperties.status, 201);
    assert.deepEqual((await withoutSuggestedProperties.json() as NoteRecord).tags, []);
  });

  it("discovers active Decision Notes through a permission-aware filtered view", async () => {
    const { database, baseUrl } = await run();
    for (const body of [{ content: "Ordinary" }, { templateId: "decision" },
      { content: "Manual decision", tags: ["decision"], projectId }]) {
      const created = await fetch(`${baseUrl}/api/workspaces/${workspaceId}/notes`, { method: "POST",
        headers: { ...authorized, "content-type": "application/json" }, body: JSON.stringify(body) });
      assert.equal(created.status, 201);
    }
    const archived = [...database.notes.values()].find((note) => note.content.includes("Resulting work"))!;
    archived.archivedAt = "2026-08-23T12:00:00.000Z";

    const response = await fetch(`${baseUrl}/api/workspaces/${workspaceId}/notes?view=decisions`, { headers: authorized });
    assert.equal(response.status, 200);
    const body = await response.json() as { notes: NoteRecord[] };
    assert.deepEqual(body.notes.map(({ content }) => content), ["Manual decision"]);
    assert.equal(body.notes[0]?.createdByMemberId, undefined);

    const { archivedAt: _, ...visibleNote } = database.notes.values().next().value!;
    database.notes.set("44444444-4444-4444-8444-444444444444", { ...visibleNote,
      id: "44444444-4444-4444-8444-444444444444", projectId: "55555555-5555-4555-8555-555555555555",
      content: "Unshared decision", tags: ["decision"] });
    const guestResponse = await fetch(`${baseUrl}/api/workspaces/${workspaceId}/notes?view=decisions`, {
      headers: { authorization: "Bearer guest-grace" },
    });
    assert.equal(guestResponse.status, 200);
    const guestBody = await guestResponse.json() as { notes: NoteRecord[] };
    assert.deepEqual(guestBody.notes.map(({ content }) => content), ["Manual decision"]);
    assert.doesNotMatch(JSON.stringify(guestBody), /Ordinary|Unshared/);
  });

  it("lists every active permitted Note while keeping guest Project boundaries intact", async () => {
    const { database, baseUrl } = await run();
    for (const body of [{ content: "Workspace ordinary" }, { content: "Shared ordinary", projectId },
      { content: "Shared decision", projectId, tags: ["decision"] }]) {
      assert.equal((await fetch(`${baseUrl}/api/workspaces/${workspaceId}/notes`, { method: "POST",
        headers: { ...authorized, "content-type": "application/json" }, body: JSON.stringify(body) })).status, 201);
    }
    const member = await fetch(`${baseUrl}/api/workspaces/${workspaceId}/notes`, { headers: authorized });
    assert.equal(member.status, 200);
    assert.deepEqual((await member.json() as { notes: NoteRecord[] }).notes.map(({ content }) => content), ["Workspace ordinary", "Shared ordinary", "Shared decision"]);
    const guest = await fetch(`${baseUrl}/api/workspaces/${workspaceId}/notes`, { headers: { authorization: "Bearer guest-grace" } });
    assert.equal(guest.status, 200);
    const guestBody = await guest.json() as { notes: NoteRecord[] };
    assert.deepEqual(guestBody.notes.map(({ content }) => content), ["Shared ordinary", "Shared decision"]);
    assert.doesNotMatch(JSON.stringify(guestBody), /createdByMemberId|Workspace ordinary/);
  });

  it("makes authentication, invalid templates, inaccessible Workspaces, and failures visible", async () => {
    const { database, baseUrl } = await run();
    assert.equal((await fetch(`${baseUrl}/api/workspaces/${workspaceId}/note-templates`)).status, 401);
    const invalid = await fetch(`${baseUrl}/api/workspaces/${workspaceId}/notes`, { method: "POST",
      headers: { ...authorized, "content-type": "application/json" }, body: JSON.stringify({ templateId: "incident" }) });
    assert.equal(invalid.status, 422);
    assert.deepEqual(database.notes.size, 0);
    assert.equal((await fetch(`${baseUrl}/api/workspaces/33333333-3333-4333-8333-333333333333/notes?view=decisions`, { headers: authorized })).status, 403);
    database.failure = new Error("postgres://private");
    const unavailable = await fetch(`${baseUrl}/api/workspaces/${workspaceId}/notes?view=decisions`, { headers: authorized });
    assert.equal(unavailable.status, 503);
    assert.doesNotMatch(await unavailable.text(), /postgres|private/i);
  });

  it("serves a keyboard-operable template and Decision Notes browser surface", async () => {
    const { baseUrl } = await run();
    const response = await fetch(`${baseUrl}/workspaces/${workspaceId}/notes`);
    assert.equal(response.status, 200);
    const html = await response.text();
    assert.match(html, /<title>Notes · Stash<\/title>/);
    assert.match(html, /data-template="decision"/);
    assert.match(html, /Decision Notes/);
    assert.match(html, /aria-live="polite"/);
    assert.match(html, /prefers-reduced-motion/);
    assert.match(html, /window\.gsap\.from/);
  });
});
