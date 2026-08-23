import { DropdownMenuItem, ExposedDropdownMenu, ExposedDropdownMenuBox, Host, Text, TextField } from "@expo/ui/jetpack-compose";
import { menuAnchor } from "@expo/ui/jetpack-compose/modifiers";
import { useState } from "react";

import type { NativeChoiceProps } from "./native-choice.types";

export function NativeChoice({ label, value, items, onChange }: NativeChoiceProps) {
  const [expanded, setExpanded] = useState(false);
  const selected = items.find((item) => item.value === value)?.label ?? "None";
  const choices = [{ value: "", label: "None" }, ...items];
  return <Host matchContents>
    <ExposedDropdownMenuBox expanded={expanded} onExpandedChange={setExpanded}>
      <TextField key={`${label}:${selected}`} defaultValue={selected} readOnly singleLine modifiers={[menuAnchor()]}>
        <TextField.Label><Text>{label}</Text></TextField.Label>
      </TextField>
      <ExposedDropdownMenu expanded={expanded} onDismissRequest={() => setExpanded(false)}>
        {choices.map((item) => <DropdownMenuItem key={item.value} onClick={() => {
          onChange(item.value || undefined); setExpanded(false);
        }}><DropdownMenuItem.Text><Text>{item.label}</Text></DropdownMenuItem.Text></DropdownMenuItem>)}
      </ExposedDropdownMenu>
    </ExposedDropdownMenuBox>
  </Host>;
}
