import { describe, expect, it, vi } from "vitest";

import { performTaskStatusUpdate } from "./task-status-update";

describe("performTaskStatusUpdate", () => {
  it("keeps the current status and offers a queue retry when encrypted persistence fails", async () => {
    const optimistic = vi.fn();
    const reloadPending = vi.fn();
    const synchronize = vi.fn();

    const result = await performTaskStatusUpdate({
      queue: async () => { throw new Error("secure storage unavailable"); },
      optimistic,
      reloadPending,
      synchronize,
    });

    expect(result).toEqual({
      kind: "queue_failed",
      retry: "queue",
      presentation: {
        variant: "error",
        message: "Task update was not saved. The current status is unchanged. Try again.",
      },
    });
    expect(optimistic).not.toHaveBeenCalled();
    expect(reloadPending).not.toHaveBeenCalled();
    expect(synchronize).not.toHaveBeenCalled();
  });

  it("preserves the optimistic queued status and offers sync retry after a later failure", async () => {
    let visibleStatus = "In progress";
    const result = await performTaskStatusUpdate({
      queue: async () => undefined,
      optimistic: () => { visibleStatus = "Done"; },
      reloadPending: async () => undefined,
      synchronize: async () => { throw new Error("network failed"); },
    });

    expect(visibleStatus).toBe("Done");
    expect(result).toEqual({
      kind: "post_queue_failed",
      retry: "sync",
      presentation: {
        variant: "attention",
        message: "Task update is saved on this device. Synchronization needs attention. Try syncing again.",
      },
    });
  });
});
