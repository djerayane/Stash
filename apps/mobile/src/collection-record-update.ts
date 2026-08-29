import type { MobileSyncResult } from "@stash/domain-types";
import { mobileStatus, type MobileStatusPresentation } from "./mobile-status-presentation";

interface CollectionRecordUpdateOperations {
  queue(): Promise<void>;
  optimistic(): void;
  reloadPending(): Promise<void>;
  synchronize(): Promise<MobileSyncResult>;
}

export type CollectionRecordUpdateOutcome =
  | { kind: "completed"; result: MobileSyncResult }
  | { kind: "queue_failed"; retry: "queue"; presentation: MobileStatusPresentation }
  | { kind: "post_queue_failed"; retry: "sync"; presentation: MobileStatusPresentation };

export async function performCollectionRecordUpdate(
  operations: CollectionRecordUpdateOperations,
): Promise<CollectionRecordUpdateOutcome> {
  try { await operations.queue(); }
  catch {
    return { kind: "queue_failed", retry: "queue", presentation: mobileStatus("error",
      "Record edit was not saved on this device. Your draft is still here. Retry the record edit.") };
  }
  operations.optimistic();
  try {
    await operations.reloadPending();
    const result = await operations.synchronize();
    if (result.status === "synced") await operations.reloadPending();
    return { kind: "completed", result };
  } catch {
    return { kind: "post_queue_failed", retry: "sync", presentation: mobileStatus("attention",
      "Record edit is saved on this device. Synchronization needs attention. Try syncing again.") };
  }
}
