import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";

import { startInstance, type DatabaseProbe, type RunningInstance } from "../src/instance.js";
import {
  MobileCaptureClient,
  type EncryptedMobileCaptureStore,
  type MobileCapture,
  type MobileCapturePairing,
} from "../src/mobile-capture-client.js";
import {
  MobileCaptureService,
  type MobileCaptureRepository,
} from "../src/mobile-captures.js";
import type { NoteRecord, PortableNoteProjection } from "../src/notes.js";
import type { MemberAccessResolver } from "../src/workspaces-projects.js";

const workspaceId = "11111111-1111-4111-8111-111111111111";
const projectId = "22222222-2222-4222-8222-222222222222";

class MemoryEncryptedStore implements EncryptedMobileCaptureStore {
  pairing: MobileCapturePairing | undefined;
  captures: MobileCapture[] = [];
  options = { projects: [] as { id: string; name: string }[], tags: [] as string[],
    reminders: [] as { id: string; label: string; offsetMinutes: number }[] };

  async loadPairing() { return this.pairing; }
  async savePairing(pairing: MobileCapturePairing) { this.pairing = pairing; }
  async listCaptures() { return structuredClone(this.captures); }
  async saveCapture(capture: MobileCapture) {
    this.captures = [...this.captures.filter(({ id }) => id !== capture.id), structuredClone(capture)];
  }
  async removeCapture(id: string) { this.captures = this.captures.filter((capture) => capture.id !== id); }
  async loadOptions() { return structuredClone(this.options); }
  async saveOptions(options: typeof this.options) { this.options = structuredClone(options); }
}

class MobileProtocolDatabase implements DatabaseProbe, MobileCaptureRepository {
  readonly notes = new Map<string, NoteRecord>();
  readonly receipts = new Map<string, { noteId: string; payloadDigest: string }>();
  failure: Error | undefined;

  async verifyConnection() {}
  async close() {}
  async findPortableMemberIdentity(memberId: string) {
    return memberId === "ada" ? { localAccountId: "ada", displayName: "Ada Lovelace" } : undefined;
  }
  async listMobileCaptureOptions(memberId: string, requestedWorkspaceId: string) {
    return memberId === "ada" && requestedWorkspaceId === workspaceId
      ? { status: "found" as const, projects: [{ id: projectId, name: "Launch" }], tags: ["mobile"] }
      : { status: "workspace_forbidden" as const };
  }
  async createMobileCapture(memberId: string, clientCaptureId: string, payloadDigest: string, note: NoteRecord, projection: PortableNoteProjection) {
    if (this.failure) throw this.failure;
    const existing = this.receipts.get(clientCaptureId);
    if (existing) return existing.payloadDigest === payloadDigest
      ? { status: "duplicate" as const, noteId: existing.noteId }
      : { status: "conflict" as const };
    if (memberId !== "ada" || note.workspaceId !== workspaceId) return { status: "workspace_forbidden" as const };
    if (note.projectId && note.projectId !== projectId) return { status: "project_forbidden" as const };
    this.notes.set(note.id, note);
    this.receipts.set(clientCaptureId, { noteId: note.id, payloadDigest });
    return { status: "created" as const, noteId: note.id };
  }
}

const access: MemberAccessResolver = {
  async authenticateBearer(value) {
    return value === "Bearer member-ada" ? { accountId: "ada", sessionId: "session-ada" } : undefined;
  },
};

