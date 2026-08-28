import type { MobileSyncResult } from "@stash/domain-types";
import { mobileStatus, type MobileStatusPresentation } from "./mobile-status-presentation";

interface TaskStatusUpdateOperations {
  queue(): Promise<void>;
  optimistic(): void;
  reloadPending(): Promise<void>;
  synchronize(): Promise<MobileSyncResult>;
}

export type TaskStatusUpdateOutcome =
  | { kind: "completed"; result: MobileSyncResult }
  | { kind: "queue_failed"; retry: "queue"; presentation: MobileStatusPresentation }
  | { kind: "post_queue_failed"; retry: "sync"; presentation: MobileStatusPresentation };

export async function performTaskStatusUpdate(operations: TaskStatusUpdateOperations): Promise<TaskStatusUpdateOutcome> {
  try {
    await operations.queue();
  } catch {
    return { kind: "queue_failed", retry: "queue", presentation: mobileStatus("error",
      "Task update was not saved. The current status is unchanged. Try again.") };
  }
  operations.optimistic();
  try {
    await operations.reloadPending();
    const result = await operations.synchronize();
    if (result.status === "synced") await operations.reloadPending();
    return { kind: "completed", result };
  } catch {
    return { kind: "post_queue_failed", retry: "sync", presentation: mobileStatus("attention",
      "Task update is saved on this device. Synchronization needs attention. Try syncing again.") };
  }
}
