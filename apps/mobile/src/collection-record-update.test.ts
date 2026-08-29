import { describe, expect, it, vi } from "vitest";

import { performCollectionRecordUpdate } from "./collection-record-update";

describe("performCollectionRecordUpdate", () => {
  it("retains the draft and retries enqueue when encrypted persistence fails", async () => {
    const optimistic = vi.fn(); const reloadPending = vi.fn(); const synchronize = vi.fn();
    const result = await performCollectionRecordUpdate({
      queue: async () => { throw new Error("secure storage unavailable"); }, optimistic, reloadPending, synchronize,
    });

    expect(result).toEqual({ kind: "queue_failed", retry: "queue", presentation: {
      variant: "error", message: "Record edit was not saved on this device. Your draft is still here. Retry the record edit.",
    } });
    expect(optimistic).not.toHaveBeenCalled();
    expect(reloadPending).not.toHaveBeenCalled();
    expect(synchronize).not.toHaveBeenCalled();
  });

  it("retries only synchronization after the record edit is durably queued", async () => {
    const optimistic = vi.fn();
    const result = await performCollectionRecordUpdate({
      queue: async () => undefined, optimistic, reloadPending: async () => undefined,
      synchronize: async () => { throw new Error("network failed"); },
    });

    expect(optimistic).toHaveBeenCalledOnce();
    expect(result).toEqual({ kind: "post_queue_failed", retry: "sync", presentation: {
      variant: "attention", message: "Record edit is saved on this device. Synchronization needs attention. Try syncing again.",
    } });
  });
});
