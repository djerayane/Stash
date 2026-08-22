import { Button, Host, Switch, Text } from "@expo/ui/jetpack-compose";
import { Row } from "@expo/ui/jetpack-compose";

export function NativeToggle({ label, value, onChange }: { label: string; value: boolean; onChange: (value: boolean) => void }) {
  return <Host matchContents><Row><Text>{label}</Text><Switch value={value} onCheckedChange={onChange} /></Row></Host>;
}
export function NativeActionButton({ label, disabled = false, onPress }: { label: string; disabled?: boolean; onPress: () => void }) {
  return <Host matchContents><Button enabled={!disabled} onClick={onPress}><Text>{label}</Text></Button></Host>;
}
