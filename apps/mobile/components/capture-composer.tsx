import type { ReactNode } from "react";
import { useState } from "react";
import { Pressable, Text, TextInput, View } from "react-native";

import { NativeToggle } from "@/components/native-controls";
import { stashTheme } from "@/theme/theme";

export function CaptureComposer({ content, checklist, onContentChange, onChecklistChange, media, structure }: {
  content: string;
  checklist: boolean;
  onContentChange(value: string): void;
  onChecklistChange(value: boolean): void;
  media: ReactNode;
  structure: ReactNode;
}) {
  const [structureOpen, setStructureOpen] = useState(false);
  return <View style={{ gap: stashTheme.spacing.lg }}>
    <TextInput
      accessibilityLabel={checklist ? "Checklist title and items" : "Note text"}
      multiline
      autoFocus
      value={content}
      onChangeText={onContentChange}
      placeholder={checklist ? "Title, then one item per line" : "What do you want to remember?"}
      placeholderTextColor={stashTheme.colors.secondaryInk}
      style={{
        minHeight: 190,
        borderWidth: 1,
        borderColor: stashTheme.colors.rule,
        color: stashTheme.colors.ink,
        backgroundColor: stashTheme.colors.surface,
        borderRadius: stashTheme.radius.surface,
        borderCurve: "continuous",
        padding: stashTheme.spacing.lg,
        fontSize: 18,
        lineHeight: 26,
        textAlignVertical: "top",
      }}
    />
    <NativeToggle label="Checklist capture" value={checklist} onChange={onChecklistChange} />
    <View accessibilityRole="summary" style={{ gap: stashTheme.spacing.md }}>{media}</View>
    <View style={{ gap: stashTheme.spacing.md }}>
      <Pressable accessibilityRole="button" accessibilityLabel="Add project, tag, or reminder"
        accessibilityState={{ expanded: structureOpen }} onPress={() => setStructureOpen((value) => !value)} style={({ pressed }) => ({
          minHeight: stashTheme.controlHeight,
          justifyContent: "center",
          paddingHorizontal: stashTheme.spacing.md,
          borderRadius: stashTheme.radius.control,
          borderCurve: "continuous",
          borderWidth: 1,
          borderColor: structureOpen ? stashTheme.colors.accent : stashTheme.colors.rule,
          backgroundColor: pressed ? stashTheme.colors.canvasDeep : stashTheme.colors.surface,
        })}>
        <Text style={{ color: stashTheme.colors.ink, fontSize: stashTheme.type.body, fontWeight: "600" }}>
          {structureOpen ? "Hide optional structure" : "Add project, tag, or reminder"}
        </Text>
      </Pressable>
      {structureOpen ? <View style={{ gap: stashTheme.spacing.md }}>{structure}</View> : null}
    </View>
  </View>;
}
