import { Host, Picker, Text } from "@expo/ui/swift-ui";
import { accessibilityLabel, pickerStyle, tag } from "@expo/ui/swift-ui/modifiers";
import { View } from "react-native";

import type { NativeChoiceProps } from "./native-choice.types";

export function NativeChoice({ label, value, items, onChange }: NativeChoiceProps) {
  return <View style={{ minHeight: 52 }}><Host matchContents={{ vertical: true }}>
    <Picker label={label} selection={value ?? ""} onSelectionChange={(next) => onChange(next || undefined)}
      modifiers={[pickerStyle("menu"), accessibilityLabel(label)]}>
      <Text modifiers={[tag("")]}>None</Text>
      {items.map((item) => <Text key={item.value} modifiers={[tag(item.value)]}>{item.label}</Text>)}
    </Picker>
  </Host></View>;
}
