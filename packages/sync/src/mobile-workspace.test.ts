import { describe, expect, it, vi } from "vitest";
import type { MobileCapturePairing, MobileSyncMutation, MobileWorkspaceSnapshot } from "@stash/domain-types";
import { MobileCaptureClient, type EncryptedMobileCaptureStore } from "./index.js";

const workspaceId = "11111111-1111-4111-8111-111111111111";
const memberId = "22222222-2222-4222-8222-222222222222";
const noteId = "33333333-3333-4333-8333-333333333333";
const taskId = "44444444-4444-4444-8444-444444444444";

function store(state: { snapshot?: MobileWorkspaceSnapshot; mutations: MobileSyncMutation[] }): EncryptedMobileCaptureStore {
  const pairing: MobileCapturePairing = { instanceUrl: "https://stash.example", memberToken: "secret", workspaceId, memberId };
  return {
    async loadPairing() { return pairing; }, async savePairing() {}, async listCaptures() { return []; }, async saveCapture() {}, async removeCapture() {},
    async listMutations() { return structuredClone(state.mutations); }, async saveMutation(value) { state.mutations = [...state.mutations.filter(({ id }) => id !== value.id), structuredClone(value)]; },
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
        status: { id: memberId, name: "Todo", category: "unstarted", position: 1 }, assigneeIds: [], projectKeys: [], sourceNoteIds: [] }],
        workflow: { schema: "stash.workspace-workflow.v1", workspaceId,
          statuses: [{ id: memberId, name: "Todo", category: "unstarted", position: 1 }] } });
      if (path === `/api/notes/${noteId}`) return Response.json({ note: { id: noteId, workspaceId, title: "Inbox", content: "Offline", revision: 1 } });
      if (path.endsWith("/collections")) return Response.json({ collections: [], views: [] });
      throw new TypeError("offline");
    });
    const first = new MobileCaptureClient(store(state), fetch, { now: () => Date.parse("2026-08-27T10:00:00.000Z") });
    await expect(first.refreshWorkspace()).resolves.toMatchObject({ schema: "stash.mobile-workspace.v1", notes: [{ content: "Offline" }] });
    const restarted = new MobileCaptureClient(store(state), async () => { throw new TypeError("offline"); });
    await expect(restarted.cachedWorkspace()).resolves.toEqual(state.snapshot);
  });

  it("reconciles pairing-scoped pending canonical Task changes over the offline snapshot after restart", async () => {
    const base = { schema: "stash.mobile-workspace.v1" as const, workspaceId, refreshedAt: "2026-08-27T10:00:00.000Z",
      noteTree: [], notes: [], collections: [], viewBlocks: [], search: [], workflow: { schema: "stash.workspace-workflow.v1" as const,
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
    const client = new MobileCaptureClient(store(state), async () => Response.json({ error: "canonical_task_changed",
      message: "The Task changed." }, { status: 409 }));
    await client.queueCanonicalTaskEdit(taskId, 2, { title: "Reviewed" }, "55555555-5555-4555-8555-555555555555");
    await expect(client.sync()).resolves.toEqual({ status: "attention_required", count: 0, error: "canonical_task_changed" });
    await expect(client.pendingMutations()).resolves.toMatchObject([{ kind: "canonical_task_edit", lastError: "The Task changed." }]);
  });
});
