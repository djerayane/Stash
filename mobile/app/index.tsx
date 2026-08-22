import { Link } from "expo-router";
import NetInfo from "@react-native-community/netinfo";
import { useEffect, useMemo, useState } from "react";
import { Pressable, ScrollView, Text, TextInput, View, useColorScheme } from "react-native";

import { MobileCaptureClient } from "../../src/mobile-capture-client";
import { SecureMobileCaptureStore } from "../src/secure-mobile-store";
import type { MobileCaptureOptions } from "../../src/mobile-capture-client";

export default function CaptureScreen() {
  useColorScheme();
  const client = useMemo(() => new MobileCaptureClient(new SecureMobileCaptureStore(), fetch), []);
  const [content, setContent] = useState("");
  const [checklist, setChecklist] = useState(false);
  const [status, setStatus] = useState("Saved captures synchronize when your Instance is reachable.");
  const [options, setOptions] = useState<MobileCaptureOptions>({ projects: [], tags: [], reminders: [] });
  const [projectId, setProjectId] = useState<string>();
  const [tag, setTag] = useState<string>();
  const [reminderOffset, setReminderOffset] = useState<number>();
  useEffect(() => { void client.options().then(setOptions); }, [client]);
  useEffect(() => client.watchConnectivity(
    (listener) => NetInfo.addEventListener((state) => listener(Boolean(state.isConnected && state.isInternetReachable !== false))),
    (result) => {
      if (result.status === "synced" && result.count) setStatus("Queued captures synchronized with your Instance.");
    },
  ), [client]);

  const save = async () => {
    try {
      if (checklist) {
        const [title = "Checklist", ...items] = content.split("\n").filter((line) => line.trim());
        await client.captureChecklist(title, items, structure());
      } else await client.captureText(content, structure());
      setContent("");
      setStatus("Saved securely on this device.");
      const result = await client.sync();
      if (result.status === "synced") setStatus("Synchronized with your Instance.");
      else if (result.status === "offline") setStatus("Saved securely. Your Instance is offline; synchronization will retry.");
      else if (result.status === "retry_pending") setStatus("Saved securely. The Instance asked the app to retry later.");
      else if (result.status === "attention_required") {
        const failed = (await client.outbox()).find(({ lastError }) => lastError);
        setStatus(failed?.lastError ?? `Saved locally. Synchronization needs attention: ${result.error}.`);
      }
    } catch (error) { setStatus(error instanceof Error ? error.message : "The capture could not be saved."); }
  };
  const structure = () => ({
    ...(projectId ? { projectId } : {}), ...(tag ? { tags: [tag] } : {}),
    ...(reminderOffset ? { reminder: { at: new Date(Date.now() + reminderOffset * 60_000).toISOString() } } : {}),
  });

  return (
    <ScrollView contentInsetAdjustmentBehavior="automatic" keyboardShouldPersistTaps="handled"
      contentContainerStyle={{ padding: 20, gap: 20 }}>
      <Text selectable style={{ color: "#6b6b70", fontSize: 15, lineHeight: 21 }}>{status}</Text>
      <Link href="/pairing" asChild>
        <Pressable accessibilityRole="link" style={{ minHeight: 44, justifyContent: "center" }}>
          <Text style={{ color: "#2463eb", fontSize: 16 }}>Pair or update Instance</Text>
        </Pressable>
      </Link>
      <View style={{ gap: 10 }}>
        <TextInput
          accessibilityLabel={checklist ? "Checklist title and items" : "Note text"}
          multiline autoFocus value={content} onChangeText={setContent}
          placeholder={checklist ? "Title, then one item per line" : "What do you want to remember?"}
          style={{ minHeight: 190, borderWidth: 1, borderColor: "#c7c7cc", borderRadius: 18,
            borderCurve: "continuous", padding: 16, fontSize: 18, lineHeight: 26, textAlignVertical: "top" }}
        />
        <Pressable accessibilityRole="switch" accessibilityState={{ checked: checklist }} onPress={() => setChecklist((value) => !value)}
          style={{ minHeight: 48, justifyContent: "center" }}>
          <Text style={{ fontSize: 16, color: "#2463eb" }}>{checklist ? "Checklist capture" : "Text capture"}</Text>
        </Pressable>
      </View>
      {options.projects.length ? <Choice label="Project" value={options.projects.find(({ id }) => id === projectId)?.name}
        onPress={() => setProjectId(nextValue(options.projects.map(({ id }) => id), projectId))} /> : null}
      {options.tags.length ? <Choice label="Tag" value={tag}
        onPress={() => setTag(nextValue(options.tags, tag))} /> : null}
      {options.reminders.length ? <Choice label="Reminder" value={options.reminders.find(({ offsetMinutes }) => offsetMinutes === reminderOffset)?.label}
        onPress={() => setReminderOffset(nextValue(options.reminders.map(({ offsetMinutes }) => offsetMinutes), reminderOffset))} /> : null}
      <Pressable accessibilityRole="button" disabled={!content.trim()} onPress={save}
        style={({ pressed }) => ({ minHeight: 52, alignItems: "center", justifyContent: "center", borderRadius: 16,
          borderCurve: "continuous", backgroundColor: content.trim() ? "#2463eb" : "#a8a8ad", opacity: pressed ? 0.75 : 1 })}>
        <Text style={{ color: "white", fontSize: 17, fontWeight: "600" }}>Save capture</Text>
      </Pressable>
    </ScrollView>
  );
}

function nextValue<T>(values: T[], current: T | undefined): T | undefined {
  if (current === undefined) return values[0];
  const next = values.indexOf(current) + 1;
  return next < values.length ? values[next] : undefined;
}

function Choice({ label, value, onPress }: { label: string; value?: string; onPress: () => void }) {
  return <Pressable accessibilityRole="button" onPress={onPress} style={{ minHeight: 48, justifyContent: "center" }}>
    <Text style={{ color: "#2463eb", fontSize: 16 }}>{label}: {value ?? "None"}</Text>
  </Pressable>;
}
