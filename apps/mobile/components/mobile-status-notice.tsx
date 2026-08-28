import { Text, View } from "react-native";

import { stashTheme } from "@/theme/theme";

export type MobileStatusVariant = "saved" | "waiting" | "synchronized" | "attention" | "error";

const defaultMessages: Record<MobileStatusVariant, string> = {
  saved: "Saved on this device",
  waiting: "Waiting to synchronize",
  synchronized: "Synchronized",
  attention: "Needs attention",
  error: "Could not save",
};

const variants = {
  saved: { backgroundColor: stashTheme.colors.successSurface, marker: stashTheme.colors.success, color: stashTheme.colors.ink },
  waiting: { backgroundColor: stashTheme.colors.canvasDeep, marker: stashTheme.colors.sage, color: stashTheme.colors.ink },
  synchronized: { backgroundColor: stashTheme.colors.successSurface, marker: stashTheme.colors.success, color: stashTheme.colors.ink },
  attention: { backgroundColor: stashTheme.colors.canvasDeep, marker: stashTheme.colors.accent, color: stashTheme.colors.ink },
  error: { backgroundColor: stashTheme.colors.canvasDeep, marker: stashTheme.colors.error, color: stashTheme.colors.error },
} as const;

export function mobileStatusVariantForMessage(message: string): MobileStatusVariant {
  const value = message.toLocaleLowerCase();
  if (/needs attention|needs your attention|blocked|conflict/.test(value)) return "attention";
  if (/could not|failed|denied|invalid|not saved|pair the app/.test(value)) return "error";
  if (/synchronized|synchronization complete/.test(value)) return "synchronized";
  if (/saved (securely )?on this device|showing the workspace saved on this device/.test(value)) return "saved";
  return "waiting";
}

export function MobileStatusNotice({ variant, message }: { variant: MobileStatusVariant; message?: string }) {
  const style = variants[variant];
  return <View role="status" accessibilityLiveRegion="polite" style={{
    minHeight: stashTheme.controlHeight,
    flexDirection: "row",
    alignItems: "center",
    gap: stashTheme.spacing.sm,
    paddingHorizontal: stashTheme.spacing.md,
    paddingVertical: stashTheme.spacing.sm,
    borderRadius: stashTheme.radius.control,
    borderCurve: "continuous",
    backgroundColor: style.backgroundColor,
  }}>
    <View accessibilityElementsHidden style={{ width: 7, height: 7, borderRadius: 999, backgroundColor: style.marker }} />
    <Text selectable style={{ flex: 1, color: style.color, fontSize: stashTheme.type.caption, lineHeight: 18 }}>
      {message ?? defaultMessages[variant]}
    </Text>
  </View>;
}
