import { describe, expect, it, vi } from "vitest";
import type { MobileCapture, MobileCapturePairing, MobileSyncMutation, MobileWorkspaceSnapshot } from "@stash/domain-types";
import { MobileCaptureClient, type EncryptedMobileCaptureStore } from "./index.js";

const workspaceId = "11111111-1111-4111-8111-111111111111";
const memberId = "22222222-2222-4222-8222-222222222222";
const noteId = "33333333-3333-4333-8333-333333333333";
const taskId = "44444444-4444-4444-8444-444444444444";
const statusId = "66666666-6666-4666-8666-666666666666";
const collectionId = "77777777-7777-4777-8777-777777777777";
const propertyId = "88888888-8888-4888-8888-888888888888";
const recordId = "99999999-9999-4999-8999-999999999999";

function store(state: { snapshot?: MobileWorkspaceSnapshot; mutations: MobileSyncMutation[]; captures?: MobileCapture[] }): EncryptedMobileCaptureStore {
  const pairing: MobileCapturePairing = { instanceUrl: "https://stash.example", memberToken: "secret", workspaceId, memberId };
  return {
    async loadPairing() { return pairing; }, async savePairing() {}, async listCaptures() { return structuredClone(state.captures ?? []); },
    async saveCapture(value) { state.captures = [...(state.captures ?? []).filter(({ id }) => id !== value.id), structuredClone(value)]; },
    async removeCapture(id) { state.captures = (state.captures ?? []).filter((capture) => capture.id !== id); },
    async listMutations() { return structuredClone(state.mutations); }, async saveMutation(value) { state.mutations = [...state.mutations.filter(({ id }) => id !== value.id), structuredClone(value)]; },
    async replaceMutation(previous, value) { state.mutations = [...state.mutations.filter(({ id }) => id !== previous.id && id !== value.id), structuredClone(value)]; },
    async removeMutation(value) { state.mutations = state.mutations.filter(({ id }) => id !== value.id); }, async loadOptions() { return { projects: [], tags: [], reminders: [] }; }, async saveOptions() {},
    async stageIncomingShares(_fingerprint, deliveries) { return deliveries; }, async acknowledgeNativeShares() {}, async listIncomingShares() { return []; }, async removeIncomingShare() {}, async saveIncomingShare() {},
    async loadWorkspaceSnapshot() { return structuredClone(state.snapshot); }, async saveWorkspaceSnapshot(_scope, snapshot) { state.snapshot = structuredClone(snapshot); },
  };
}

