import type { MobileCapture, MobileSyncMutation, MobileSyncResult } from "@stash/domain-types";
import { mobileStatus, type MobileStatusPresentation } from "./mobile-status-presentation";

export function presentMobileSyncResult(result: MobileSyncResult,
  outbox: Array<MobileCapture | MobileSyncMutation>): MobileStatusPresentation {
  if (result.status === "synced") return mobileStatus("synchronized",
    result.count ? "Queued changes synchronized with your Instance." : "Synchronized with your Instance.");
  if (result.status === "offline") return mobileStatus("waiting", "Saved securely. Your Instance is offline; synchronization will retry.");
  if (result.status === "retry_pending") return mobileStatus("waiting", "Saved securely. The Instance asked the app to retry later.");
  if (result.status === "cancelled") return mobileStatus("waiting", "Synchronization paused.");
  if (result.status === "attention_required" && result.error === "conflicts_preserved")
    return mobileStatus("attention", "Every conflicting contribution was preserved. Review it in Stash to resolve the conflict.");
  if (result.status === "attention_required") return mobileStatus("attention", outbox.find(({ lastError, nextRetryAt }) => lastError && !nextRetryAt)?.lastError
    ?? outbox.find(({ lastError }) => lastError)?.lastError
    ?? `Saved locally. Synchronization needs attention: ${result.error}.`);
  return mobileStatus("waiting", "Saved securely. Synchronization will retry.");
}
