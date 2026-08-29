import type { CollectionPropertyValue, MobileCanonicalTask, MobileWorkspaceSnapshot } from "@stash/domain-types";
import { MobileCaptureClient } from "@stash/sync";
import { useFocusEffect } from "expo-router";
import { useCallback, useMemo, useRef, useState } from "react";
import { RefreshControl, useColorScheme } from "react-native";

import { MobileStatusNotice } from "@/components/mobile-status-notice";
import { NativeActionButton } from "@/components/native-controls";
import { Screen } from "@/components/screen";
import { WorkspaceReader } from "@/components/workspace-reader";
import { performCollectionRecordUpdate } from "@/src/collection-record-update";
import { SecureMobileCaptureStore } from "@/src/secure-mobile-store";
import { mobileStatus, type MobileStatusPresentation } from "@/src/mobile-status-presentation";
import { presentMobileSyncResult } from "@/src/sync-status";
import { performTaskStatusUpdate } from "@/src/task-status-update";
import { stashTheme } from "@/theme/theme";

type TaskUpdateRetry = { kind: "queue"; task: MobileCanonicalTask; statusId: string } | { kind: "sync" };
type CollectionUpdateRetry = { kind: "queue"; collectionId: string; recordId: string;
  values: Readonly<Record<string, CollectionPropertyValue>> } | { kind: "sync" };
type CollectionRecovery = { collectionId: string; recordId: string; kind: "conflict" | "permanent" };

