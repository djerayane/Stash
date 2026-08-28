import type { MobileCanonicalTask, MobileWorkspaceSnapshot } from "@stash/domain-types";
import { MobileCaptureClient } from "@stash/sync";
import { useFocusEffect } from "expo-router";
import { useCallback, useMemo, useState } from "react";
import { RefreshControl, useColorScheme } from "react-native";

import { MobileStatusNotice } from "@/components/mobile-status-notice";
import { NativeActionButton } from "@/components/native-controls";
import { Screen } from "@/components/screen";
import { WorkspaceReader } from "@/components/workspace-reader";
import { SecureMobileCaptureStore } from "@/src/secure-mobile-store";
import { mobileStatus, type MobileStatusPresentation } from "@/src/mobile-status-presentation";
import { presentMobileSyncResult } from "@/src/sync-status";
import { performTaskStatusUpdate } from "@/src/task-status-update";
import { stashTheme } from "@/theme/theme";

type TaskUpdateRetry = { kind: "queue"; task: MobileCanonicalTask; statusId: string } | { kind: "sync" };

export default function WorkspaceScreen() {
  useColorScheme();
  const store = useMemo(() => new SecureMobileCaptureStore(), []);
  const client = useMemo(() => new MobileCaptureClient(store, fetch), [store]);
  const [snapshot, setSnapshot] = useState<MobileWorkspaceSnapshot>();
  const [pending, setPending] = useState<ReadonlySet<string>>(new Set());
  const [refreshing, setRefreshing] = useState(false);
  const [status, setStatus] = useState<MobileStatusPresentation>(mobileStatus("waiting",
    "Loading the Workspace saved on this device."));
  const [taskRetry, setTaskRetry] = useState<TaskUpdateRetry>();

  const loadPending = useCallback(async () => setPending(new Set((await client.pendingMutations())
    .flatMap((mutation) => mutation.kind === "canonical_task_edit" ? [mutation.taskId] : []))), [client]);
  const refresh = useCallback(async () => {
    setRefreshing(true);
    try {
      const fresh = await client.refreshWorkspace(); setSnapshot(fresh);
      setStatus(mobileStatus("synchronized", "Workspace synchronized."));
    } catch {
      const cached = await client.cachedWorkspace(); setSnapshot(cached);
      setStatus(cached ? mobileStatus("waiting", "Offline. Showing the Workspace saved on this device.")
        : mobileStatus("error", "Pair the app and connect once to save this Workspace for offline use."));
    } finally { await loadPending(); setRefreshing(false); }
  }, [client, loadPending]);
  useFocusEffect(useCallback(() => { let active = true; void (async () => {
    const cached = await client.cachedWorkspace(); if (active && cached) {
      setSnapshot(cached); setStatus(mobileStatus("saved", "Showing the Workspace saved on this device."));
    }
    if (active) await refresh();
  })(); return () => { active = false; client.cancelRequests(); }; }, [client, refresh]));

  const updateTaskStatus = async (task: MobileCanonicalTask, statusId: string) => {
    const status = snapshot?.workflow.statuses.find(({ id }) => id === statusId);
    const outcome = await performTaskStatusUpdate({
      queue: async () => { await client.queueCanonicalTaskEdit(task.id, task.revision ?? 1, { statusId }); },
      optimistic: () => {
        if (snapshot && status) setSnapshot({ ...snapshot,
          tasks: snapshot.tasks.map((entry) => entry.id === task.id ? { ...entry, status } : entry) });
      },
      reloadPending: loadPending,
      synchronize: () => client.sync(),
    });
    if (outcome.kind === "queue_failed") {
      setTaskRetry({ kind: "queue", task, statusId }); setStatus(outcome.presentation); return;
    }
    if (outcome.kind === "post_queue_failed") {
      setTaskRetry({ kind: "sync" }); setStatus(outcome.presentation); return;
    }
    await presentTaskSync(outcome.result);
  };

  const presentTaskSync = async (result: Awaited<ReturnType<typeof client.sync>>) => {
    try {
      const [captures, mutations] = await Promise.all([client.outbox(), client.pendingMutations()]);
      setStatus(presentMobileSyncResult(result, [...captures, ...mutations]));
      setTaskRetry(result.status === "synced" ? undefined : { kind: "sync" });
    } catch {
      setTaskRetry({ kind: "sync" });
      setStatus(mobileStatus("attention",
        "Task update is saved on this device. Synchronization needs attention. Try syncing again."));
    }
  };

  const retryTaskUpdate = async () => {
    if (!taskRetry) return;
    if (taskRetry.kind === "queue") {
      await updateTaskStatus(taskRetry.task, taskRetry.statusId); return;
    }
    try {
      const result = await client.sync(); await loadPending(); await presentTaskSync(result);
    } catch {
      setStatus(mobileStatus("attention",
        "Task update is saved on this device. Synchronization needs attention. Try syncing again."));
    }
  };

  return <Screen refreshControl={<RefreshControl refreshing={refreshing} onRefresh={refresh}
    tintColor={stashTheme.colors.accent} colors={[stashTheme.colors.accent]} />}>
    <MobileStatusNotice variant={status.variant} message={status.message} />
    {taskRetry ? <NativeActionButton variant="secondary"
      label={taskRetry.kind === "queue" ? "Retry Task update" : "Retry synchronization"}
      onPress={retryTaskUpdate} /> : null}
    {snapshot ? <WorkspaceReader snapshot={snapshot} pendingTaskIds={pending} onUpdateTaskStatus={updateTaskStatus} /> : null}
  </Screen>;
}
