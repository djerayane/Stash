import { router } from "expo-router";
import { useEffect, useMemo, useRef, useState } from "react";
import { ScrollView, Text, TextInput, useColorScheme } from "react-native";

import { MobileCaptureClient } from "../../src/mobile-capture-client";
import { SecureMobileCaptureStore } from "../src/secure-mobile-store";
import { NativeActionButton } from "@/components/native-controls";
import { StatusFeedback } from "@/components/status-feedback";
import { colors } from "@/theme/colors";

export default function PairingScreen() {
  useColorScheme();
  const mounted = useRef(true);
  const controller = useMemo(() => new AbortController(), []);
  const client = useMemo(() => new MobileCaptureClient(new SecureMobileCaptureStore(), fetch), []);
  const [instanceUrl, setInstanceUrl] = useState("");
  const [memberToken, setMemberToken] = useState("");
  const [workspaceId, setWorkspaceId] = useState("");
  const [error, setError] = useState("");
  const pair = async () => {
    try {
      await client.pair({ instanceUrl: instanceUrl.trim(), memberToken: memberToken.trim(), workspaceId: workspaceId.trim() });
      await client.refreshOptions(controller.signal);
      if (!mounted.current) return;
      router.back();
    } catch (cause) { if (mounted.current && !controller.signal.aborted) setError(cause instanceof Error ? cause.message : "Pairing failed."); }
  };
  useEffect(() => () => { mounted.current = false; controller.abort(); client.cancelRequests(); }, [client, controller]);
  return <ScrollView contentInsetAdjustmentBehavior="automatic" keyboardShouldPersistTaps="handled"
    contentContainerStyle={{ padding: 20, gap: 18 }}>
    <Text selectable style={{ color: colors.secondaryLabel, fontSize: 15, lineHeight: 21 }}>
      Connect directly to your HTTPS Stash Instance. Credentials stay protected on this device.
    </Text>
    <TextInput accessibilityLabel="Instance HTTPS URL" autoCapitalize="none" autoCorrect={false}
      keyboardType="url" placeholder="https://stash.example.com" value={instanceUrl} onChangeText={setInstanceUrl}
      style={fieldStyle} />
    <TextInput accessibilityLabel="Member token" autoCapitalize="none" autoCorrect={false} secureTextEntry
      placeholder="Member token" value={memberToken} onChangeText={setMemberToken} style={fieldStyle} />
    <TextInput accessibilityLabel="Workspace ID" autoCapitalize="none" autoCorrect={false}
      placeholder="Workspace UUID" value={workspaceId} onChangeText={setWorkspaceId} style={fieldStyle} />
    {error ? <StatusFeedback message={error} /> : null}
    <NativeActionButton label="Pair Instance" onPress={pair} />
  </ScrollView>;
}

const fieldStyle = { minHeight: 52, borderWidth: 1, borderColor: colors.separator, color: colors.label,
  backgroundColor: colors.background, borderRadius: 14 as const, borderCurve: "continuous" as const, paddingHorizontal: 14, fontSize: 16 };
