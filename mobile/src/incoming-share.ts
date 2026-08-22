import { clearSharedPayloads, getSharedPayloads, type SharePayload } from "expo-sharing";
import { useCallback, useEffect, useRef, useState } from "react";
import { AppState } from "react-native";
import { IncomingShareDeliveryBatch } from "./incoming-share-deliveries";

export function useIncomingSharePayloads() {
  const batch = useRef(new IncomingShareDeliveryBatch<SharePayload>());
  const [deliveries, setDeliveries] = useState(() => batch.current.receive(getSharedPayloads()));
  const [error, setError] = useState<Error | null>(null);
  const refresh = useCallback(() => {
    try { setDeliveries(batch.current.receive(getSharedPayloads())); setError(null); }
    catch (cause) { setError(cause instanceof Error ? cause : new Error("Shared content could not be read.")); }
  }, []);
  useEffect(() => {
    const subscription = AppState.addEventListener("change", (state) => { if (state === "active") refresh(); });
    return () => subscription.remove();
  }, [refresh]);
  const acknowledge = useCallback((id: string) => {
    const complete = batch.current.acknowledge(id);
    setDeliveries(batch.current.pending());
    if (complete) { clearSharedPayloads(); batch.current.reset(); }
  }, []);
  return { deliveries, acknowledge, error };
}
