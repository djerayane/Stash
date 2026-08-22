import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";

import { startInstance, type DatabaseProbe, type RunningInstance } from "../src/instance.js";
import {
  NoteService,
  type NoteRecord,
  type NoteRepository,
  type PortableNoteProjection,
} from "../src/notes.js";
import type { MemberAccessResolver } from "../src/workspaces-projects.js";

const workspaceId = "11111111-1111-4111-8111-111111111111";
const projectId = "22222222-2222-4222-8222-222222222222";

class ProtocolCompatibleNoteDatabase implements DatabaseProbe, NoteRepository {
  readonly notes = new Map<string, NoteRecord>();
  readonly portableProjectionOutbox: PortableNoteProjection[] = [];
  failure: Error | undefined;
  projectionFailure: Error | undefined;

  async verifyConnection(): Promise<void> {}
  async close(): Promise<void> {}

  async findPortableMemberIdentity(memberId: string) {
    return memberId === "ada"
      ? { localAccountId: "ada", displayName: "Ada Lovelace" }
      : undefined;
  }

  async createNote(memberId: string, note: NoteRecord, projection: PortableNoteProjection) {
    if (this.failure) throw this.failure;
    if (memberId !== "ada" || note.workspaceId !== workspaceId) return "workspace_forbidden" as const;
    if (note.projectId && note.projectId !== projectId) return "project_forbidden" as const;
    if (this.projectionFailure) throw this.projectionFailure;
    this.portableProjectionOutbox.push(projection);
    this.notes.set(note.id, note);
    return "created" as const;
  }
}

const access: MemberAccessResolver = {
  async authenticateBearer(authorization) {
    return authorization === "Bearer member-ada"
      ? { accountId: "ada", sessionId: "session-ada" }
      : undefined;
  },
};

