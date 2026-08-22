import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";

import { startInstance, type DatabaseProbe, type RunningInstance } from "../src/instance.js";
import { AttachmentService, type AttachmentRecord, type AttachmentRepository, type AttachmentStorage, type PortableAttachmentProjection } from "../src/attachments.js";
import {
  MobileCaptureClient,
  LegacyRecoveryRequired,
  type EncryptedMobileCaptureStore,
  type MobileCapture,
  type MobileCaptureOptions,
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
import {
  ensureCaptureOptionsReady,
  loadCachedOptionsOnFocus,
  reconcileCaptureSelections,
} from "../mobile/src/capture-options-focus.js";
import { IncomingCaptureDeliveryGate, parseIncomingCapture } from "../mobile/src/incoming-capture.js";
import { IncomingShareDeliveryBatch, SerializedIncomingShareDrain, drainIncomingShares, incomingShareFingerprint } from "../mobile/src/incoming-share-deliveries.js";
import { MAX_ATTACHMENT_BYTES, readBoundedOriginal } from "../mobile/src/media-input.js";

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
  incomingShares: import("../src/mobile-capture-client.js").IncomingShareDelivery[] = [];
  nativeShare: { fingerprint: string; ids: string[] } | undefined;
  async stageIncomingShares(fingerprint: string, deliveries: import("../src/mobile-capture-client.js").IncomingShareDelivery[]) {
    if (this.nativeShare?.fingerprint !== fingerprint) {
      this.incomingShares.push(...structuredClone(deliveries)); this.nativeShare = { fingerprint, ids: deliveries.map(({ id }) => id) };
    }
    return structuredClone(this.incomingShares.filter(({ id }) => this.nativeShare!.ids.includes(id)));
  }
  async acknowledgeNativeShares(fingerprint?: string) { if (!fingerprint || this.nativeShare?.fingerprint === fingerprint) this.nativeShare = undefined; }
  async listIncomingShares() { return structuredClone(this.incomingShares); }
  async removeIncomingShare(id: string) { this.incomingShares = this.incomingShares.filter((item) => item.id !== id); }
  async saveIncomingShare(delivery: import("../src/mobile-capture-client.js").IncomingShareDelivery) {
    this.incomingShares = [...this.incomingShares.filter(({ id }) => id !== delivery.id), structuredClone(delivery)];
  }
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

class MemoryAttachmentStorage implements AttachmentStorage {
  readonly content = new Map<string, Buffer>();
  async put(key: string, content: Buffer) { this.content.set(key, Buffer.from(content)); }
  async get(key: string) { const content = this.content.get(key); if (!content) throw new Error("missing"); return Buffer.from(content); }
  async delete(key: string) { this.content.delete(key); }
}

class MobileProtocolDatabase implements DatabaseProbe, MobileCaptureRepository, AttachmentRepository {
  readonly notes = new Map<string, NoteRecord>();
  readonly receipts = new Map<string, { noteId: string; payloadDigest: string }>();
  readonly attachments = new Map<string, AttachmentRecord>();
  readonly attachmentReceipts = new Map<string, { digest: string; record: AttachmentRecord; projection: PortableAttachmentProjection }>();
  failure: Error | undefined;
  failingContent: string | undefined;

  async verifyConnection() {}
  async close() {}
  async findPortableMemberIdentity(memberId: string) {
    return memberId === "ada" ? { localAccountId: "ada", displayName: "Ada Lovelace" }
      : memberId === "grace" ? { localAccountId: "grace", displayName: "Grace Hopper" } : undefined;
  }
  async canCreateAttachment(memberId: string, requestedWorkspaceId: string) {
    return (memberId === "ada" || memberId === "grace") && requestedWorkspaceId === workspaceId;
  }
  async findAttachmentReceipt(memberId: string, requestedWorkspaceId: string, operationKey: string) {
    return await this.canCreateAttachment(memberId, requestedWorkspaceId) ? this.attachmentReceipts.get(operationKey) : undefined;
  }
  async createAttachment(memberId: string, record: AttachmentRecord, projection: PortableAttachmentProjection,
    operation?: { key: string; digest: string }) {
    if (!await this.canCreateAttachment(memberId, record.workspaceId)) return { status: "workspace_forbidden" as const };
    if (operation) {
      const existing = this.attachmentReceipts.get(operation.key);
      if (existing) return existing.digest === operation.digest ? { status: "duplicate" as const, ...existing } : { status: "conflict" as const };
    }
    this.attachments.set(record.id, record);
    if (operation) this.attachmentReceipts.set(operation.key, { digest: operation.digest, record, projection });
    return { status: "created" as const };
  }
  async findAttachmentForMember(memberId: string, attachmentId: string) {
    return memberId === "ada" || memberId === "grace" ? this.attachments.get(attachmentId) : undefined;
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
  it("rejects an oversized original before base64 materialization", async () => {
    let reads = 0;
    await assert.rejects(() => readBoundedOriginal({ size: MAX_ATTACHMENT_BYTES + 1, async base64() { reads += 1; return "YQ=="; } }),
      /larger than the 10 MB limit/);
    assert.equal(reads, 0);
  });

  it("keeps stable per-item share delivery receipts across a partial batch retry", () => {
    const ids = ["11111111-1111-4111-8111-111111111111", "22222222-2222-4222-8222-222222222222",
      "33333333-3333-4333-8333-333333333333"];
    const batch = new IncomingShareDeliveryBatch(() => ids.shift()!);
    const payloads = [{ shareType: "text", value: "saved" }, { shareType: "file", value: "file://retry" }];
    const first = batch.receiveInvocation(payloads);
    assert.equal(batch.acknowledge(first[0]!.id), false);
    assert.deepEqual(batch.pending(), [first[1]]);
    assert.equal(batch.acknowledge(first[1]!.id), true);
    assert.notEqual(batch.receiveInvocation(payloads)[0]!.id, first[0]!.id, "a later identical user action gets a fresh delivery ID");
  });

  it("captures interleaved OS invocations exactly once while an older item awaits retry", async () => {
    let sequence = 0;
    const batch = new IncomingShareDeliveryBatch(() => `00000000-0000-4000-8000-${String(++sequence).padStart(12, "0")}`);
    const store = new MemoryEncryptedStore();
    store.pairing = { instanceUrl: "https://stash.example", memberToken: "token", workspaceId, memberId: "ada" };
    const client = new MobileCaptureClient(store, async () => new Response());
    const [savedA, failedA] = batch.receiveInvocation([
      { shareType: "text", value: "A saved" }, { shareType: "file", value: "file://A-retry" },
    ]);
    await client.captureSharedContent(savedA!.payload.value, "share_sheet", {}, savedA!.id);
    batch.acknowledge(savedA!.id);
    const pending = batch.receiveInvocation([{ shareType: "text", value: "A saved" }]);
    const invocationB = pending.at(-1)!;
    assert.notEqual(invocationB.id, savedA!.id, "identical content from invocation B has its own delivery identity");
    await client.captureSharedContent(invocationB.payload.value, "share_sheet", {}, invocationB.id);
    batch.acknowledge(invocationB.id);
    assert.deepEqual(batch.pending(), [failedA]);
    await client.captureMedia({ kind: "file", filename: "A-retry.txt", contentType: "text/plain", base64: "cmVjb3ZlcmVk" }, "", {}, failedA!.id);
    assert.equal(batch.acknowledge(failedA!.id), true);
    assert.deepEqual(batch.pending(), []);
    assert.deepEqual(store.captures.map(({ id }) => id), [savedA!.id, invocationB.id, failedA!.id]);
  });

  it("encrypts a native share inbox before acknowledgement and resumes it after restart", async () => {
    const repository = new RecordingCiphertextRepository();
    const firstStore = new EncryptedStateMobileCaptureStore(repository, testCipher);
    const payload = { shareType: "text", value: "survive restart" };
    const fingerprint = incomingShareFingerprint([payload]);
    const original = [{ id: "11111111-1111-4111-8111-111111111111", payload }];
    await firstStore.stageIncomingShares(fingerprint, original);
    assert.doesNotMatch([...repository.ciphertext.values()].join(" "), /survive restart/);
    const restartedStore = new EncryptedStateMobileCaptureStore(repository, testCipher);
    assert.deepEqual(await restartedStore.listIncomingShares(), original);
    const replay = await restartedStore.stageIncomingShares(fingerprint,
      [{ id: "22222222-2222-4222-8222-222222222222", payload }]);
    assert.deepEqual(replay, original, "restart reuses the durable delivery identity before native acknowledgement");
    await restartedStore.acknowledgeNativeShares(fingerprint);
  });

  it("reruns a serialized drain when B is staged while A is awaiting a failed write", async () => {
    const pending = ["A"];
    const captured: string[] = [];
    let release!: () => void;
    const paused = new Promise<void>((resolve) => { release = resolve; });
    let attempts = 0;
    const errors: unknown[] = [];
    const drain = new SerializedIncomingShareDrain(async () => {
      attempts += 1;
      if (attempts === 1) { await paused; throw new Error("temporary encrypted write failure"); }
      while (pending.length) captured.push(pending.shift()!);
    }, (error) => errors.push(error));
    const running = drain.request();
    pending.push("B");
    const joined = drain.request();
    release();
    await Promise.all([running, joined]);
    assert.deepEqual(captured, ["A", "B"]);
    assert.equal(errors.length, 1);
    assert.equal(attempts, 2);
  });

  it("quarantines permanent A without blocking B and requires explicit removal", async () => {
    const store = new MemoryEncryptedStore();
    store.incomingShares = [
      { id: "11111111-1111-4111-8111-111111111111", payload: { shareType: "file", value: "A" } },
      { id: "22222222-2222-4222-8222-222222222222", payload: { shareType: "text", value: "B" } },
    ];
    const captured: string[] = [];
    await drainIncomingShares(store, async ({ payload }) => {
      if (payload.value === "A") throw new Error("The original file type is not supported.");
      captured.push(payload.value);
    });
    assert.deepEqual(captured, ["B"]);
    assert.equal(store.incomingShares[0]?.status, "quarantined");
    await store.removeIncomingShare(store.incomingShares[0]!.id);
    assert.deepEqual(await store.listIncomingShares(), []);
  });

  it("retains transient A while processing B and retries A on the next drain", async () => {
    const store = new MemoryEncryptedStore();
    store.incomingShares = [
      { id: "11111111-1111-4111-8111-111111111111", payload: { shareType: "file", value: "A" } },
      { id: "22222222-2222-4222-8222-222222222222", payload: { shareType: "text", value: "B" } },
    ];
    let unavailable = true;
    const captured: string[] = [];
    const consume = async ({ payload }: import("../src/mobile-capture-client.js").IncomingShareDelivery) => {
      if (payload.value === "A" && unavailable) throw new Error("The original could not be read right now.");
      captured.push(payload.value);
    };
    await drainIncomingShares(store, consume);
    assert.deepEqual(captured, ["B"]);
    assert.equal(store.incomingShares[0]?.status, "retry_pending");
    unavailable = false;
    await drainIncomingShares(store, consume);
    assert.deepEqual(captured, ["B", "A"]);
    assert.deepEqual(await store.listIncomingShares(), []);
  });
  let instance: RunningInstance | undefined;
  afterEach(async () => { await instance?.close(); instance = undefined; });

  async function run() {
    const database = new MobileProtocolDatabase();
    const attachmentStorage = new MemoryAttachmentStorage();
    instance = await startInstance({
      database, host: "127.0.0.1", port: 0, instanceAdminToken: "admin",
      mobileCaptures: new MobileCaptureService(database), attachments: new AttachmentService(database, attachmentStorage), memberAccess: access,
    });
    return { database, attachmentStorage, baseUrl: instance.url };
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

  it("retains an original photo offline, uploads it, and links the Workspace Attachment in the captured Note", async () => {
    const store = new MemoryEncryptedStore();
    await store.savePairing({ instanceUrl: "https://stash.example", memberToken: "member-ada", workspaceId, memberId: "ada" });
    const requests: { url: string; init?: RequestInit }[] = [];
    const client = new MobileCaptureClient(store, async (input, init) => {
      requests.push({ url: String(input), ...(init ? { init } : {}) });
      if (String(input).endsWith("/attachments")) return new Response(JSON.stringify({
        id: "77777777-7777-4777-8777-777777777777",
        portableLink: "[camera-original.jpg](<./attachments/77777777-7777-4777-8777-777777777777/camera-original.jpg>)",
      }), { status: 201, headers: { "content-type": "application/json" } });
      return new Response(JSON.stringify({ status: "created" }), { status: 201 });
    });

    const queued = await client.captureMedia({ kind: "photo", filename: "camera-original.jpg", contentType: "image/jpeg",
      base64: Buffer.from("original-camera-bytes").toString("base64") }, "Whiteboard sketch");
    assert.equal(queued.attachment?.base64, Buffer.from("original-camera-bytes").toString("base64"));

    assert.deepEqual(await client.sync(), { status: "synced", count: 1 });
    assert.equal(requests.length, 2);
    assert.match(requests[0]!.url, /\/api\/workspaces\/.+\/attachments$/);
    assert.equal(requests[0]!.init?.headers && (requests[0]!.init.headers as Record<string, string>)["x-stash-filename"],
      encodeURIComponent("camera-original.jpg"));
    assert.deepEqual(Buffer.from(await new Response(requests[0]!.init?.body).arrayBuffer()), Buffer.from("original-camera-bytes"));
    assert.match(String(requests[1]!.init?.body), /camera-original\.jpg/);
    assert.equal((await client.outbox()).length, 0);
  });

  it("synchronizes original media end to end through a running Instance", async () => {
    const { database, attachmentStorage, baseUrl } = await run();
    const store = new MemoryEncryptedStore();
    const client = new MobileCaptureClient(store, fetch, { allowInsecureInstanceForTest: true });
    await client.pair({ instanceUrl: baseUrl, memberToken: "member-ada", workspaceId });
    await client.captureMedia({ kind: "voice", filename: "decision.m4a", contentType: "audio/mp4",
      base64: Buffer.from("original voice bytes").toString("base64") }, "Architecture decision");

    assert.deepEqual(await client.sync(), { status: "synced", count: 1 });
    const [attachment] = database.attachments.values();
    const [note] = database.notes.values();
    assert.equal(attachment?.filename, "decision.m4a");
    assert.deepEqual(attachment && attachmentStorage.content.get(attachment.storageKey), Buffer.from("original voice bytes"));
    assert.match(note?.content ?? "", /Architecture decision[\s\S]+decision\.m4a/);
    assert.equal((await client.outbox()).length, 0);
  });

  it("keeps original media queued and exposes permission and validation failures", async () => {
    const store = new MemoryEncryptedStore();
    await store.savePairing({ instanceUrl: "https://stash.example", memberToken: "member-ada", workspaceId, memberId: "ada" });
    const client = new MobileCaptureClient(store, async () => new Response(JSON.stringify({
      error: "attachment_unavailable", message: "The Attachment could not be stored or retrieved. Try again.",
    }), { status: 503, headers: { "content-type": "application/json" } }));
    await assert.rejects(() => client.captureMedia({ kind: "file", filename: "../secret.txt", contentType: "text/plain", base64: "YQ==" }),
      /filename/i);
    const document = await client.captureMedia({ kind: "file", filename: "brief.docx",
      contentType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", base64: "ZG9j" });
    assert.equal(document.attachment?.contentType, "application/octet-stream");
    const photo = await client.captureMedia({ kind: "photo", filename: "original.heic", contentType: "image/heic", base64: "aGVpYw==" });
    assert.equal(photo.attachment?.contentType, "image/heic");
    await client.captureMedia({ kind: "voice", filename: "voice.m4a", contentType: "audio/mp4", base64: "dm9pY2U=" });
    assert.deepEqual(await client.sync(), { status: "retry_pending", count: 0 });
    assert.equal((await client.outbox()).find(({ kind }) => kind === "voice")?.attachment?.base64, "dm9pY2U=");
  });

  it("does not upload an original twice when Note synchronization retries", async () => {
    const store = new MemoryEncryptedStore();
    await store.savePairing({ instanceUrl: "https://stash.example", memberToken: "member-ada", workspaceId, memberId: "ada" });
    let now = Date.parse("2026-08-22T10:00:00Z");
    let uploads = 0; let noteAttempts = 0;
    const client = new MobileCaptureClient(store, async (input) => {
      if (String(input).endsWith("/attachments")) {
        uploads += 1;
        return new Response(JSON.stringify({ id: "77777777-7777-4777-8777-777777777777",
          portableLink: "[retry.m4a](<./attachments/77777777-7777-4777-8777-777777777777/retry.m4a>)" }), { status: 201 });
      }
      noteAttempts += 1;
      return new Response(JSON.stringify(noteAttempts === 1 ? { message: "Try again." } : { status: "created" }),
        { status: noteAttempts === 1 ? 503 : 201 });
    }, { now: () => now });
    await client.captureMedia({ kind: "voice", filename: "retry.m4a", contentType: "audio/mp4", base64: "dm9pY2U=" });

    assert.deepEqual(await client.sync(), { status: "retry_pending", count: 0 });
    assert.equal((await client.outbox())[0]?.attachment?.remote?.id, "77777777-7777-4777-8777-777777777777");
    now += 1_000;
    assert.deepEqual(await client.sync(), { status: "synced", count: 1 });
    assert.equal(uploads, 1);
  });

  it("recovers an Attachment after its committed upload response is lost", async () => {
    const { database, attachmentStorage, baseUrl } = await run();
    const store = new MemoryEncryptedStore();
    let loseUploadResponse = true;
    const client = new MobileCaptureClient(store, async (input, init) => {
      const response = await fetch(input, init);
      if (loseUploadResponse && String(input).endsWith("/attachments")) {
        loseUploadResponse = false;
        await response.arrayBuffer();
        throw new TypeError("connection closed after commit");
      }
      return response;
    }, { allowInsecureInstanceForTest: true });
    await client.pair({ instanceUrl: baseUrl, memberToken: "member-ada", workspaceId });
    await client.captureMedia({ kind: "photo", filename: "lost.jpg", contentType: "image/jpeg", base64: "b3JpZ2luYWw=" });

    assert.deepEqual(await client.sync(), { status: "offline", count: 0 });
    assert.equal(database.attachments.size, 1);
    assert.equal(attachmentStorage.content.size, 1);
    assert.deepEqual(await client.sync(), { status: "synced", count: 1 });
    assert.equal(database.attachments.size, 1);
    assert.equal(attachmentStorage.content.size, 1);
    assert.equal((await client.outbox()).length, 0);
  });

  it("queues shared text, URLs, and widget input through their observable source", async () => {
    const store = new MemoryEncryptedStore();
    await store.savePairing({ instanceUrl: "https://stash.example", memberToken: "member-ada", workspaceId, memberId: "ada" });
    const client = new MobileCaptureClient(store, async () => { throw new TypeError("offline"); });
    await client.captureSharedContent("https://example.com/reference", "share_sheet");
    await client.captureSharedContent("Call Grace", "widget");
    const captures = await client.outbox();
    assert.deepEqual(captures.map(({ content, source }) => ({ content, source })), [
      { content: "https://example.com/reference", source: "share_sheet" },
      { content: "Call Grace", source: "widget" },
    ]);
    assert.deepEqual(parseIncomingCapture("stash://capture?source=share_sheet&content=https%3A%2F%2Fexample.com%2Freference"),
      { kind: "capture", capture: { content: "https://example.com/reference", source: "share_sheet" } });
    assert.deepEqual(parseIncomingCapture("stash://capture?source=widget&content=Call%20Grace"),
      { kind: "capture", capture: { content: "Call Grace", source: "widget" } });
    assert.deepEqual(parseIncomingCapture("https://evil.example/capture?source=widget&content=secret"), { kind: "ignored" });
    assert.deepEqual(parseIncomingCapture("stash://capture?source=widget"),
      { kind: "error", message: "Shared and widget captures require content." });
    assert.deepEqual(parseIncomingCapture(`stash://capture?source=widget&content=${"x".repeat(20_001)}`),
      { kind: "error", message: "Shared and widget captures cannot exceed 20,000 characters." });
  });

  it("suppresses only the immediate initial-link duplicate and allows repeated user actions", () => {
    const gate = new IncomingCaptureDeliveryGate();
    const url = "stash://capture?source=widget&content=Repeat";
    assert.equal(gate.accept(url, "initial", 1_000), true);
    assert.equal(gate.accept(url, "event", 1_100), false);
    assert.equal(gate.accept(url, "event", 1_200), true);
    assert.equal(gate.accept(url, "initial", 10_000), true);
    assert.equal(gate.accept(url, "event", 12_001), true);
    const reverse = new IncomingCaptureDeliveryGate();
    assert.equal(reverse.accept(url, "event", 20_000), true);
    assert.equal(reverse.accept(url, "initial", 20_100), false);
    assert.equal(reverse.accept(url, "event", 20_200), true, "later intentional event remains allowed");
  });

  it("preserves per-URL launch dedupe candidates across interleaved links", () => {
    const a = "stash://capture?source=widget&content=A";
    const b = "stash://capture?source=widget&content=B";
    const initialFirst = new IncomingCaptureDeliveryGate();
    assert.equal(initialFirst.accept(a, "initial", 1_000), true);
    assert.equal(initialFirst.accept(b, "event", 1_010), true);
    assert.equal(initialFirst.accept(a, "event", 1_020), false);
    const eventFirst = new IncomingCaptureDeliveryGate();
    assert.equal(eventFirst.accept(a, "event", 2_000), true);
    assert.equal(eventFirst.accept(b, "initial", 2_010), true);
    assert.equal(eventFirst.accept(a, "initial", 2_020), false);
    assert.equal(eventFirst.accept(a, "event", 5_000), true, "the same intentional action is allowed after the window");
  });

  it("bounds and expires unmatched deep-link candidates", () => {
    const gate = new IncomingCaptureDeliveryGate(100, 3);
    for (let index = 0; index < 20; index += 1) gate.accept(`stash://capture?source=widget&content=${index}`, "initial", index);
    assert.equal(gate.pendingCount(), 3);
    gate.accept("stash://capture?source=widget&content=fresh", "event", 1_000);
    assert.equal(gate.pendingCount(), 1, "expired candidates are pruned before accepting a new URL");
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

    assert.deepEqual(retained, { status: "synced", count: 0 });
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
    assert.deepEqual(await client.sync(), { status: "synced", count: 0 });
    assert.deepEqual(await client.outbox(), []);
    assert.equal(database.notes.size, 0);
    assert.deepEqual(await client.legacyRecoveryStatus(), { available: false, count: 0 });
    await assert.rejects(() => client.exportLegacyCaptures(), /legacy pairing/i);

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
      content: "Legacy offline thought", createdAt: "2026-08-22T10:00:00.000Z", attempts: 0 };
    await store.saveCapture(legacy);
    const client = new MobileCaptureClient(store, fetch, { allowInsecureInstanceForTest: true });

    await client.pair({ instanceUrl: baseUrl, memberToken: "member-ada", workspaceId });

    const [adopted] = await client.outbox();
    assert.equal(adopted?.id, legacy.id);
    assert.equal(adopted?.origin?.memberId, "ada");
    assert.deepEqual(await client.sync(), { status: "synced", count: 1 });
    assert.equal(database.notes.size, 1);
  });

  it("offers an explicit local export when a rotated credential cannot authenticate a legacy outbox", async () => {
    const { baseUrl } = await run();
    const store = new MemoryEncryptedStore();
    await store.savePairing({ instanceUrl: baseUrl, memberToken: "expired-ada", workspaceId });
    await store.saveCapture({ id: "66666666-6666-4666-8666-666666666666", kind: "text",
      content: "Recover this legacy thought", createdAt: "2026-08-22T10:00:00.000Z", attempts: 0 });
    const client = new MobileCaptureClient(store, fetch, { allowInsecureInstanceForTest: true });

    await assert.rejects(() => client.pair({ instanceUrl: baseUrl, memberToken: "member-ada-unknown-rotation", workspaceId }),
      /valid Member session/i);
    assert.deepEqual(await client.legacyRecoveryStatus(), { available: true, count: 1 });
    const exported = JSON.parse(await client.exportLegacyCaptures()) as { captures: MobileCapture[] };
    assert.equal(exported.captures[0]?.content, "Recover this legacy thought");
  });

  it("requires legacy recovery before a valid rotated credential replaces the unverified pairing", async () => {
    const { baseUrl } = await run();
    const store = new MemoryEncryptedStore();
    await store.savePairing({ instanceUrl: baseUrl, memberToken: "expired-ada", workspaceId });
    const legacy: MobileCapture = { id: "77777777-7777-4777-8777-777777777777", kind: "text",
      content: "Export before rotating", createdAt: "2026-08-22T10:00:00.000Z", attempts: 0 };
    await store.saveCapture(legacy);
    const client = new MobileCaptureClient(store, fetch, { allowInsecureInstanceForTest: true });
    const rotated = { instanceUrl: baseUrl, memberToken: "member-ada-rotated", workspaceId };

    await assert.rejects(() => client.pair(rotated), LegacyRecoveryRequired);
    assert.deepEqual(await client.legacyRecoveryStatus(), { available: true, count: 1 });
    assert.match(await client.exportLegacyCaptures(), /Export before rotating/);
    assert.equal((await store.loadPairing())?.memberId, undefined);

    client.acknowledgeLegacyRecoveryExport(false);
    await assert.rejects(() => client.pair(rotated, undefined, { replaceLegacy: true }), LegacyRecoveryRequired);
    assert.deepEqual(await client.legacyRecoveryStatus(), { available: true, count: 1 });
    client.acknowledgeLegacyRecoveryExport(true);
    await client.pair(rotated, undefined, { replaceLegacy: true });
    assert.deepEqual(await client.legacyRecoveryStatus(), { available: false, count: 0 });
    assert.deepEqual(await client.outbox(), []);
    assert.equal((await store.listCaptures())[0]?.id, legacy.id);
    assert.equal((await store.listCaptures())[0]?.origin?.memberId, undefined);
  });

  it("requires export before replacing a legacy pairing with a different authenticated destination", async () => {
    const { baseUrl } = await run();
    const store = new MemoryEncryptedStore();
    await store.savePairing({ instanceUrl: baseUrl, memberToken: "expired-ada", workspaceId });
    await store.saveCapture({ id: "88888888-8888-4888-8888-888888888888", kind: "text",
      content: "Instance A recovery", createdAt: "2026-08-22T10:00:00.000Z", attempts: 0 });
    const client = new MobileCaptureClient(store, async (input, init) => String(input).startsWith("https://instance-b.example/")
      ? new Response(JSON.stringify({ memberId: "member-b", projects: [], tags: [], reminders: [] }), { status: 200 })
      : fetch(input, init), { allowInsecureInstanceForTest: true });
    const destinationB = { instanceUrl: "https://instance-b.example", memberToken: "member-b-token",
      workspaceId: "99999999-9999-4999-8999-999999999999" };

    await assert.rejects(() => client.pair(destinationB), LegacyRecoveryRequired);
    assert.deepEqual(await client.legacyRecoveryStatus(), { available: true, count: 1 });
    assert.match(await client.exportLegacyCaptures(), /Instance A recovery/);
    client.acknowledgeLegacyRecoveryExport(true);
    await assert.rejects(() => client.pair({ ...destinationB, instanceUrl: "https://unavailable.example" }, undefined,
      { replaceLegacy: true }), /fetch failed|could not be authenticated/i);
    assert.deepEqual(await client.legacyRecoveryStatus(), { available: true, count: 1 });
    await assert.rejects(() => client.pair(destinationB, undefined, { replaceLegacy: true }), LegacyRecoveryRequired);
    client.acknowledgeLegacyRecoveryExport(true);
    await client.pair(destinationB, undefined, { replaceLegacy: true });
    assert.equal((await store.loadPairing())?.instanceUrl, destinationB.instanceUrl);
    assert.equal((await store.listCaptures()).length, 1);
  });

  it("returns a visible conflict and retains a reused capture ID with different content", async () => {
    const { baseUrl } = await run();
    const store = new MemoryEncryptedStore();
    const client = new MobileCaptureClient(store, fetch, { allowInsecureInstanceForTest: true });
    await client.pair({ instanceUrl: baseUrl, memberToken: "member-ada", workspaceId });
    await client.pair({ instanceUrl: baseUrl, memberToken: "member-grace", workspaceId });
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

  it("clears stale retry timing when a retried capture becomes terminal", async () => {
    const { baseUrl } = await run();
    const store = new MemoryEncryptedStore();
    let now = Date.parse("2026-08-22T10:00:00Z");
    let captureAttempts = 0;
    const client = new MobileCaptureClient(store, async (input, init) => {
      if (init?.method === "POST") {
        captureAttempts += 1;
        return captureAttempts === 1
          ? new Response(JSON.stringify({ error: "capture_unavailable", message: "Try later." }), { status: 503 })
          : new Response(JSON.stringify({ error: "invalid_input", message: "Fix this capture." }), { status: 422 });
      }
      return fetch(input, init);
    }, { allowInsecureInstanceForTest: true, now: () => now });
    await client.pair({ instanceUrl: baseUrl, memberToken: "member-ada", workspaceId });
    await client.captureText("Changes failure class");
    assert.equal((await client.sync()).status, "retry_pending");
    now += 1_000;
    assert.deepEqual(await client.sync(), { status: "attention_required", count: 0, error: "invalid_input" });
    const [terminal] = await client.outbox();
    assert.equal(terminal?.nextRetryAt, undefined);
    assert.equal(terminal?.lastError, "Fix this capture.");
  });

  it("reloads paired cached options on focus while the Instance is offline", async () => {
    const { baseUrl } = await run();
    const store = new MemoryEncryptedStore();
    let online = true;
    const client = new MobileCaptureClient(store, async (input, init) => {
      if (!online) throw new TypeError("Network request failed");
      return fetch(input, init);
    }, { allowInsecureInstanceForTest: true });
    await client.pair({ instanceUrl: baseUrl, memberToken: "member-ada", workspaceId });
    online = false;
    const focused = new Promise<MobileCaptureOptions>((resolve) => {
      loadCachedOptionsOnFocus(client, resolve);
    });
    const options = await focused;
    assert.deepEqual(options.projects, [{ id: projectId, name: "Launch" }]);
    assert.deepEqual(options.tags, ["mobile"]);
  });

  it("clears another pairing's structural selections on focus before offline capture", async () => {
    const { baseUrl } = await run();
    const store = new MemoryEncryptedStore();
    let online = true;
    const client = new MobileCaptureClient(store, async (input, init) => {
      if (!online) throw new TypeError("Network request failed");
      return fetch(input, init);
    }, { allowInsecureInstanceForTest: true });
    await client.pair({ instanceUrl: baseUrl, memberToken: "member-ada", workspaceId });
    await client.cacheOptions({
      projects: [{ id: projectId, name: "Launch" }],
      tags: ["mobile"],
      reminders: [{ id: "ada-only", label: "Ada only", offsetMinutes: 123 }],
    });
    const selections = { projectId, tag: "mobile", reminderOffset: 123 };
    assert.deepEqual(reconcileCaptureSelections(await client.options(), selections), selections);

    await client.pair({ instanceUrl: baseUrl, memberToken: "member-grace", workspaceId });
    online = false;
    const focused = new Promise<MobileCaptureOptions>((resolve) => { loadCachedOptionsOnFocus(client, resolve); });
    const graceOptions = await focused;
    const reconciled = reconcileCaptureSelections(graceOptions, selections);
    assert.deepEqual(reconciled, {});
    assert.deepEqual(reconcileCaptureSelections(graceOptions, { reminderOffset: 60 }), { reminderOffset: 60 });
    await client.captureText("Grace offline capture", {
      ...(reconciled.projectId ? { projectId: reconciled.projectId } : {}),
      ...(reconciled.tag ? { tags: [reconciled.tag] } : {}),
      ...(reconciled.reminderOffset ? { reminder: { at: new Date(Date.now() + reconciled.reminderOffset * 60_000).toISOString() } } : {}),
    });
    const [queued] = await client.outbox();
    assert.equal(queued?.projectId, undefined);
    assert.equal(queued?.tags, undefined);
    assert.equal(queued?.reminder, undefined);
  });

  it("gates capture synchronously while a new pairing's focused options are unresolved", async () => {
    const { baseUrl } = await run();
    const store = new MemoryEncryptedStore();
    const client = new MobileCaptureClient(store, fetch, { allowInsecureInstanceForTest: true });
    await client.pair({ instanceUrl: baseUrl, memberToken: "member-ada", workspaceId });
    let releaseOptions: (() => void) | undefined;
    const delayedClient = {
      options: () => new Promise<MobileCaptureOptions>((resolve) => {
        releaseOptions = () => { void client.options().then(resolve); };
      }),
    } as unknown as MobileCaptureClient;
    let ready = true;
    const focused = new Promise<MobileCaptureOptions>((resolve) => {
      loadCachedOptionsOnFocus(delayedClient, (value) => { ready = true; resolve(value); }, () => { ready = false; });
    });

    await assert.rejects(async () => {
      ensureCaptureOptionsReady(ready);
      await client.captureText("Must not inherit Ada metadata", { projectId, tags: ["mobile"] });
    }, /Loading options for this pairing/);
    assert.deepEqual(await client.outbox(), []);
    releaseOptions?.();
    await focused;
    assert.doesNotThrow(() => ensureCaptureOptionsReady(ready));
  });

  it("reports an active focused-options rejection and suppresses one after cleanup", async () => {
    const failure = new Error("encrypted option store unavailable");
    let rejectOptions: ((error: unknown) => void) | undefined;
    const delayedClient = {
      options: () => new Promise<MobileCaptureOptions>((_resolve, reject) => { rejectOptions = reject; }),
    } as unknown as MobileCaptureClient;
    let activeError: unknown;
    loadCachedOptionsOnFocus(delayedClient, () => undefined, () => undefined, (error) => { activeError = error; });
    rejectOptions?.(failure);
    await Promise.resolve();
    assert.equal(activeError, failure);

    let lateError: unknown;
    const cleanup = loadCachedOptionsOnFocus(delayedClient, () => undefined, () => undefined, (error) => { lateError = error; });
    cleanup();
    rejectOptions?.(failure);
    await Promise.resolve();
    assert.equal(lateError, undefined);
  });

  it("keeps permanent attention visible when a later capture is retriable", async () => {
    const { database, baseUrl } = await run();
    const store = new MemoryEncryptedStore();
    let now = Date.parse("2026-08-22T10:00:00Z");
    const client = new MobileCaptureClient(store, fetch, { allowInsecureInstanceForTest: true, now: () => now });
    await client.pair({ instanceUrl: baseUrl, memberToken: "member-ada", workspaceId });
    await client.captureText("Permanent rejection", { projectId: "33333333-3333-4333-8333-333333333333" });
    await client.captureText("Transient rejection");
    database.failingContent = "Transient rejection";

    assert.deepEqual(await client.sync(), { status: "attention_required", count: 0,
      error: "workspace_forbidden", retryPending: true });
    const outbox = await client.outbox();
    assert.equal(outbox.length, 2);
    assert.equal(outbox[1]?.attempts, 1);
    assert.ok(outbox[1]?.nextRetryAt);

    now += 500;
    const secondPass = await client.sync();
    const reordered = await client.outbox();
    assert.equal(reordered[0]?.content, "Transient rejection");
    assert.match(presentMobileSyncResult(secondPass, reordered), /cannot capture/i);
  });

  it("keeps permanent attention visible when a later request loses the network", async () => {
    const { baseUrl } = await run();
    const store = new MemoryEncryptedStore();
    const client = new MobileCaptureClient(store, async (input, init) => {
      if (init?.method === "POST" && String(init.body).includes("Network disappears")) throw new TypeError("Network request failed");
      return fetch(input, init);
    }, { allowInsecureInstanceForTest: true });
    await client.pair({ instanceUrl: baseUrl, memberToken: "member-ada", workspaceId });
    await client.captureText("Permanent rejection", { projectId: "33333333-3333-4333-8333-333333333333" });
    await client.captureText("Network disappears");

    assert.deepEqual(await client.sync(), { status: "attention_required", count: 0,
      error: "workspace_forbidden", retryPending: true });
    assert.equal((await client.outbox()).length, 2);
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
