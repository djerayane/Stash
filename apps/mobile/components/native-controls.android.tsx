import { Button, Host, Switch, Text } from "@expo/ui/jetpack-compose";
import { Row } from "@expo/ui/jetpack-compose";
import { toggleable } from "@expo/ui/jetpack-compose/modifiers";

export function NativeToggle({ label, value, onChange }: { label: string; value: boolean; onChange: (value: boolean) => void }) {
  return <Host matchContents><Row modifiers={[toggleable(value, () => onChange(!value), { role: "switch" })]}>
    <Text>{label}</Text><Switch value={value} />
  </Row></Host>;
}
export function NativeActionButton({ label, disabled = false, onPress }: { label: string; disabled?: boolean; onPress: () => void }) {
  return <Host matchContents><Button enabled={!disabled} onClick={onPress}><Text>{label}</Text></Button></Host>;
}
