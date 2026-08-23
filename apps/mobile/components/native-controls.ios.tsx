import { Button, Host, Toggle } from "@expo/ui/swift-ui";
import { buttonStyle, controlSize, disabled } from "@expo/ui/swift-ui/modifiers";
import { View } from "react-native";

export function NativeToggle({ label, value, onChange }: { label: string; value: boolean; onChange: (value: boolean) => void }) {
  return <Host matchContents><Toggle label={label} isOn={value} onIsOnChange={onChange} /></Host>;
}
export function NativeActionButton({ label, disabled: isDisabled = false, onPress }: { label: string; disabled?: boolean; onPress: () => void }) {
  return <View style={{ minHeight: 52 }}><Host matchContents={{ vertical: true }}>
    <Button label={label} onPress={onPress} modifiers={[buttonStyle("borderedProminent"), controlSize("large"), disabled(isDisabled)]} />
  </Host></View>;
}
