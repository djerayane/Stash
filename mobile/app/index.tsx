import { Link, useFocusEffect } from "expo-router";
import NetInfo from "@react-native-community/netinfo";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AppState, Pressable, ScrollView, Text, TextInput, View, useColorScheme } from "react-native";

import { MobileCaptureClient } from "../../src/mobile-capture-client";
import { SecureMobileCaptureStore } from "../src/secure-mobile-store";
import type { MobileCaptureOptions } from "../../src/mobile-capture-client";
import { NativeActionButton, NativeToggle } from "@/components/native-controls";
import { NativeChoice } from "@/components/native-choice";
import { StatusFeedback } from "@/components/status-feedback";
import { colors } from "@/theme/colors";
import { presentMobileSyncResult } from "@/src/sync-status";
import { loadCachedOptionsOnFocus, reconcileCaptureSelections } from "@/src/capture-options-focus";

export default function CaptureScreen() {
  useColorScheme();
  const mounted = useRef(true);
  const client = useMemo(() => new MobileCaptureClient(new SecureMobileCaptureStore(), fetch), []);
  const [content, setContent] = useState("");
  const [checklist, setChecklist] = useState(false);
  const [status, setStatus] = useState("Saved captures synchronize when your Instance is reachable.");
  const [options, setOptions] = useState<MobileCaptureOptions>({ projects: [], tags: [], reminders: [] });
  const [projectId, setProjectId] = useState<string>();
  const [tag, setTag] = useState<string>();
  const [reminderOffset, setReminderOffset] = useState<number>();
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useFocusEffect(useCallback(() => loadCachedOptionsOnFocus(client, (value) => {
    if (!mounted.current) return;
    setOptions(value);
    setProjectId((current) => reconcileCaptureSelections(value, { ...(current ? { projectId: current } : {}) }).projectId);
    setTag((current) => reconcileCaptureSelections(value, { ...(current ? { tag: current } : {}) }).tag);
    setReminderOffset((current) => reconcileCaptureSelections(value,
      { ...(current !== undefined ? { reminderOffset: current } : {}) }).reminderOffset);
  }), [client]));
  useEffect(() => client.watchConnectivity(
    (listener) => NetInfo.addEventListener((state) => listener(Boolean(state.isConnected && state.isInternetReachable !== false))),
    (result) => {
      if (mounted.current) void client.outbox().then((outbox) => { if (mounted.current) setStatus(presentMobileSyncResult(result, outbox)); });
    },
  ), [client]);
  useEffect(() => {
    const synchronize = () => { void client.sync().then((result) => {
      if (mounted.current) void client.outbox().then((outbox) => { if (mounted.current) setStatus(presentMobileSyncResult(result, outbox)); });
    }); };
    synchronize();
    const subscription = AppState.addEventListener("change", (state) => { if (state === "active") synchronize(); else client.cancelRequests(); });
    return () => { subscription.remove(); client.cancelRequests(); };
  }, [client]);

  const save = async () => {
    try {
      if (checklist) {
        const [title = "Checklist", ...items] = content.split("\n").filter((line) => line.trim());
        await client.captureChecklist(title, items, structure());
      } else await client.captureText(content, structure());
      if (!mounted.current) return;
      setContent(""); setStatus("Saved securely on this device.");
      const result = await client.sync();
      if (!mounted.current) return;
      setStatus(presentMobileSyncResult(result, await client.outbox()));
    } catch (error) { if (mounted.current) setStatus(error instanceof Error ? error.message : "The capture could not be saved."); }
  };
  const structure = () => ({
    ...(projectId ? { projectId } : {}), ...(tag ? { tags: [tag] } : {}),
    ...(reminderOffset ? { reminder: { at: new Date(Date.now() + reminderOffset * 60_000).toISOString() } } : {}),
  });

  return (
    <ScrollView contentInsetAdjustmentBehavior="automatic" keyboardShouldPersistTaps="handled"
      contentContainerStyle={{ padding: 20, gap: 20 }}>
      <StatusFeedback message={status} />
      <Link href="/pairing" asChild>
        <Pressable accessibilityRole="link" style={{ minHeight: 44, justifyContent: "center" }}>
          <Text style={{ color: colors.accent, fontSize: 16 }}>Pair or update Instance</Text>
        </Pressable>
      </Link>
      <View style={{ gap: 10 }}>
        <TextInput
          accessibilityLabel={checklist ? "Checklist title and items" : "Note text"}
          multiline autoFocus value={content} onChangeText={setContent}
          placeholder={checklist ? "Title, then one item per line" : "What do you want to remember?"}
          style={{ minHeight: 190, borderWidth: 1, borderColor: colors.separator, color: colors.label, backgroundColor: colors.background, borderRadius: 18,
            borderCurve: "continuous", padding: 16, fontSize: 18, lineHeight: 26, textAlignVertical: "top" }}
        />
        <NativeToggle label={checklist ? "Checklist capture" : "Text capture"} value={checklist} onChange={setChecklist} />
      </View>
      {options.projects.length ? <NativeChoice label="Project" value={projectId} onChange={setProjectId}
        items={options.projects.map(({ id, name }) => ({ value: id, label: name }))} /> : null}
      {options.tags.length ? <NativeChoice label="Tag" value={tag} onChange={setTag}
        items={options.tags.map((value) => ({ value, label: value }))} /> : null}
      {options.reminders.length ? <NativeChoice label="Reminder" value={reminderOffset?.toString()} onChange={(value) => setReminderOffset(value ? Number(value) : undefined)}
        items={options.reminders.map(({ offsetMinutes, label }) => ({ value: offsetMinutes.toString(), label }))} /> : null}
      <NativeActionButton label="Save capture" disabled={!content.trim()} onPress={save} />
    </ScrollView>
  );
}
