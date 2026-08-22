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
import { EncryptedStateMobileCaptureStore, type CiphertextStateRepository, type MobileCipher } from "../mobile/src/encrypted-mobile-store.js";
import { presentMobileSyncResult } from "../mobile/src/sync-status.js";

const workspaceId = "11111111-1111-4111-8111-111111111111";
const projectId = "22222222-2222-4222-8222-222222222222";

class MemoryEncryptedStore implements EncryptedMobileCaptureStore {
  pairing: MobileCapturePairing | undefined;
  captures: MobileCapture[] = [];
  options = new Map<string, { projects: { id: string; name: string }[]; tags: string[];
    reminders: { id: string; label: string; offsetMinutes: number }[] }>();

  async loadPairing() { return this.pairing; }
  async savePairing(pairing: MobileCapturePairing) { this.pairing = pairing; }
  async listCaptures() { return structuredClone(this.captures); }
  async saveCapture(capture: MobileCapture) {
    this.captures = [...this.captures.filter(({ id }) => id !== capture.id), structuredClone(capture)];
  }
  async removeCapture(id: string) { this.captures = this.captures.filter((capture) => capture.id !== id); }
  async loadOptions(scope: string) { return structuredClone(this.options.get(scope) ?? { projects: [], tags: [], reminders: [] }); }
  async saveOptions(scope: string, options: { projects: { id: string; name: string }[]; tags: string[];
    reminders: { id: string; label: string; offsetMinutes: number }[] }) { this.options.set(scope, structuredClone(options)); }
}

class RecordingCiphertextRepository implements CiphertextStateRepository {
  readonly ciphertext = new Map<string, string>();
  async read(key: string) { return this.ciphertext.get(key); }
  async write(key: string, value: string) { this.ciphertext.set(key, value); }
}
const testCipher: MobileCipher = {
  async encrypt(value) { return Buffer.from([...value].reverse().join("")).toString("base64"); },
  async decrypt(value) { return [...Buffer.from(value, "base64").toString()].reverse().join(""); },
};

class MobileProtocolDatabase implements DatabaseProbe, MobileCaptureRepository {
  readonly notes = new Map<string, NoteRecord>();
  readonly receipts = new Map<string, { noteId: string; payloadDigest: string }>();
  failure: Error | undefined;
  failingContent: string | undefined;

  async verifyConnection() {}
  async close() {}
  async findPortableMemberIdentity(memberId: string) {
    return memberId === "ada" ? { localAccountId: "ada", displayName: "Ada Lovelace" }
      : memberId === "grace" ? { localAccountId: "grace", displayName: "Grace Hopper" } : undefined;
  }
  async listMobileCaptureOptions(memberId: string, requestedWorkspaceId: string) {
    return memberId === "ada" && requestedWorkspaceId === workspaceId
      ? { status: "found" as const, projects: [{ id: projectId, name: "Launch" }], tags: ["mobile"] }
      : memberId === "grace" && requestedWorkspaceId === workspaceId
        ? { status: "found" as const, projects: [], tags: [] }
      : { status: "workspace_forbidden" as const };
  }
  async createMobileCapture(memberId: string, clientCaptureId: string, payloadDigest: string, note: NoteRecord, projection: PortableNoteProjection) {
    if (this.failure) throw this.failure;
    if (this.failingContent && note.content.includes(this.failingContent)) throw new Error("temporarily unavailable");
    const existing = this.receipts.get(clientCaptureId);
    if (existing) return existing.payloadDigest === payloadDigest
      ? { status: "duplicate" as const, noteId: existing.noteId }
      : { status: "conflict" as const };
    if ((memberId !== "ada" && memberId !== "grace") || note.workspaceId !== workspaceId) return { status: "workspace_forbidden" as const };
    if (note.projectId && note.projectId !== projectId) return { status: "project_forbidden" as const };
    this.notes.set(note.id, note);
    this.receipts.set(clientCaptureId, { noteId: note.id, payloadDigest });
    return { status: "created" as const, noteId: note.id };
  }
}

