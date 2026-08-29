import { Text, View } from "react-native";

import type { MobileStatusVariant } from "@/src/mobile-status-presentation";
import { stashTheme } from "@/theme/theme";

const defaultMessages: Record<MobileStatusVariant, string> = {
  saved: "Saved on this device",
  waiting: "Waiting to synchronize",
  synchronized: "Synchronized",
  attention: "Needs attention",
  error: "Could not save",
};

const variants = {
  saved: { backgroundColor: stashTheme.colors.successSurface, marker: stashTheme.colors.success, color: stashTheme.colors.ink },
  waiting: { backgroundColor: stashTheme.colors.canvasDeep, marker: stashTheme.colors.secondaryInk, color: stashTheme.colors.ink },
  synchronized: { backgroundColor: stashTheme.colors.successSurface, marker: stashTheme.colors.sage, color: stashTheme.colors.ink },
  attention: { backgroundColor: stashTheme.colors.canvasDeep, marker: stashTheme.colors.accent, color: stashTheme.colors.ink },
  error: { backgroundColor: stashTheme.colors.canvasDeep, marker: stashTheme.colors.error, color: stashTheme.colors.error },
} as const;

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
    <View testID="mobile-status-marker" accessibilityElementsHidden
      style={{ width: 7, height: 7, borderRadius: 999, backgroundColor: style.marker }} />
    <Text selectable style={{ flex: 1, color: style.color, fontSize: stashTheme.type.caption, lineHeight: 18 }}>
      {message ?? defaultMessages[variant]}
    </Text>
  </View>;
}