describe("capturing Notes", () => {
  let instance: RunningInstance | undefined;

  afterEach(async () => {
    await instance?.close();
    instance = undefined;
  });

  async function run() {
    const database = new ProtocolCompatibleNoteDatabase();
    instance = await startInstance({
      database,
      host: "127.0.0.1",
      port: 0,
      instanceAdminToken: "test-instance-admin-token",
      notes: new NoteService(database),
      memberAccess: access,
    });
    return { database, baseUrl: instance.url };
  }

  function capture(baseUrl: string, token: string, body: unknown) {
    return fetch(`${baseUrl}/api/workspaces/${workspaceId}/notes`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  it("lets a Member capture a content-only workspace Note", async () => {
    const { baseUrl, database } = await run();

    const response = await capture(baseUrl, "member-ada", {
      content: "Follow up on the release retrospective.",
    });

    assert.equal(response.status, 201);
    const note = await response.json() as Record<string, unknown>;
    assert.equal(note.workspaceId, workspaceId);
    assert.equal(note.content, "Follow up on the release retrospective.");
    assert.equal(note.createdByMemberId, undefined);
    assert.equal(typeof note.createdAt, "string");
    assert.equal(note.projectId, undefined);
    assert.deepEqual(note.tags, []);
    assert.equal(note.reminder, undefined);
    assert.deepEqual(note.portableProjection, {
      format: "stash.note.v1",
      state: "recorded",
    });
    assert.equal(database.notes.size, 1);
    assert.deepEqual(database.portableProjectionOutbox, [{
      schema: "stash.note.v1",
      id: note.id,
      workspaceId,
      content: "Follow up on the release retrospective.",
      tags: [],
      createdAt: note.createdAt,
      createdBy: { localAccountId: "ada", displayName: "Ada Lovelace" },
    }]);
  });

  it("captures optional Project, tags, and reminder structure", async () => {
    const { baseUrl, database } = await run();

    const response = await capture(baseUrl, "member-ada", {
      content: "Prepare the launch checklist.",
      projectId,
      tags: ["launch", "follow-up", "launch"],
      reminder: { at: "2026-09-02T10:30:00+02:00" },
    });

    assert.equal(response.status, 201);
    const note = await response.json() as Omit<NoteRecord, "createdByMemberId"> & {
      portableProjection: { format: string; state: string };
    };
    assert.equal(note.projectId, projectId);
    assert.deepEqual(note.tags, ["launch", "follow-up"]);
    assert.deepEqual(note.reminder, { at: "2026-09-02T08:30:00.000Z" });
    const { portableProjection: _, ...publicNote } = note;
    assert.deepEqual(database.notes.get(note.id), { ...publicNote, createdByMemberId: "ada" });
    assert.deepEqual(database.portableProjectionOutbox[0], {
      schema: "stash.note.v1",
      id: note.id,
      workspaceId,
      projectId,
      content: "Prepare the launch checklist.",
      tags: ["launch", "follow-up"],
      reminder: { at: "2026-09-02T08:30:00.000Z" },
      createdAt: note.createdAt,
      createdBy: { localAccountId: "ada", displayName: "Ada Lovelace" },
    });
  });

  it("accepts real leap days and legal offset edges without changing their local calendar value", async () => {
    const { baseUrl } = await run();

    for (const [at, expectedUtc] of [
      ["2028-02-29T23:59:59+14:00", "2028-02-29T09:59:59.000Z"],
      ["2028-02-29T00:00:00-14:00", "2028-02-29T14:00:00.000Z"],
    ]) {
      const response = await capture(baseUrl, "member-ada", {
        content: "Valid reminder",
        reminder: { at },
      });
      assert.equal(response.status, 201);
      const note = await response.json() as { reminder: { at: string } };
      assert.equal(note.reminder.at, expectedUtc);
    }
  });

  it("makes permission, input, and recoverable persistence failures visible without saving data", async () => {
    const { baseUrl, database } = await run();

    const unauthorized = await capture(baseUrl, "unknown", { content: "Private" });
    assert.equal(unauthorized.status, 401);

    for (const invalidBody of [
      {},
      { content: "   " },
      { content: "Idea", tags: [""] },
      { content: "Idea", reminder: { at: "sometime" } },
      { content: "Idea", reminder: { at: "2026-09-02T10:30:00" } },
      { content: "Idea", reminder: { at: "2026-02-29T10:00:00Z" } },
      { content: "Idea", reminder: { at: "2026-02-30T10:00:00Z" } },
      { content: "Idea", reminder: { at: "2026-04-31T10:00:00+02:00" } },
      { content: "Idea", reminder: { at: "2026-09-02T10:30:00+14:01" } },
      { content: "Idea", reminder: { at: "2026-09-02T10:30:00+15:00" } },
      { content: "Idea", reminder: { at: "2026-09-02T10:30:00+02:60" } },
      { content: "Idea", projectId: "not-a-uuid" },
    ]) {
      const invalid = await capture(baseUrl, "member-ada", invalidBody);
      assert.equal(invalid.status, 422);
    }

    const inaccessibleProject = await capture(baseUrl, "member-ada", {
      content: "Must remain private",
      projectId: "33333333-3333-4333-8333-333333333333",
    });
    assert.equal(inaccessibleProject.status, 403);
    assert.deepEqual(await inaccessibleProject.json(), {
      error: "workspace_forbidden",
      message: "This Member cannot capture Notes in that Workspace or Project.",
    });
    assert.equal(database.notes.size, 0);

    database.failure = new Error("postgres://stash:secret@database/stash");
    const unavailable = await capture(baseUrl, "member-ada", { content: "Retry me" });
    assert.equal(unavailable.status, 503);
    const body = await unavailable.text();
    assert.doesNotMatch(body, /postgres|secret/i);
    assert.equal(database.notes.size, 0);

    database.failure = undefined;
    database.projectionFailure = new Error("projection unavailable");
    const projectionUnavailable = await capture(baseUrl, "member-ada", {
      content: "Must stay atomic",
    });
    assert.equal(projectionUnavailable.status, 503);
    assert.equal(database.notes.size, 0);
    assert.equal(database.portableProjectionOutbox.length, 0);
  });
});