const access: MemberAccessResolver = {
  async authenticateBearer(value) {
    if (value === "Bearer member-ada" || value === "Bearer member-ada-rotated") return { accountId: "ada", sessionId: "session-ada" };
    return value === "Bearer member-grace" ? { accountId: "grace", sessionId: "session-grace" } : undefined;
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
    const ciphertext = new RecordingCiphertextRepository();
    const store = new EncryptedStateMobileCaptureStore(ciphertext, testCipher);
    let online = false;
    let now = Date.parse("2026-08-22T10:00:00Z");
    const client = new MobileCaptureClient(store, async (input, init) => {
      if (!online) throw new TypeError("Network request failed");
      return fetch(input, init);
    }, { allowInsecureInstanceForTest: true, now: () => now });
    online = true;
    await client.pair({ instanceUrl: baseUrl, memberToken: "member-ada", workspaceId });
    assert.deepEqual(await client.refreshOptions(), {
      projects: [{ id: projectId, name: "Launch" }], tags: ["mobile"],
      reminders: [{ id: "hour", label: "In one hour", offsetMinutes: 60 },
        { id: "tomorrow", label: "Tomorrow", offsetMinutes: 1_440 },
        { id: "week", label: "In one week", offsetMinutes: 10_080 }],
    });
    assert.doesNotMatch([...ciphertext.ciphertext.values()].join(" "), /Launch|mobile|member-ada/);
    online = false;

    const queued = await client.captureText("Follow up after the retrospective.");
    assert.doesNotMatch([...ciphertext.ciphertext.values()].join(" "), /retrospective/);
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
    now += 1_000;
    scheduledRetry!();
    assert.equal((await synchronized).status, "synced");
    assert.equal((await client.outbox()).length, 0);
    assert.equal(database.notes.size, 1);

    await store.saveCapture(queued);
    assert.equal((await client.sync()).status, "synced");
    assert.equal(database.notes.size, 1);
    assert.equal((await client.outbox()).length, 0);
  });

  it("rejects a reused capture ID when its creation timestamp changes", async () => {
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
    assert.equal(duplicate.status, 409);
    assert.equal((await duplicate.json() as { error: string }).error, "capture_conflict");
    assert.equal(database.notes.size, 1);
  });

  it("retains an offline capture for its originating Instance when pairing changes", async () => {
    const { database, baseUrl } = await run();
    const store = new MemoryEncryptedStore();
    const requestedUrls: string[] = [];
    const client = new MobileCaptureClient(store, async (input, init) => {
      requestedUrls.push(String(input));
      return fetch(input, init);
    }, { allowInsecureInstanceForTest: true });
    await client.pair({ instanceUrl: baseUrl, memberToken: "member-ada", workspaceId });
    const queued = await client.captureText("Belongs only to Instance A");
    requestedUrls.length = 0;

    const otherWorkspaceId = "99999999-9999-4999-8999-999999999999";
    await store.savePairing({ instanceUrl: "https://instance-b.example", memberToken: "member-b",
      workspaceId: otherWorkspaceId, memberId: "member-b" });
    const retained = await client.sync();

    assert.deepEqual(retained, { status: "attention_required", count: 0, error: "capture_pairing_mismatch" });
    assert.deepEqual(requestedUrls, []);
    assert.equal(database.notes.size, 0);
    assert.deepEqual(await client.outbox(), []);
    assert.equal((await store.listCaptures())[0]?.id, queued.id);

    await client.pair({ instanceUrl: baseUrl, memberToken: "member-ada", workspaceId });
    assert.equal((await client.outbox())[0]?.id, queued.id);
    assert.deepEqual(await client.sync(), { status: "synced", count: 1 });
    assert.equal(database.notes.size, 1);
    assert.equal((await client.outbox()).length, 0);
  });

  it("does not submit or expose cached options across Member pairings at the same destination", async () => {
    const { database, baseUrl } = await run();
    const store = new MemoryEncryptedStore();
    let requests = 0;
    const client = new MobileCaptureClient(store, async (input, init) => { requests += 1; return fetch(input, init); },
      { allowInsecureInstanceForTest: true });
    await client.pair({ instanceUrl: baseUrl, memberToken: "member-ada", workspaceId });
    await client.cacheOptions({ projects: [{ id: projectId, name: "Ada private" }], tags: ["ada"], reminders: [] });
    await client.captureText("Ada private capture");

    await client.pair({ instanceUrl: baseUrl, memberToken: "member-grace", workspaceId });
    const graceOptions = { projects: [], tags: [], reminders: [
      { id: "hour", label: "In one hour", offsetMinutes: 60 },
      { id: "tomorrow", label: "Tomorrow", offsetMinutes: 1_440 },
      { id: "week", label: "In one week", offsetMinutes: 10_080 },
    ] };
    assert.deepEqual(await client.options(), graceOptions);
    assert.deepEqual(await client.outbox(), []);
    const gracePairing = await store.loadPairing();
    await store.savePairing({ ...gracePairing!, memberToken: "revoked-grace" });
    await assert.rejects(() => client.refreshOptions(), /valid Member session/i);
    assert.deepEqual(await client.options(), graceOptions);
    assert.deepEqual(await client.sync(), { status: "attention_required", count: 0, error: "capture_pairing_mismatch" });
    assert.deepEqual(await client.outbox(), []);
    assert.equal(database.notes.size, 0);

    await client.pair({ instanceUrl: baseUrl, memberToken: "member-ada-rotated", workspaceId });
    assert.deepEqual(await client.options(), { projects: [{ id: projectId, name: "Launch" }], tags: ["mobile"],
      reminders: [{ id: "hour", label: "In one hour", offsetMinutes: 60 },
        { id: "tomorrow", label: "Tomorrow", offsetMinutes: 1_440 },
        { id: "week", label: "In one week", offsetMinutes: 10_080 }] });
    assert.deepEqual(await client.sync(), { status: "synced", count: 1 });
  });

  it("authenticates and adopts a legacy destination-bound capture without guessing across Members", async () => {
    const { database, baseUrl } = await run();
    const store = new MemoryEncryptedStore();
    await store.savePairing({ instanceUrl: baseUrl, memberToken: "member-ada", workspaceId });
    const legacy: MobileCapture = { id: "55555555-5555-4555-8555-555555555555", kind: "text",
      content: "Legacy offline thought", createdAt: "2026-08-22T10:00:00.000Z", attempts: 0,
      origin: { instanceUrl: baseUrl, workspaceId } };
    await store.saveCapture(legacy);
    const client = new MobileCaptureClient(store, fetch, { allowInsecureInstanceForTest: true });

    await client.pair({ instanceUrl: baseUrl, memberToken: "member-ada", workspaceId });

    const [adopted] = await client.outbox();
    assert.equal(adopted?.id, legacy.id);
    assert.equal(adopted?.origin?.memberId, "ada");
    assert.deepEqual(await client.sync(), { status: "synced", count: 1 });
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
    await client.pair({ instanceUrl: baseUrl, memberToken: "member-ada", workspaceId });
    const cachedOptions = { projects: [{ id: projectId, name: "Launch" }], tags: ["mobile"],
      reminders: [{ id: "tomorrow", label: "Tomorrow", offsetMinutes: 1_440 }] };
    await client.cacheOptions(cachedOptions);
    assert.deepEqual(await client.options(), cachedOptions);
    await client.captureChecklist("Launch steps", ["Invite testers", "Publish notes"], { projectId, tags: ["mobile"] });
    const authenticatedPairing = await store.loadPairing();
    await store.savePairing({ ...authenticatedPairing!, memberToken: "wrong" });

    const result = await client.sync();
    assert.equal(result.status, "attention_required");
    assert.equal(result.error, "unauthorized");
    const [retained] = await client.outbox();
    assert.equal(retained?.lastError, "A valid Member session is required.");

    await client.pair({ instanceUrl: baseUrl, memberToken: "member-ada", workspaceId });
    await store.removeCapture(retained!.id);
    const validPairingCapture = await client.captureChecklist("Launch steps", ["Invite testers", "Publish notes"],
      { projectId: "33333333-3333-4333-8333-333333333333", tags: ["mobile"] });
    const forbidden = await client.sync();
    assert.equal(forbidden.status, "attention_required");
    assert.equal(forbidden.status === "attention_required" && forbidden.error, "workspace_forbidden");
    assert.match((await client.outbox())[0]!.lastError!, /cannot capture/i);

    await store.removeCapture(validPairingCapture.id);
    await store.saveCapture({ ...validPairingCapture, id: "invalid-client-id" });
    const invalid = await client.sync();
    assert.equal(invalid.status, "attention_required");
    assert.equal(invalid.status === "attention_required" && invalid.error, "invalid_input");
    assert.match((await client.outbox())[0]!.lastError!, /invalid/i);
  });

  it("retains a rejected capture without blocking a later valid capture", async () => {
    const { database, baseUrl } = await run();
    const store = new MemoryEncryptedStore();
    const client = new MobileCaptureClient(store, fetch, { allowInsecureInstanceForTest: true });
    await client.pair({ instanceUrl: baseUrl, memberToken: "member-ada", workspaceId });
    const rejected = await client.captureText("Keep this visible", {
      projectId: "33333333-3333-4333-8333-333333333333",
    });
    await client.captureText("This one should synchronize");

    const result = await client.sync();

    assert.equal(result.status, "attention_required");
    assert.equal(result.count, 1);
    assert.equal(database.notes.size, 1);
    assert.deepEqual((await client.outbox()).map(({ id }) => id), [rejected.id]);
    assert.match((await client.outbox())[0]!.lastError!, /cannot capture/i);
    assert.match(presentMobileSyncResult(result, await client.outbox()), /cannot capture/i);
  });

  it("backs off a retriable first capture while synchronizing later eligible captures", async () => {
    const { database, baseUrl } = await run();
    const store = new MemoryEncryptedStore();
    let now = Date.parse("2026-08-22T10:00:00Z");
    const client = new MobileCaptureClient(store, fetch, { allowInsecureInstanceForTest: true, now: () => now });
    await client.pair({ instanceUrl: baseUrl, memberToken: "member-ada", workspaceId });
    const first = await client.captureText("Persistently failing");
    await client.captureText("Later succeeds");
    database.failingContent = "Persistently failing";

    const partial = await client.sync();
    assert.deepEqual(partial, { status: "retry_pending", count: 1 });
    assert.equal(database.notes.size, 1);
    const [retained] = await client.outbox();
    assert.equal(retained?.id, first.id);
    assert.equal(retained?.attempts, 1);
    assert.equal(retained?.nextRetryAt, "2026-08-22T10:00:01.000Z");

    database.failingContent = undefined;
    assert.deepEqual(await client.sync(), { status: "retry_pending", count: 0 });
    assert.equal(database.notes.size, 1);
    now += 1_000;
    assert.deepEqual(await client.sync(), { status: "synced", count: 1 });
    assert.equal(database.notes.size, 2);
    assert.equal((await client.outbox()).length, 0);
  });

  it("aborts an in-flight synchronization and suppresses callbacks after cleanup", async () => {
    const store = new MemoryEncryptedStore();
    const pairing = { instanceUrl: "https://stash.example", memberToken: "member-ada", workspaceId, memberId: "ada" };
    await store.savePairing(pairing);
    await store.saveCapture({ id: "44444444-4444-4444-8444-444444444444", kind: "text", content: "Wait",
      createdAt: new Date().toISOString(), attempts: 0,
      origin: { instanceUrl: "https://stash.example", workspaceId, memberId: pairing.memberId } });
    let requestSignal: AbortSignal | undefined;
    const client = new MobileCaptureClient(store, async (_input, init) => {
      requestSignal = init?.signal ?? undefined;
      return new Promise<Response>((_resolve, reject) => requestSignal!.addEventListener("abort", () => reject(requestSignal!.reason)));
    });
    let listener: ((online: boolean) => void) | undefined;
    let callbacks = 0;
    const cleanup = client.watchConnectivity(
      (next) => { listener = next; return () => undefined; },
      () => { callbacks += 1; },
    );
    listener!(true);
    await new Promise((resolve) => setImmediate(resolve));

    cleanup();
    await new Promise((resolve) => setImmediate(resolve));

    assert.equal(requestSignal?.aborted, true);
    assert.equal(callbacks, 0);
    assert.equal((await store.listCaptures()).length, 1);
  });

  it("joins concurrent sync triggers without cancelling an options refresh", async () => {
    const store = new MemoryEncryptedStore();
    const pairing = { instanceUrl: "https://stash.example", memberToken: "member-ada", workspaceId, memberId: "ada" };
    await store.savePairing(pairing);
    await store.saveCapture({ id: "44444444-4444-4444-8444-444444444444", kind: "text", content: "Wait",
      createdAt: "2026-08-22T10:00:00.000Z", attempts: 0,
      origin: { instanceUrl: "https://stash.example", workspaceId, memberId: pairing.memberId } });
    let refreshSignal: AbortSignal | undefined;
    let syncRequests = 0;
    let resolveRefresh!: (response: Response) => void;
    let resolveSync!: (response: Response) => void;
    const client = new MobileCaptureClient(store, async (input, init) => {
      if (String(input).endsWith("capture-options")) {
        refreshSignal = init?.signal ?? undefined;
        return new Promise<Response>((resolve) => { resolveRefresh = resolve; });
      }
      syncRequests += 1;
      return new Promise<Response>((resolve) => { resolveSync = resolve; });
    });

    const refresh = client.refreshOptions();
    await new Promise((resolve) => setImmediate(resolve));
    const first = client.sync();
    const joined = client.sync();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(first, joined);
    assert.equal(syncRequests, 1);
    assert.equal(refreshSignal?.aborted, false);
    resolveRefresh(new Response(JSON.stringify({ memberId: "ada", projects: [], tags: [], reminders: [] }), { status: 200 }));
    resolveSync(new Response(JSON.stringify({ status: "created" }), { status: 201 }));
    await refresh;
    assert.deepEqual(await first, { status: "synced", count: 1 });
  });
});
