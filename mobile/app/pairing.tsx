import { router } from "expo-router";
import { useMemo, useState } from "react";
import { Pressable, ScrollView, Text, TextInput } from "react-native";

import { MobileCaptureClient } from "../../src/mobile-capture-client";
import { SecureMobileCaptureStore } from "../src/secure-mobile-store";

export default function PairingScreen() {
  const client = useMemo(() => new MobileCaptureClient(new SecureMobileCaptureStore(), fetch), []);
  const [instanceUrl, setInstanceUrl] = useState("");
  const [memberToken, setMemberToken] = useState("");
  const [workspaceId, setWorkspaceId] = useState("");
  const [error, setError] = useState("");
  const pair = async () => {
    try {
      await client.pair({ instanceUrl: instanceUrl.trim(), memberToken: memberToken.trim(), workspaceId: workspaceId.trim() });
      await client.refreshOptions();
      router.back();
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Pairing failed."); }
  };
  return <ScrollView contentInsetAdjustmentBehavior="automatic" keyboardShouldPersistTaps="handled"
    contentContainerStyle={{ padding: 20, gap: 18 }}>
    <Text selectable style={{ color: "#6b6b70", fontSize: 15, lineHeight: 21 }}>
      Connect directly to your HTTPS Stash Instance. Credentials stay protected on this device.
    </Text>
    <TextInput accessibilityLabel="Instance HTTPS URL" autoCapitalize="none" autoCorrect={false}
      keyboardType="url" placeholder="https://stash.example.com" value={instanceUrl} onChangeText={setInstanceUrl}
      style={fieldStyle} />
    <TextInput accessibilityLabel="Member token" autoCapitalize="none" autoCorrect={false} secureTextEntry
      placeholder="Member token" value={memberToken} onChangeText={setMemberToken} style={fieldStyle} />
    <TextInput accessibilityLabel="Workspace ID" autoCapitalize="none" autoCorrect={false}
      placeholder="Workspace UUID" value={workspaceId} onChangeText={setWorkspaceId} style={fieldStyle} />
    {error ? <Text selectable accessibilityRole="alert" style={{ color: "#b42318" }}>{error}</Text> : null}
    <Pressable accessibilityRole="button" onPress={pair}
      style={({ pressed }) => ({ minHeight: 52, alignItems: "center", justifyContent: "center", borderRadius: 16,
        borderCurve: "continuous", backgroundColor: "#2463eb", opacity: pressed ? 0.75 : 1 })}>
      <Text style={{ color: "white", fontSize: 17, fontWeight: "600" }}>Pair Instance</Text>
    </Pressable>
  </ScrollView>;
}

const fieldStyle = { minHeight: 52, borderWidth: 1, borderColor: "#c7c7cc", borderRadius: 14 as const,
  borderCurve: "continuous" as const, paddingHorizontal: 14, fontSize: 16 };
