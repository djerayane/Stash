import { clearSharedPayloads, getSharedPayloads, type SharePayload } from "expo-sharing";
import { useCallback, useEffect, useState } from "react";
import { AppState } from "react-native";
import type { EncryptedMobileCaptureStore } from "@stash/sync";
import { incomingShareFingerprint } from "./incoming-share-deliveries";

export function useIncomingSharePayloads(store: EncryptedMobileCaptureStore) {
  const [revision, setRevision] = useState(0);
  const [error, setError] = useState<Error | null>(null);
  const stageNativeInvocation = useCallback(async () => {
    let payloads = getSharedPayloads();
    while (payloads.length) {
      const fingerprint = incomingShareFingerprint(payloads);
      await store.stageIncomingShares(fingerprint, payloads.map((payload) => ({ id: crypto.randomUUID(), payload })));
      const current = getSharedPayloads();
      if (incomingShareFingerprint(current) === fingerprint) {
        clearSharedPayloads();
        await store.acknowledgeNativeShares(fingerprint);
        break;
      }
      payloads = current;
    }
    if (!payloads.length) await store.acknowledgeNativeShares();
    setRevision((value) => value + 1);
  }, [store]);
  const refresh = useCallback(() => {
    void stageNativeInvocation().then(() => setError(null),
      (cause) => setError(cause instanceof Error ? cause : new Error("Shared content could not be read.")));
  }, [stageNativeInvocation]);
  useEffect(() => {
    refresh();
    const subscription = AppState.addEventListener("change", (state) => { if (state === "active") refresh(); });
    return () => subscription.remove();
  }, [refresh]);
  return { revision, refresh, error };
}
