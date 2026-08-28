import { Button, Host, OutlinedButton, Switch, Text } from "@expo/ui/jetpack-compose";
import { Row } from "@expo/ui/jetpack-compose";
import { fillMaxWidth, height, toggleable } from "@expo/ui/jetpack-compose/modifiers";

import { stashTheme } from "@/theme/theme";
import type { NativeActionButtonProps, NativeToggleProps } from "./native-controls.types";

export function NativeToggle({ label, value, onChange }: NativeToggleProps) {
  return <Host matchContents><Row modifiers={[toggleable(value, () => onChange(!value), { role: "switch" }),
    height(stashTheme.controlHeight), fillMaxWidth()]}>
    <Text>{label}</Text><Switch value={value} colors={{ checkedTrackColor: stashTheme.colors.accent,
      checkedThumbColor: stashTheme.colors.accentContrast }} />
  </Row></Host>;
}
export function NativeActionButton({ label, variant = "primary", disabled = false, onPress }: NativeActionButtonProps) {
  const ActionButton = variant === "primary" ? Button : OutlinedButton;
  const accent = variant === "danger" ? stashTheme.colors.error : stashTheme.colors.accent;
  return <Host matchContents><ActionButton enabled={!disabled} onClick={onPress} modifiers={[height(stashTheme.controlHeight), fillMaxWidth()]}
    colors={variant === "primary" ? { containerColor: accent, contentColor: stashTheme.colors.accentContrast }
      : { contentColor: accent, disabledContentColor: stashTheme.colors.secondaryInk }}><Text>{label}</Text></ActionButton></Host>;
}
