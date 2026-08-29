import { Button, Host, Toggle } from "@expo/ui/swift-ui";
import { buttonStyle, controlSize, disabled, frame, tint } from "@expo/ui/swift-ui/modifiers";
import { View } from "react-native";

import { stashTheme } from "@/theme/theme";
import type { NativeActionButtonProps, NativeToggleProps } from "./native-controls.types";

export function NativeToggle({ label, value, onChange }: NativeToggleProps) {
  return <View style={{ minHeight: stashTheme.controlHeight, justifyContent: "center" }}><Host matchContents>
    <Toggle label={label} isOn={value} onIsOnChange={onChange} modifiers={[tint(stashTheme.colors.accent)]} />
  </Host></View>;
}
export function NativeActionButton({ label, variant = "primary", disabled: isDisabled = false, onPress }: NativeActionButtonProps) {
  const accent = variant === "danger" ? stashTheme.colors.error : stashTheme.colors.accent;
  return <View style={{ minHeight: stashTheme.controlHeight }}><Host matchContents={{ vertical: true }}>
    <Button label={label} onPress={onPress} modifiers={[buttonStyle(variant === "primary" ? "borderedProminent" : "bordered"),
      controlSize("large"), frame({ minHeight: stashTheme.controlHeight, maxWidth: Infinity }), tint(accent), disabled(isDisabled)]} />
  </Host></View>;
}
