import { Pressable, Text } from "react-native";
import { colors } from "@/theme/colors";

// SDK 55 has no universal @expo/ui web component layer; these accessible controls are web-only fallbacks.
export function NativeToggle({ label, value, onChange }: { label: string; value: boolean; onChange: (value: boolean) => void }) {
  return <Pressable accessibilityRole="switch" accessibilityState={{ checked: value }} onPress={() => onChange(!value)} style={{ minHeight: 48, justifyContent: "center" }}>
    <Text style={{ color: colors.accent }}>{label}</Text>
  </Pressable>;
}
export function NativeActionButton({ label, disabled = false, onPress }: { label: string; disabled?: boolean; onPress: () => void }) {
  return <Pressable accessibilityRole="button" disabled={disabled} onPress={onPress} style={{ minHeight: 52, alignItems: "center", justifyContent: "center", borderRadius: 16, backgroundColor: colors.accent, opacity: disabled ? 0.45 : 1 }}>
    <Text style={{ color: colors.buttonText, fontWeight: "600" }}>{label}</Text>
  </Pressable>;
}
