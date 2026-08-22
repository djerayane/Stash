import type { MobileCapture, MobileSyncResult } from "../../src/mobile-capture-client";

export function presentMobileSyncResult(result: MobileSyncResult, outbox: MobileCapture[]): string {
  if (result.status === "synced") return result.count ? "Queued captures synchronized with your Instance." : "Synchronized with your Instance.";
  if (result.status === "offline") return "Saved securely. Your Instance is offline; synchronization will retry.";
  if (result.status === "retry_pending") return "Saved securely. The Instance asked the app to retry later.";
  if (result.status === "cancelled") return "Synchronization paused.";
  if (result.status === "attention_required") return outbox.find(({ lastError, nextRetryAt }) => lastError && !nextRetryAt)?.lastError
    ?? outbox.find(({ lastError }) => lastError)?.lastError
    ?? `Saved locally. Synchronization needs attention: ${result.error}.`;
  return "Saved securely. Synchronization will retry.";
}
