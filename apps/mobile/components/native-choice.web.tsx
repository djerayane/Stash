import { Picker } from "@react-native-picker/picker";
import { View } from "react-native";

import { stashTheme } from "@/theme/theme";
import type { NativeChoiceProps } from "./native-choice.types";

// SDK 55 has no @expo/ui web layer; the web-only fallback renders an accessible HTML select.
export function NativeChoice({ label, value, items, onChange }: NativeChoiceProps) {
  return <View accessibilityLabel={label} style={{ minHeight: stashTheme.controlHeight, borderWidth: 1,
    borderColor: stashTheme.colors.rule, borderRadius: stashTheme.radius.control, borderCurve: "continuous",
    backgroundColor: stashTheme.colors.surface }}>
    <Picker accessibilityLabel={label} selectedValue={value ?? ""} onValueChange={(next) => onChange(next || undefined)}>
      <Picker.Item label={`${label}: None`} value="" />
      {items.map((item) => <Picker.Item key={item.value} label={`${label}: ${item.label}`} value={item.value} />)}
    </Picker>
  </View>;
}
