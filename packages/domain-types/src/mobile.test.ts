import { describe, expect, it } from "vitest";
import type { MobileCapture, MobileCaptureOptions, MobileSyncMutation } from "./index.js";

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
});