describe("mobile workspace synchronization", () => {
  it("commits an atomic pairing-scoped snapshot that remains readable after an offline restart", async () => {
    const state: { snapshot?: MobileWorkspaceSnapshot; mutations: MobileSyncMutation[] } = { mutations: [] };
    const fetch = vi.fn<typeof globalThis.fetch>(async (input) => {
      const path = new URL(String(input)).pathname;
      if (path.endsWith("/note-tree")) return Response.json({ nodes: [{ id: noteId, workspaceId, title: "Inbox", position: "a", childCount: 0 }] });
      if (path.endsWith("/canonical-tasks")) return Response.json({ tasks: [{ schema: "stash.task.v1", id: taskId, workspaceId, title: "Review", description: "", revision: 2,
        status: { id: memberId, name: "Todo", category: "unstarted", position: 1 }, assigneeIds: [memberId], projectKeys: [], sourceNoteIds: [] }],
        workflow: { schema: "stash.workspace-workflow.v1", workspaceId,
          statuses: [{ id: memberId, name: "Todo", category: "unstarted", position: 1 }] },
        members: [{ id: memberId, name: "Ada Lovelace" }] });
      if (path === `/api/notes/${noteId}`) return Response.json({ note: { id: noteId, workspaceId, title: "Inbox", content: "Offline", revision: 1 } });
      if (path.endsWith("/collections")) return Response.json({ collections: [], views: [] });
      throw new TypeError("offline");
    });
    const first = new MobileCaptureClient(store(state), fetch, { now: () => Date.parse("2026-08-27T10:00:00.000Z") });
    await expect(first.refreshWorkspace()).resolves.toMatchObject({ schema: "stash.mobile-workspace.v1", notes: [{ content: "Offline" }],
      members: [{ id: memberId, name: "Ada Lovelace" }] });
    const restarted = new MobileCaptureClient(store(state), async () => { throw new TypeError("offline"); });
    await expect(restarted.cachedWorkspace()).resolves.toEqual(state.snapshot);
  });

  it("reconciles pairing-scoped pending canonical Task changes over the offline snapshot after restart", async () => {
    const base = { schema: "stash.mobile-workspace.v1" as const, workspaceId, refreshedAt: "2026-08-27T10:00:00.000Z",
      noteTree: [], notes: [], members: [], collections: [], collectionAccess: {}, collectionDisplay: {}, viewBlocks: [], search: [], workflow: { schema: "stash.workspace-workflow.v1" as const,
        workspaceId, statuses: [{ id: memberId, name: "Todo", category: "unstarted", position: 1 }] },
      tasks: [{ schema: "stash.task.v1" as const, id: taskId, workspaceId, title: "Review", description: "", revision: 2,
        status: { id: memberId, name: "Todo", category: "unstarted", position: 1 }, assigneeIds: [], projectKeys: [], sourceNoteIds: [] }] };
    const state = { snapshot: base, mutations: [{ id: "55555555-5555-4555-8555-555555555555", kind: "canonical_task_edit" as const,
      origin: { instanceUrl: "https://stash.example", workspaceId, memberId }, taskId, baseRevision: 2,
      changes: { title: "Offline review", assigneeIds: [memberId] }, attempts: 0 }] };
    const restarted = new MobileCaptureClient(store(state), async () => { throw new TypeError("offline"); });
    await expect(restarted.cachedWorkspace()).resolves.toMatchObject({ tasks: [{ title: "Offline review", assigneeIds: [memberId] }] });
    expect(state.snapshot.tasks[0]!.title).toBe("Review");
  });

  it("upgrades a legacy encrypted Workspace snapshot without Member presentation metadata", async () => {
    const legacy = { schema: "stash.mobile-workspace.v1" as const, workspaceId,
      refreshedAt: "2026-08-27T10:00:00.000Z", noteTree: [], notes: [], collections: [], viewBlocks: [], search: [],
      workflow: { schema: "stash.workspace-workflow.v1" as const, workspaceId, statuses: [] }, tasks: [] };
    const state = { snapshot: legacy as unknown as MobileWorkspaceSnapshot, mutations: [] as MobileSyncMutation[] };
    const restarted = new MobileCaptureClient(store(state), async () => { throw new TypeError("offline"); });

    await expect(restarted.cachedWorkspace()).resolves.toMatchObject({ members: [] });
  });

  it("queues and synchronizes a canonical Task edit by stable Task id", async () => {
    const state: { snapshot?: MobileWorkspaceSnapshot; mutations: MobileSyncMutation[] } = { mutations: [] };
    const request = vi.fn<typeof globalThis.fetch>(async () => Response.json({ status: "updated" }));
    const client = new MobileCaptureClient(store(state), request);
    await client.queueCanonicalTaskEdit(taskId, 2, { title: "Reviewed" }, "55555555-5555-4555-8555-555555555555");
    await expect(client.sync()).resolves.toEqual({ status: "synced", count: 1 });
    expect(request).toHaveBeenCalledWith(`https://stash.example/api/canonical-tasks/${taskId}`, expect.objectContaining({ method: "PATCH",
      body: JSON.stringify({ operationId: "55555555-5555-4555-8555-555555555555", baseRevision: 2, changes: { title: "Reviewed" } }) }));
    expect(state.mutations).toEqual([]);
  });

  it("coalesces repeated pending canonical Task edits onto one stable operation", async () => {
    const state: { snapshot?: MobileWorkspaceSnapshot; mutations: MobileSyncMutation[] } = { mutations: [] };
    const client = new MobileCaptureClient(store(state), async () => Response.json({ status: "updated" }));

    await client.queueCanonicalTaskEdit(taskId, 2, { title: "Reviewed" }, "55555555-5555-4555-8555-555555555555");
    await client.queueCanonicalTaskEdit(taskId, 2, { statusId }, "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa");

    await expect(client.pendingMutations()).resolves.toMatchObject([{
      id: "55555555-5555-4555-8555-555555555555",
      taskId,
      baseRevision: 2,
      changes: { title: "Reviewed", statusId },
    }]);
  });

  it("coalesces simultaneous canonical Task taps before either caller starts synchronization", async () => {
    const state: { snapshot?: MobileWorkspaceSnapshot; mutations: MobileSyncMutation[] } = { mutations: [] };
    const client = new MobileCaptureClient(store(state), async () => Response.json({ status: "updated" }));

    await Promise.all([
      client.queueCanonicalTaskEdit(taskId, 2, { title: "Reviewed" }, "55555555-5555-4555-8555-555555555555"),
      client.queueCanonicalTaskEdit(taskId, 2, { statusId }, "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"),
    ]);

    await expect(client.pendingMutations()).resolves.toMatchObject([{
      id: "55555555-5555-4555-8555-555555555555",
      taskId,
      baseRevision: 2,
      changes: { title: "Reviewed", statusId },
    }]);
  });

  it("rebases the cached canonical Task revision from a successful response", async () => {
    const snapshot = mobileSnapshot();
    const state: { snapshot?: MobileWorkspaceSnapshot; mutations: MobileSyncMutation[] } = { snapshot, mutations: [] };
    const client = new MobileCaptureClient(store(state), async () => Response.json({ status: "updated", task: {
      ...snapshot.tasks[0], revision: 3, status: snapshot.workflow.statuses[1],
    } }));
    await client.queueCanonicalTaskEdit(taskId, 2, { statusId }, "55555555-5555-4555-8555-555555555555");

    await expect(client.sync()).resolves.toEqual({ status: "synced", count: 1 });
    expect(state.snapshot?.tasks[0]).toMatchObject({ id: taskId, revision: 3, status: { id: statusId } });
  });

  it("can discard a conflicted canonical Task contribution and restore the server snapshot", async () => {
    const state: { snapshot?: MobileWorkspaceSnapshot; mutations: MobileSyncMutation[] } = { snapshot: mobileSnapshot(), mutations: [] };
    const client = new MobileCaptureClient(store(state), async () => Response.json({ error: "revision_conflict",
      message: "The Task changed." }, { status: 409 }));
    await client.queueCanonicalTaskEdit(taskId, 2, { title: "Local title" }, "55555555-5555-4555-8555-555555555555");
    await client.sync();

    await expect(client.pendingMutations()).resolves.toMatchObject([{ kind: "canonical_task_edit", conflict: true }]);
    await expect(client.cachedWorkspace()).resolves.toMatchObject({ tasks: [{ title: "Local title" }] });
    await expect(client.discardCanonicalTaskEdit(taskId)).resolves.toBe(1);
    await expect(client.cachedWorkspace()).resolves.toMatchObject({ tasks: [{ title: "Review" }] });
  });

  it("keeps a Collection record edit offline and synchronizes it through the canonical record route", async () => {
    const state: { snapshot?: MobileWorkspaceSnapshot; mutations: MobileSyncMutation[] } = { snapshot: mobileSnapshot(), mutations: [] };
    const request = vi.fn<typeof globalThis.fetch>(async () => Response.json({ status: "updated", record: {
      id: recordId, position: 1, values: { [propertyId]: "Edited offline" },
    } }));
    const client = new MobileCaptureClient(store(state), request);

    await client.queueCollectionRecordEdit(collectionId, recordId, { [propertyId]: "Edited offline" },
      "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa");
    await expect(client.cachedWorkspace()).resolves.toMatchObject({ collections: [{ records: [{
      id: recordId, values: { [propertyId]: "Edited offline" },
    }] }] });
    await expect(client.sync()).resolves.toEqual({ status: "synced", count: 1 });
    expect(request).toHaveBeenCalledWith(`https://stash.example/api/collections/${collectionId}/records/${recordId}`,
      expect.objectContaining({ method: "PATCH", body: JSON.stringify({ operationId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        baseRevision: 1, values: { [propertyId]: "Edited offline" } }) }));
    expect(state.snapshot?.collections[0]?.records[0]?.values[propertyId]).toBe("Edited offline");
    expect(state.mutations).toEqual([]);
  });

  it("upgrades a queued pre-revision Collection edit from the cached canonical record", async () => {
    const legacy = { id: "abababab-abab-4bab-8bab-abababababab", kind: "collection_record_edit",
      collectionId, recordId, values: { [propertyId]: "Queued before revisions" }, attempts: 0,
      origin: { instanceUrl: "https://stash.example", workspaceId, memberId } } as unknown as MobileSyncMutation;
    const state: { snapshot?: MobileWorkspaceSnapshot; mutations: MobileSyncMutation[] } = {
      snapshot: mobileSnapshot(), mutations: [legacy],
    };
    const request = vi.fn<typeof globalThis.fetch>(async () => Response.json({ status: "updated", record: {
      id: recordId, position: 1, revision: 2, values: { [propertyId]: "Queued before revisions" },
    } }));
    const client = new MobileCaptureClient(store(state), request);

    await expect(client.sync()).resolves.toEqual({ status: "synced", count: 1 });
    expect(JSON.parse(String(request.mock.calls[0]?.[1]?.body))).toEqual({
      operationId: legacy.id, baseRevision: 1, values: { [propertyId]: "Queued before revisions" },
    });
  });

  it("refuses to enqueue a Collection edit without cached edit access", async () => {
    const readonly = mobileSnapshot(); readonly.collectionAccess[collectionId] = { read: true, edit: false };
    const state: { snapshot?: MobileWorkspaceSnapshot; mutations: MobileSyncMutation[] } = { snapshot: readonly, mutations: [] };
    const client = new MobileCaptureClient(store(state), async () => Response.json({ status: "updated" }));

    await expect(client.queueCollectionRecordEdit(collectionId, recordId, { [propertyId]: "Forbidden" }))
      .rejects.toThrow("read-only");
    expect(state.mutations).toEqual([]);
  });

  it("preserves a conflicted Collection edit for explicit reconcile or discard", async () => {
    const state: { snapshot?: MobileWorkspaceSnapshot; mutations: MobileSyncMutation[] } = { snapshot: mobileSnapshot(), mutations: [] };
    const serverRecord = { id: recordId, position: 1, revision: 2, values: { [propertyId]: "Server edit" } };
    const client = new MobileCaptureClient(store(state), async () => Response.json({ error: "revision_conflict",
      message: "The record changed.", record: serverRecord }, { status: 409 }));
    await client.queueCollectionRecordEdit(collectionId, recordId, { [propertyId]: "Offline edit" },
      "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa");

    await expect(client.sync()).resolves.toEqual({ status: "attention_required", count: 0, error: "revision_conflict" });
    await expect(client.pendingMutations()).resolves.toMatchObject([{ kind: "collection_record_edit", baseRevision: 1, conflict: true }]);
    await expect(client.cachedWorkspace()).resolves.toMatchObject({ collections: [{ records: [{ values: { [propertyId]: "Offline edit" } }] }] });
    await expect(client.discardCollectionRecordEdit(collectionId, recordId)).resolves.toBe(1);
    await expect(client.cachedWorkspace()).resolves.toMatchObject({ collections: [{ records: [{ revision: 2, values: { [propertyId]: "Server edit" } }] }] });
  });

  it("reconciles a conflicted Collection edit against the latest cached revision with a new operation", async () => {
    const state: { snapshot?: MobileWorkspaceSnapshot; mutations: MobileSyncMutation[] } = { snapshot: mobileSnapshot(), mutations: [] };
    let attempt = 0;
    const request = vi.fn<typeof globalThis.fetch>(async (_input, init) => {
      attempt += 1;
      if (attempt === 1) return Response.json({ error: "revision_conflict", message: "The record changed.",
        record: { id: recordId, position: 1, revision: 2, values: { [propertyId]: "Server edit" } } }, { status: 409 });
      return Response.json({ status: "updated", record: { id: recordId, position: 1, revision: 3,
        values: { [propertyId]: "Offline edit" } } });
    });
    const client = new MobileCaptureClient(store(state), request);
    await client.queueCollectionRecordEdit(collectionId, recordId, { [propertyId]: "Offline edit" },
      "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa");
    await client.sync();
    await client.reconcileCollectionRecordEdit(collectionId, recordId, "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb");
    await client.sync();

    expect(JSON.parse(String(request.mock.calls[1]?.[1]?.body))).toEqual({ operationId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      baseRevision: 2, values: { [propertyId]: "Offline edit" } });
    expect(state.mutations).toEqual([]);
    expect(state.snapshot?.collections[0]?.records[0]).toMatchObject({ revision: 3, values: { [propertyId]: "Offline edit" } });
  });

  it("marks a permanently rejected Collection edit as discardable without retrying forever", async () => {
    const state: { snapshot?: MobileWorkspaceSnapshot; mutations: MobileSyncMutation[] } = { snapshot: mobileSnapshot(), mutations: [] };
    const client = new MobileCaptureClient(store(state), async () => Response.json({ error: "collection_not_found",
      message: "This record is unavailable." }, { status: 404 }));
    await client.queueCollectionRecordEdit(collectionId, recordId, { [propertyId]: "Rejected" });

    await expect(client.sync()).resolves.toMatchObject({ status: "attention_required", error: "collection_not_found" });
    await expect(client.pendingMutations()).resolves.toMatchObject([{ kind: "collection_record_edit", permanentFailure: true }]);
    await client.discardCollectionRecordEdit(collectionId, recordId);
    await expect(client.cachedWorkspace()).resolves.toMatchObject({ collections: [{ records: [{ values: { [propertyId]: "Draft" } }] }] });
  });

  it("coordinates separate live clients so a slower failure cannot resurrect an applied operation", async () => {
    const state: { snapshot?: MobileWorkspaceSnapshot; mutations: MobileSyncMutation[] } = {
      snapshot: mobileSnapshot(),
      mutations: [{ id: "55555555-5555-4555-8555-555555555555", kind: "canonical_task_edit", taskId,
        baseRevision: 2, changes: { title: "Applied once" }, attempts: 0,
        origin: { instanceUrl: "https://stash.example", workspaceId, memberId } }],
    };
    let releaseSuccess!: (response: Response) => void;
    const firstResponse = new Promise<Response>((resolve) => { releaseSuccess = resolve; });
    let requestCount = 0;
    const request = vi.fn<typeof globalThis.fetch>(async () => (++requestCount === 1)
      ? firstResponse : Response.json({ message: "Temporarily unavailable." }, { status: 503 }));
    const captureClient = new MobileCaptureClient(store(state), request);
    const workspaceClient = new MobileCaptureClient(store(state), request);

    const captureSync = captureClient.sync();
    const workspaceSync = workspaceClient.sync();
    await vi.waitFor(() => expect(request).toHaveBeenCalled());
    await Promise.resolve();
    releaseSuccess(Response.json({ status: "updated", task: { ...mobileSnapshot().tasks[0], title: "Applied once", revision: 3 } }));

    await expect(Promise.all([captureSync, workspaceSync])).resolves.toEqual([
      { status: "synced", count: 1 }, { status: "synced", count: 0 },
    ]);
    expect(request).toHaveBeenCalledTimes(1);
    expect(state.mutations).toEqual([]);
  });

  it("does not cache a malformed remote snapshot", async () => {
    const state: { snapshot?: MobileWorkspaceSnapshot; mutations: MobileSyncMutation[] } = { mutations: [] };
    const client = new MobileCaptureClient(store(state), async (input) => {
      const path = new URL(String(input)).pathname;
      if (path.endsWith("/note-tree")) return Response.json({ nodes: [{ id: "bad", workspaceId, title: "Inbox", position: "a", childCount: 0 }] });
      if (path.endsWith("/canonical-tasks")) return Response.json({ tasks: [], workflow: { schema: "stash.workspace-workflow.v1", workspaceId, statuses: [] } });
      if (path.endsWith("/collections")) return Response.json({ collections: [], views: [] });
      return Response.json({ note: { id: "bad", workspaceId, title: "Inbox", content: "Bad", revision: 1 } });
    });
    await expect(client.refreshWorkspace()).rejects.toThrow("invalid_mobile_workspace_snapshot");
    expect(state.snapshot).toBeUndefined();
  });

  it("keeps a changed canonical Task contribution visible and pending", async () => {
    const state: { snapshot?: MobileWorkspaceSnapshot; mutations: MobileSyncMutation[] } = { mutations: [] };
    const client = new MobileCaptureClient(store(state), async () => Response.json({ error: "revision_conflict",
      message: "The Task changed." }, { status: 409 }));
    await client.queueCanonicalTaskEdit(taskId, 2, { title: "Reviewed" }, "55555555-5555-4555-8555-555555555555");
    await expect(client.sync()).resolves.toEqual({ status: "attention_required", count: 0, error: "revision_conflict" });
    await expect(client.pendingMutations()).resolves.toMatchObject([{
      kind: "canonical_task_edit", conflict: true, lastError: "The Task changed.",
    }]);
  });

  it("does not label a retriable Task failure as a canonical conflict", async () => {
    const state: { snapshot?: MobileWorkspaceSnapshot; mutations: MobileSyncMutation[] } = { mutations: [] };
    const client = new MobileCaptureClient(store(state), async () => Response.json({ message: "Temporarily unavailable." }, { status: 503 }));
    await client.queueCanonicalTaskEdit(taskId, 2, { title: "Reviewed" }, "55555555-5555-4555-8555-555555555555");

    await expect(client.sync()).resolves.toMatchObject({ status: "retry_pending" });
    const [pending] = await client.pendingMutations();
    expect(pending).toMatchObject({ kind: "canonical_task_edit", lastError: "Temporarily unavailable." });
    expect(pending).not.toHaveProperty("conflict");
  });

  it("demonstrates offline capture, local canonical update, synchronization, and stable identity reconciliation", async () => {
    const snapshot: MobileWorkspaceSnapshot = { schema: "stash.mobile-workspace.v1", workspaceId,
      refreshedAt: "2026-08-27T10:00:00.000Z", noteTree: [], notes: [], members: [], collections: [], collectionAccess: {}, collectionDisplay: {}, viewBlocks: [], search: [],
      workflow: { schema: "stash.workspace-workflow.v1", workspaceId, statuses: [
        { id: memberId, name: "Todo", category: "unstarted", position: 1 },
        { id: statusId, name: "Done", category: "completed", position: 2 },
      ] },
      tasks: [{ schema: "stash.task.v1", id: taskId, workspaceId, title: "Ship mobile", description: "", revision: 3,
        status: { id: memberId, name: "Todo", category: "unstarted", position: 1 }, assigneeIds: [],
        projectKeys: [{ projectId: noteId, key: "MOB-7" }], sourceNoteIds: [] }] };
    const state: { snapshot?: MobileWorkspaceSnapshot; mutations: MobileSyncMutation[]; captures?: MobileCapture[] } = { snapshot, mutations: [] };
    const requests: Array<{ path: string; body?: any }> = [];
    const client = new MobileCaptureClient(store(state), async (input, init) => {
      const path = new URL(String(input)).pathname; requests.push({ path, ...(init?.body ? { body: JSON.parse(String(init.body)) } : {}) });
      return path.endsWith("/captures") ? Response.json({ status: "created", noteId }, { status: 201 })
        : Response.json({ status: "updated", task: { ...snapshot.tasks[0], status: snapshot.workflow.statuses[0], revision: 4 } });
    });
    await client.captureText("Follow up from the train");
    await client.queueCanonicalTaskEdit(taskId, 3, { statusId }, "55555555-5555-4555-8555-555555555555");
    await expect(client.cachedWorkspace()).resolves.toMatchObject({ tasks: [{ id: taskId, status: { id: statusId }, projectKeys: [{ key: "MOB-7" }] }] });
    await expect(client.sync()).resolves.toEqual({ status: "synced", count: 2 });
    expect(requests).toEqual([
      expect.objectContaining({ path: `/api/mobile/v1/workspaces/${workspaceId}/captures` }),
      { path: `/api/canonical-tasks/${taskId}`, body: { operationId: "55555555-5555-4555-8555-555555555555", baseRevision: 3, changes: { statusId } } },
    ]);
    expect(state.captures).toEqual([]); expect(state.mutations).toEqual([]);
  });
});

function mobileSnapshot(): MobileWorkspaceSnapshot {
  return {
    schema: "stash.mobile-workspace.v1", workspaceId, refreshedAt: "2026-08-27T10:00:00.000Z",
    noteTree: [], notes: [], members: [], viewBlocks: [], search: [],
    workflow: { schema: "stash.workspace-workflow.v1", workspaceId, statuses: [
      { id: memberId, name: "Todo", category: "unstarted", position: 1 },
      { id: statusId, name: "Done", category: "completed", position: 2 },
    ] },
    tasks: [{ schema: "stash.task.v1", id: taskId, workspaceId, title: "Review", description: "", revision: 2,
      status: { id: memberId, name: "Todo", category: "unstarted", position: 1 }, assigneeIds: [], projectKeys: [], sourceNoteIds: [] }],
    collections: [{ schema: "stash.collection.v1", id: collectionId, workspaceId, ownerNoteId: noteId, title: "Research",
      properties: [{ id: propertyId, name: "Name", position: 1, type: "text" }],
      records: [{ id: recordId, position: 1, values: { [propertyId]: "Draft" } }] }],
    collectionAccess: { [collectionId]: { read: true, edit: true } },
    collectionDisplay: { [collectionId]: { members: [], attachments: [] } },
  };
}
