import { Pressable, Text } from "react-native";
import { stashTheme } from "@/theme/theme";
import type { NativeActionButtonProps, NativeToggleProps } from "./native-controls.types";

// SDK 55 has no universal @expo/ui web component layer; these accessible controls are web-only fallbacks.
export function NativeToggle({ label, value, onChange }: NativeToggleProps) {
  return <Pressable accessibilityRole="switch" accessibilityLabel={label} accessibilityState={{ checked: value }} onPress={() => onChange(!value)}
    style={{ minHeight: stashTheme.controlHeight, justifyContent: "center" }}>
    <Text style={{ color: stashTheme.colors.ink, fontWeight: "600" }}>{label}</Text>
  </Pressable>;
}
export function NativeActionButton({ label, variant = "primary", disabled = false, onPress }: NativeActionButtonProps) {
  const accent = variant === "danger" ? stashTheme.colors.error : stashTheme.colors.accent;
  return <Pressable accessibilityRole="button" accessibilityLabel={label} disabled={disabled} onPress={onPress} style={({ pressed }) => ({
    minHeight: stashTheme.controlHeight,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: stashTheme.spacing.md,
    borderRadius: stashTheme.radius.control,
    borderCurve: "continuous",
    borderWidth: variant === "primary" ? 0 : 1,
    borderColor: accent,
    backgroundColor: variant === "primary" ? accent : pressed ? stashTheme.colors.canvasDeep : stashTheme.colors.surface,
    opacity: disabled ? 0.45 : pressed ? 0.82 : 1,
  })}>
    <Text style={{ color: variant === "primary" ? stashTheme.colors.accentContrast : accent, fontWeight: "600" }}>{label}</Text>
  </Pressable>;
}
