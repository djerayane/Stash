import { Host, Picker, Text } from "@expo/ui/swift-ui";
import { accessibilityLabel, pickerStyle, tag, tint } from "@expo/ui/swift-ui/modifiers";
import { View } from "react-native";

import { stashTheme } from "@/theme/theme";
import type { NativeChoiceProps } from "./native-choice.types";

export function NativeChoice({ label, value, items, onChange }: NativeChoiceProps) {
  return <View style={{ minHeight: stashTheme.controlHeight }}><Host matchContents={{ vertical: true }}>
    <Picker label={label} selection={value ?? ""} onSelectionChange={(next) => onChange(next || undefined)}
      modifiers={[pickerStyle("menu"), accessibilityLabel(label), tint(stashTheme.colors.accent)]}>
      <Text modifiers={[tag("")]}>None</Text>
      {items.map((item) => <Text key={item.value} modifiers={[tag(item.value)]}>{item.label}</Text>)}
    </Picker>
  </Host></View>;
}
