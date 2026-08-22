import { clearSharedPayloads, getSharedPayloads, type SharePayload } from "expo-sharing";
import { useCallback, useEffect, useRef, useState } from "react";
import { AppState } from "react-native";
import { IncomingShareDeliveryBatch, type IncomingShareDelivery } from "./incoming-share-deliveries";

export function useIncomingSharePayloads() {
  const batch = useRef(new IncomingShareDeliveryBatch<SharePayload>());
  const stageNativeInvocation = useCallback(() => {
    const payloads = getSharedPayloads();
    if (payloads.length) {
      batch.current.receiveInvocation(payloads);
      // Native storage is a single replaceable slot. Clear it once the invocation
      // is staged, never later when doing so could erase a newer invocation.
      clearSharedPayloads();
    }
    return batch.current.pending();
  }, []);
  const [deliveries, setDeliveries] = useState<IncomingShareDelivery<SharePayload>[]>([]);
  const [error, setError] = useState<Error | null>(null);
  const refresh = useCallback(() => {
    try { setDeliveries(stageNativeInvocation()); setError(null); }
    catch (cause) { setError(cause instanceof Error ? cause : new Error("Shared content could not be read.")); }
  }, [stageNativeInvocation]);
  useEffect(() => {
    refresh();
    const subscription = AppState.addEventListener("change", (state) => { if (state === "active") refresh(); });
    return () => subscription.remove();
  }, [refresh]);
  const acknowledge = useCallback((id: string) => {
    batch.current.acknowledge(id);
    setDeliveries(batch.current.pending());
  }, []);
  return { deliveries, acknowledge, error };
}