describe("offline mobile capture synchronization", () => {
  let instance: RunningInstance | undefined;
  afterEach(async () => { await instance?.close(); instance = undefined; });

  async function run() {
    const database = new MobileProtocolDatabase();
    instance = await startInstance({
      database, host: "127.0.0.1", port: 0, instanceAdminToken: "admin",
      mobileCaptures: new MobileCaptureService(database), memberAccess: access,
    });
    return { database, baseUrl: instance.url };
  }

  it("queues text offline, retries, and treats duplicate delivery as one Note", async () => {
    const { database, baseUrl } = await run();
    const store = new MemoryEncryptedStore();
    let online = false;
    const client = new MobileCaptureClient(store, async (input, init) => {
      if (!online) throw new TypeError("Network request failed");
      return fetch(input, init);
    }, { allowInsecureInstanceForTest: true });
    await client.pair({ instanceUrl: baseUrl, memberToken: "member-ada", workspaceId });
    online = true;
    assert.deepEqual(await client.refreshOptions(), {
      projects: [{ id: projectId, name: "Launch" }], tags: ["mobile"],
      reminders: [{ id: "hour", label: "In one hour", offsetMinutes: 60 },
        { id: "tomorrow", label: "Tomorrow", offsetMinutes: 1_440 },
        { id: "week", label: "In one week", offsetMinutes: 10_080 }],
    });
    online = false;

    const queued = await client.captureText("Follow up after the retrospective.");
    assert.equal((await client.outbox()).length, 1);
    assert.equal((await client.sync()).status, "offline");
    assert.equal((await client.outbox()).length, 1);

    online = true;
    database.failure = new Error("temporarily unavailable");
    let connectivityListener: ((online: boolean) => void) | undefined;
    let scheduledRetry: (() => void) | undefined;
    let retryObserved!: () => void;
    const retryPending = new Promise<void>((resolve) => { retryObserved = resolve; });
    const synchronized = new Promise<ReturnType<typeof client.sync> extends Promise<infer T> ? T : never>((resolve) => {
      client.watchConnectivity(
        (listener) => { connectivityListener = listener; return () => undefined; },
        (result) => { if (result.status === "retry_pending") retryObserved(); else if (result.status === "synced") resolve(result); },
        (task) => { scheduledRetry = task; return () => { scheduledRetry = undefined; }; },
      );
    });
    connectivityListener!(true);
    await retryPending;
    assert.equal((await client.outbox()).length, 1);
    database.failure = undefined;
    scheduledRetry!();
    assert.equal((await synchronized).status, "synced");
    assert.equal((await client.outbox()).length, 0);
    assert.equal(database.notes.size, 1);

    await store.saveCapture(queued);
    assert.equal((await client.sync()).status, "synced");
    assert.equal(database.notes.size, 1);
    assert.equal((await client.outbox()).length, 0);
  });

  it("accepts a semantic duplicate despite a different creation timestamp", async () => {
    const { database, baseUrl } = await run();
    const id = "44444444-4444-4444-8444-444444444444";
    const body = { protocol: "stash.mobile-capture.v1", id, kind: "text", content: "  Same thought  ",
      tags: [" mobile ", "mobile"], createdAt: "2026-08-22T08:00:00+02:00" };
    const first = await fetch(`${baseUrl}/api/mobile/v1/workspaces/${workspaceId}/captures`, {
      method: "POST", headers: { authorization: "Bearer member-ada", "content-type": "application/json" }, body: JSON.stringify(body),
    });
    assert.equal(first.status, 201);

    const duplicate = await fetch(`${baseUrl}/api/mobile/v1/workspaces/${workspaceId}/captures`, {
      method: "POST", headers: { authorization: "Bearer member-ada", "content-type": "application/json" },
      body: JSON.stringify({ ...body, content: "Same thought", tags: ["mobile"], createdAt: "2026-08-23T18:30:00-04:00" }),
    });
    assert.equal(duplicate.status, 200);
    assert.equal((await duplicate.json() as { status: string }).status, "duplicate");
    assert.equal(database.notes.size, 1);
  });

  it("returns a visible conflict and retains a reused capture ID with different content", async () => {
    const { baseUrl } = await run();
    const store = new MemoryEncryptedStore();
    const client = new MobileCaptureClient(store, fetch, { allowInsecureInstanceForTest: true });
    await client.pair({ instanceUrl: baseUrl, memberToken: "member-ada", workspaceId });
    const original = await client.captureText("Original thought");
    assert.equal((await client.sync()).status, "synced");

    await store.saveCapture({ ...original, content: "Different thought", attempts: 0 });
    const conflict = await client.sync();
    assert.deepEqual(conflict, { status: "attention_required", count: 0, error: "capture_conflict" });
    const [retained] = await client.outbox();
    assert.equal(retained?.id, original.id);
    assert.equal(retained?.attempts, 1);
    assert.match(retained?.lastError ?? "", /different payload/i);
  });

  it("captures checklists with cached structure and retains visible terminal failures", async () => {
    const { baseUrl } = await run();
    const store = new MemoryEncryptedStore();
    const client = new MobileCaptureClient(store, fetch, { allowInsecureInstanceForTest: true });
    await assert.rejects(() => client.pair({ instanceUrl: "http://stash.example", memberToken: "secret", workspaceId }), /HTTPS/);
    await client.pair({ instanceUrl: baseUrl, memberToken: "wrong", workspaceId });
    const cachedOptions = { projects: [{ id: projectId, name: "Launch" }], tags: ["mobile"],
      reminders: [{ id: "tomorrow", label: "Tomorrow", offsetMinutes: 1_440 }] };
    await client.cacheOptions(cachedOptions);
    assert.deepEqual(await client.options(), cachedOptions);
    await client.captureChecklist("Launch steps", ["Invite testers", "Publish notes"], { projectId, tags: ["mobile"] });

    const result = await client.sync();
    assert.equal(result.status, "attention_required");
    assert.equal(result.error, "unauthorized");
    const [retained] = await client.outbox();
    assert.equal(retained?.lastError, "A valid Member session is required.");

    await client.pair({ instanceUrl: baseUrl, memberToken: "member-ada", workspaceId });
    await store.saveCapture({ ...retained!, projectId: "33333333-3333-4333-8333-333333333333" });
    const forbidden = await client.sync();
    assert.equal(forbidden.status, "attention_required");
    assert.equal(forbidden.status === "attention_required" && forbidden.error, "workspace_forbidden");
    assert.match((await client.outbox())[0]!.lastError!, /cannot capture/i);

    await store.removeCapture(retained!.id);
    await store.saveCapture({ ...retained!, id: "invalid-client-id" });
    const invalid = await client.sync();
    assert.equal(invalid.status, "attention_required");
    assert.equal(invalid.status === "attention_required" && invalid.error, "invalid_input");
    assert.match((await client.outbox())[0]!.lastError!, /invalid/i);
  });
});
