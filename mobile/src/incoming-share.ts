import { clearSharedPayloads, getSharedPayloads, type SharePayload } from "expo-sharing";
import { useCallback, useEffect, useState } from "react";
import { AppState } from "react-native";

export function useIncomingSharePayloads() {
  const [sharedPayloads, setSharedPayloads] = useState<SharePayload[]>(() => getSharedPayloads());
  const [error, setError] = useState<Error | null>(null);
  const refresh = useCallback(() => {
    try { setSharedPayloads(getSharedPayloads()); setError(null); }
    catch (cause) { setError(cause instanceof Error ? cause : new Error("Shared content could not be read.")); }
  }, []);
  useEffect(() => {
    const subscription = AppState.addEventListener("change", (state) => { if (state === "active") refresh(); });
    return () => subscription.remove();
  }, [refresh]);
  const clear = useCallback(() => { clearSharedPayloads(); setSharedPayloads([]); }, []);
  return { sharedPayloads, clearSharedPayloads: clear, error };
}
