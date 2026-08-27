import { describe, expect, it } from "vitest";
import type { MobileCapture, MobileCaptureOptions, MobileSyncMutation, MobileWorkspaceSnapshot } from "./index.js";

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
      refreshedAt: "2026-08-27T10:00:00.000Z", noteTree: [], notes: [], collections: [], viewBlocks: [], search: [],
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
});
