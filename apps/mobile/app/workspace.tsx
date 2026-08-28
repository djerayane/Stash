import type { MobileCanonicalTask, MobileWorkspaceSnapshot } from "@stash/domain-types";
import { MobileCaptureClient } from "@stash/sync";
import { useFocusEffect } from "expo-router";
import { useCallback, useMemo, useState } from "react";
import { RefreshControl, useColorScheme } from "react-native";

import { MobileStatusNotice, mobileStatusVariantForMessage } from "@/components/mobile-status-notice";
import { Screen } from "@/components/screen";
import { WorkspaceReader } from "@/components/workspace-reader";
import { SecureMobileCaptureStore } from "@/src/secure-mobile-store";
import { stashTheme } from "@/theme/theme";

export default function WorkspaceScreen() {
  useColorScheme();
  const store = useMemo(() => new SecureMobileCaptureStore(), []);
  const client = useMemo(() => new MobileCaptureClient(store, fetch), [store]);
  const [snapshot, setSnapshot] = useState<MobileWorkspaceSnapshot>();
  const [pending, setPending] = useState<ReadonlySet<string>>(new Set());
  const [refreshing, setRefreshing] = useState(false);
  const [message, setMessage] = useState("Loading the Workspace saved on this device.");

  const loadPending = useCallback(async () => setPending(new Set((await client.pendingMutations())
    .flatMap((mutation) => mutation.kind === "canonical_task_edit" ? [mutation.taskId] : []))), [client]);
  const refresh = useCallback(async () => {
    setRefreshing(true);
    try {
      const fresh = await client.refreshWorkspace(); setSnapshot(fresh); setMessage("Workspace synchronized.");
    } catch {
      const cached = await client.cachedWorkspace(); setSnapshot(cached);
      setMessage(cached ? "Offline. Showing the Workspace saved on this device." : "Pair the app and connect once to save this Workspace for offline use.");
    } finally { await loadPending(); setRefreshing(false); }
  }, [client, loadPending]);
  useFocusEffect(useCallback(() => { let active = true; void (async () => {
    const cached = await client.cachedWorkspace(); if (active && cached) { setSnapshot(cached); setMessage("Showing the Workspace saved on this device."); }
    if (active) await refresh();
  })(); return () => { active = false; client.cancelRequests(); }; }, [client, refresh]));

  const updateTaskStatus = async (task: MobileCanonicalTask, statusId: string) => {
    await client.queueCanonicalTaskEdit(task.id, task.revision ?? 1, { statusId });
    const status = snapshot?.workflow.statuses.find(({ id }) => id === statusId);
    if (snapshot && status) setSnapshot({ ...snapshot, tasks: snapshot.tasks.map((entry) => entry.id === task.id ? { ...entry, status } : entry) });
    await loadPending(); setMessage("Task update saved securely. It will synchronize when your Instance is reachable.");
    const result = await client.sync();
    if (result.status === "synced") { await loadPending(); setMessage("Task update synchronized."); }
  };

  return <Screen refreshControl={<RefreshControl refreshing={refreshing} onRefresh={refresh}
    tintColor={stashTheme.colors.accent} colors={[stashTheme.colors.accent]} />}>
    <MobileStatusNotice variant={mobileStatusVariantForMessage(message)} message={message} />
    {snapshot ? <WorkspaceReader snapshot={snapshot} pendingTaskIds={pending} onUpdateTaskStatus={updateTaskStatus} /> : null}
  </Screen>;
}
