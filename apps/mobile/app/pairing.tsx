import { router } from "expo-router";
import type { ReactNode } from "react";
import { useEffect, useMemo, useRef, useState } from "react";
import { Share, Text, TextInput, View, useColorScheme } from "react-native";

import { LegacyRecoveryRequired, MobileCaptureClient } from "@stash/sync";
import { SecureMobileCaptureStore } from "../src/secure-mobile-store";
import { NativeActionButton } from "@/components/native-controls";
import { MobileStatusNotice } from "@/components/mobile-status-notice";
import { Screen } from "@/components/screen";
import { stashTheme } from "@/theme/theme";

export default function PairingScreen() {
  useColorScheme();
  const mounted = useRef(true);
  const controller = useMemo(() => new AbortController(), []);
  const client = useMemo(() => new MobileCaptureClient(new SecureMobileCaptureStore(), fetch), []);
  const [instanceUrl, setInstanceUrl] = useState("");
  const [memberToken, setMemberToken] = useState("");
  const [workspaceId, setWorkspaceId] = useState("");
  const [error, setError] = useState("");
  const [legacyRecovery, setLegacyRecovery] = useState(false);
  const [legacyExported, setLegacyExported] = useState(false);
  const pairing = () => ({ instanceUrl: instanceUrl.trim(), memberToken: memberToken.trim(), workspaceId: workspaceId.trim() });
  const pair = async () => {
    try {
      await client.pair(pairing(), controller.signal);
      if (!mounted.current) return;
      router.back();
    } catch (cause) { if (mounted.current && !controller.signal.aborted) {
      const recovery = await client.legacyRecoveryStatus();
      setLegacyRecovery(recovery.available);
      setError(cause instanceof LegacyRecoveryRequired ? cause.message : recovery.available ? `${cause instanceof Error ? cause.message : "Pairing failed."} Export the legacy captures before replacing this pairing.`
        : cause instanceof Error ? cause.message : "Pairing failed.");
    } }
  };
  const exportLegacy = async () => {
    try {
      const result = await Share.share({ message: await client.exportLegacyCaptures(), title: "Stash legacy capture recovery" });
      const shared = result.action === Share.sharedAction;
      client.acknowledgeLegacyRecoveryExport(shared);
      if (mounted.current) { setLegacyExported(shared); if (!shared) setError("Legacy export was cancelled. Export it before continuing."); }
    } catch (cause) {
      client.acknowledgeLegacyRecoveryExport(false);
      if (mounted.current && !controller.signal.aborted) {
        setLegacyExported(false); setError(cause instanceof Error ? cause.message : "Legacy captures could not be exported.");
      }
    }
  };
  const continuePairing = async () => {
    try {
      await client.pair(pairing(), controller.signal, { replaceLegacy: true });
      if (mounted.current) router.back();
    } catch (cause) {
      if (mounted.current && !controller.signal.aborted) {
        setLegacyExported(false); setLegacyRecovery((await client.legacyRecoveryStatus()).available);
        setError(cause instanceof Error ? cause.message : "The new pairing could not be completed.");
      }
    }
  };
  useEffect(() => () => { mounted.current = false; controller.abort(); client.cancelRequests(); }, [client, controller]);
  return <Screen bottomAction={<NativeActionButton label="Pair Instance" onPress={pair} />}>
    <Text selectable style={{ color: stashTheme.colors.secondaryInk, fontSize: 15, lineHeight: 21 }}>
      Connect directly to your HTTPS Stash Instance. Credentials stay protected on this device.
    </Text>
    <PairingField label="Instance HTTPS URL"><TextInput accessibilityLabel="Instance HTTPS URL" autoCapitalize="none" autoCorrect={false}
      keyboardType="url" placeholder="https://stash.example.com" placeholderTextColor={stashTheme.colors.secondaryInk}
      value={instanceUrl} onChangeText={setInstanceUrl} style={fieldStyle} /></PairingField>
    <PairingField label="Member token"><TextInput accessibilityLabel="Member token" autoCapitalize="none" autoCorrect={false} secureTextEntry
      placeholder="Enter member token" placeholderTextColor={stashTheme.colors.secondaryInk}
      value={memberToken} onChangeText={setMemberToken} style={fieldStyle} /></PairingField>
    <PairingField label="Workspace ID"><TextInput accessibilityLabel="Workspace ID" autoCapitalize="none" autoCorrect={false}
      placeholder="Enter Workspace ID" placeholderTextColor={stashTheme.colors.secondaryInk}
      value={workspaceId} onChangeText={setWorkspaceId} style={fieldStyle} /></PairingField>
    {error ? <MobileStatusNotice variant={legacyRecovery ? "attention" : "error"} message={error} /> : null}
    {legacyRecovery ? <NativeActionButton variant="secondary" label="Export legacy captures" onPress={exportLegacy} /> : null}
    {legacyRecovery && legacyExported ? <NativeActionButton label="Continue with new pairing" onPress={continuePairing} /> : null}
  </Screen>;
}

function PairingField({ label, children }: { label: string; children: ReactNode }) {
  return <View style={{ gap: stashTheme.spacing.sm }}>
    <Text selectable style={{ color: stashTheme.colors.ink, fontSize: stashTheme.type.caption, fontWeight: "600" }}>{label}</Text>
    {children}
  </View>;
}

const fieldStyle = { minHeight: stashTheme.controlHeight, borderWidth: 1, borderColor: stashTheme.colors.rule,
  color: stashTheme.colors.ink, backgroundColor: stashTheme.colors.surface, borderRadius: stashTheme.radius.control,
  borderCurve: "continuous" as const, paddingHorizontal: stashTheme.spacing.md, fontSize: stashTheme.type.body };
