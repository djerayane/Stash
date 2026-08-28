import { describe, expect, it } from "vitest";
import { normalizeMobileWorkspaceSnapshot, type MobileCapture, type MobileCaptureOptions, type MobileSyncMutation, type MobileWorkspaceSnapshot } from "./index.js";

describe("mobile domain contracts", () => {
  it("describe captures, cached options, and loss-preserving mutations without a client framework", () => {
    const options: MobileCaptureOptions = { projects: [], tags: ["offline"], reminders: [] };
    const capture: MobileCapture = {
      id: "11111111-1111-4111-8111-111111111111", kind: "text", content: "Keep this",
      createdAt: "2026-08-23T00:00:00.000Z", attempts: 0,
    };
    const mutation: MobileSyncMutation = {
      id: "22222222-2222-4222-8222-222222222222", kind: "task_edit",
      origin: { instanceUrl: "https://stash.example", workspaceId: capture.id, memberId: capture.id },
      projectId: capture.id, taskKey: "APP-1", baseRevision: 1, changes: { labelNames: options.tags }, attempts: 0,
    };
    expect([capture.kind, mutation.kind, options.tags[0]]).toEqual(["text", "task_edit", "offline"]);
  });

  it("keeps offline workspace reads portable and keyed by canonical identities", () => {
    const snapshot: MobileWorkspaceSnapshot = {
      schema: "stash.mobile-workspace.v1", workspaceId: "11111111-1111-4111-8111-111111111111",
      refreshedAt: "2026-08-27T10:00:00.000Z", noteTree: [], notes: [], members: [], collections: [], viewBlocks: [], search: [],
      workflow: { schema: "stash.workspace-workflow.v1", workspaceId: "11111111-1111-4111-8111-111111111111", statuses: [] },
      tasks: [{ schema: "stash.task.v1", id: "22222222-2222-4222-8222-222222222222",
        workspaceId: "11111111-1111-4111-8111-111111111111", title: "Review", description: "", assigneeIds: [],
        status: { id: "33333333-3333-4333-8333-333333333333", name: "Todo", category: "unstarted", position: 1 },
        projectKeys: [], sourceNoteIds: [] }],
    };
    const mutation: MobileSyncMutation = { id: "44444444-4444-4444-8444-444444444444", kind: "canonical_task_edit",
      origin: { instanceUrl: "https://stash.example", workspaceId: snapshot.workspaceId, memberId: snapshot.workspaceId },
      taskId: snapshot.tasks[0]!.id, baseRevision: 1, changes: { title: "Reviewed" }, attempts: 0 };
    expect([snapshot.schema, mutation.kind, mutation.taskId]).toEqual([
      "stash.mobile-workspace.v1", "canonical_task_edit", snapshot.tasks[0]!.id,
    ]);
  });

  it("rejects malformed nested remote identities before they become offline state", () => {
    expect(() => normalizeMobileWorkspaceSnapshot({ schema: "stash.mobile-workspace.v1", workspaceId: "not-an-id",
      refreshedAt: "yesterday", noteTree: [], notes: [], tasks: [], workflow: {}, collections: [], viewBlocks: [], search: [] }))
      .toThrow("invalid_mobile_workspace_snapshot");
  });

  it("normalizes Member presentation metadata while upgrading legacy snapshots", () => {
    const legacy = { schema: "stash.mobile-workspace.v1", workspaceId: "11111111-1111-4111-8111-111111111111",
      refreshedAt: "2026-08-27T10:00:00.000Z", noteTree: [], notes: [], tasks: [],
      workflow: { schema: "stash.workspace-workflow.v1", workspaceId: "11111111-1111-4111-8111-111111111111", statuses: [] },
      collections: [], viewBlocks: [], search: [] };

    expect(normalizeMobileWorkspaceSnapshot(legacy).members).toEqual([]);
    expect(normalizeMobileWorkspaceSnapshot({ ...legacy,
      members: [{ id: "AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA", name: "Ada Lovelace" }] }).members)
      .toEqual([{ id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", name: "Ada Lovelace" }]);
    expect(() => normalizeMobileWorkspaceSnapshot({ ...legacy, members: [{ id: "not-a-member", name: "Ada" }] }))
      .toThrow("invalid_mobile_workspace_snapshot");
    const assignedLegacy = { ...legacy,
      workflow: { ...legacy.workflow, statuses: [{ id: "BBBBBBBB-BBBB-4BBB-8BBB-BBBBBBBBBBBB", name: "Ready", category: "unstarted", position: 1 }] },
      tasks: [{ schema: "stash.task.v1", id: "CCCCCCCC-CCCC-4CCC-8CCC-CCCCCCCCCCCC", workspaceId: legacy.workspaceId,
        title: "Review", description: "", status: { id: "BBBBBBBB-BBBB-4BBB-8BBB-BBBBBBBBBBBB", name: "Ready", category: "unstarted", position: 1 },
        assigneeIds: ["AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA"], projectKeys: [], sourceNoteIds: [] }] };
    const upgraded = normalizeMobileWorkspaceSnapshot(assignedLegacy);
    expect(normalizeMobileWorkspaceSnapshot(upgraded).members).toEqual([]);
  });
});