export default function WorkspaceScreen() {
  useColorScheme();
  const store = useMemo(() => new SecureMobileCaptureStore(), []);
  const client = useMemo(() => new MobileCaptureClient(store, fetch), [store]);
  const [snapshot, setSnapshot] = useState<MobileWorkspaceSnapshot>();
  const [pendingTasks, setPendingTasks] = useState<ReadonlySet<string>>(new Set());
  const [pendingRecords, setPendingRecords] = useState<ReadonlySet<string>>(new Set());
  const [conflictedTasks, setConflictedTasks] = useState<ReadonlySet<string>>(new Set());
  const [collectionRecoveries, setCollectionRecoveries] = useState<readonly CollectionRecovery[]>([]);
  const [refreshing, setRefreshing] = useState(false);
  const [status, setStatus] = useState<MobileStatusPresentation>(mobileStatus("waiting",
    "Loading the Workspace saved on this device."));
  const [taskRetry, setTaskRetry] = useState<TaskUpdateRetry>();
  const [collectionRetry, setCollectionRetry] = useState<CollectionUpdateRetry>();
  const taskUpdateLocks = useRef(new Set<string>());

  const loadPending = useCallback(async () => {
    const mutations = await client.pendingMutations();
    setPendingTasks(new Set(mutations.flatMap((mutation) => mutation.kind === "canonical_task_edit" ? [mutation.taskId] : [])));
    setPendingRecords(new Set(mutations.flatMap((mutation) => mutation.kind === "collection_record_edit" ? [mutation.recordId] : [])));
    setConflictedTasks(new Set(mutations.flatMap((mutation) => mutation.kind === "canonical_task_edit" && mutation.conflict
      ? [mutation.taskId] : [])));
    setCollectionRecoveries(mutations.flatMap((mutation): CollectionRecovery[] => mutation.kind !== "collection_record_edit"
      ? [] : mutation.conflict ? [{ collectionId: mutation.collectionId, recordId: mutation.recordId, kind: "conflict" }]
        : mutation.permanentFailure ? [{ collectionId: mutation.collectionId, recordId: mutation.recordId, kind: "permanent" }] : []));
  }, [client]);
  const refresh = useCallback(async () => {
    setRefreshing(true);
    try {
      const fresh = await client.refreshWorkspace(); setSnapshot(await client.cachedWorkspace() ?? fresh);
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
    if (taskUpdateLocks.current.has(task.id)) return;
    taskUpdateLocks.current.add(task.id);
    setPendingTasks((current) => new Set([...current, task.id]));
    const status = snapshot?.workflow.statuses.find(({ id }) => id === statusId);
    try {
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
    } finally {
      taskUpdateLocks.current.delete(task.id);
      await loadPending();
    }
  };

  const presentTaskSync = async (result: Awaited<ReturnType<typeof client.sync>>) => {
    try {
      await loadPending();
      const [captures, mutations, cached] = await Promise.all([client.outbox(), client.pendingMutations(), client.cachedWorkspace()]);
      if (cached) setSnapshot(cached);
      setStatus(presentMobileSyncResult(result, [...captures, ...mutations]));
      setTaskRetry(result.status === "synced" ? undefined : { kind: "sync" });
    } catch {
      setTaskRetry({ kind: "sync" });
      setStatus(mobileStatus("attention",
        "Task update is saved on this device. Synchronization needs attention. Try syncing again."));
    }
  };

  const updateCollectionRecord = async (collectionId: string, recordId: string,
    values: Readonly<Record<string, CollectionPropertyValue>>) => {
    const outcome = await performCollectionRecordUpdate({
      queue: async () => { await client.queueCollectionRecordEdit(collectionId, recordId, values); },
      optimistic: () => setSnapshot((current) => current ? { ...current,
        collections: current.collections.map((collection) => collection.id !== collectionId
          ? collection : { ...collection, records: collection.records.map((record) => record.id !== recordId ? record
            : { ...record, values: { ...record.values, ...values } }) }) } : current),
      reloadPending: loadPending,
      synchronize: () => client.sync(),
    });
    if (outcome.kind === "queue_failed") {
      setCollectionRetry({ kind: "queue", collectionId, recordId, values }); setStatus(outcome.presentation); return;
    }
    if (outcome.kind === "post_queue_failed") {
      setCollectionRetry({ kind: "sync" }); setStatus(outcome.presentation); return;
    }
    await presentCollectionSync(outcome.result);
  };

  const presentCollectionSync = async (result: Awaited<ReturnType<typeof client.sync>>) => {
    try {
      await loadPending();
      const [captures, mutations, cached] = await Promise.all([client.outbox(), client.pendingMutations(), client.cachedWorkspace()]);
      if (cached) setSnapshot(cached);
      setStatus(presentMobileSyncResult(result, [...captures, ...mutations]));
      const retryable = mutations.some((mutation) => mutation.kind === "collection_record_edit"
        && !mutation.conflict && !mutation.permanentFailure);
      setCollectionRetry(result.status !== "synced" && retryable ? { kind: "sync" } : undefined);
    } catch {
      setCollectionRetry({ kind: "sync" });
      setStatus(mobileStatus("attention",
        "Record edit is saved on this device. Synchronization needs attention. Try syncing again."));
    }
  };

  const retryCollectionUpdate = async () => {
    if (!collectionRetry) return;
    if (collectionRetry.kind === "queue") {
      await updateCollectionRecord(collectionRetry.collectionId, collectionRetry.recordId, collectionRetry.values); return;
    }
    try { await presentCollectionSync(await client.sync()); }
    catch { setStatus(mobileStatus("attention", "Record edit is saved on this device. Try syncing again.")); }
  };

  const reconcileCollectionEdits = async () => {
    try {
      for (const recovery of collectionRecoveries) if (recovery.kind === "conflict")
        await client.reconcileCollectionRecordEdit(recovery.collectionId, recovery.recordId);
      await presentCollectionSync(await client.sync());
    } catch {
      setStatus(mobileStatus("attention", "The Collection edit is still preserved on this device. Try reconciling again."));
    }
  };

  const discardCollectionEdits = async () => {
    try {
      for (const recovery of collectionRecoveries)
        await client.discardCollectionRecordEdit(recovery.collectionId, recovery.recordId);
      await loadPending(); setSnapshot(await client.cachedWorkspace()); setCollectionRetry(undefined);
      setStatus(mobileStatus("saved", "Local Collection edit discarded. Showing the last server version."));
    } catch {
      setStatus(mobileStatus("attention", "The Collection edit is still saved on this device. Try discarding again."));
    }
  };

  const discardConflictedTasks = async () => {
    try {
      for (const taskId of conflictedTasks) await client.discardCanonicalTaskEdit(taskId);
      await loadPending();
      try {
        const fresh = await client.refreshWorkspace(); setSnapshot(fresh);
        setStatus(mobileStatus("synchronized", "Server Task version restored."));
      } catch {
        setSnapshot(await client.cachedWorkspace());
        setStatus(mobileStatus("saved", "Conflicting Task update discarded. Showing the last synchronized version."));
      }
      setTaskRetry(undefined);
    } catch {
      setStatus(mobileStatus("attention", "The conflicting Task update is still saved on this device. Try again."));
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
    {collectionRetry ? <NativeActionButton variant="secondary"
      label={collectionRetry.kind === "queue" ? "Retry record edit" : "Retry synchronization"}
      onPress={retryCollectionUpdate} /> : null}
    {conflictedTasks.size ? <NativeActionButton variant="secondary" label="Use server Task version"
      onPress={discardConflictedTasks} /> : null}
    {collectionRecoveries.some(({ kind }) => kind === "conflict") ? <NativeActionButton variant="secondary"
      label="Reconcile Collection edit" onPress={reconcileCollectionEdits} /> : null}
    {collectionRecoveries.length ? <NativeActionButton variant="secondary" label="Use server Collection version"
      onPress={discardCollectionEdits} /> : null}
    {snapshot ? <WorkspaceReader snapshot={snapshot} pendingTaskIds={pendingTasks} pendingCollectionRecordIds={pendingRecords}
      onUpdateTaskStatus={updateTaskStatus} onUpdateCollectionRecord={updateCollectionRecord} /> : null}
  </Screen>;
}
