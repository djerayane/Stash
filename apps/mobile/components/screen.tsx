import type { ReactElement, ReactNode } from "react";
import { KeyboardAvoidingView, ScrollView, Text, View, type RefreshControlProps } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { stashTheme } from "@/theme/theme";

export function Screen({ title, children, bottomAction, refreshControl, scrollable = true }: {
  title?: ReactNode;
  children: ReactNode;
  bottomAction?: ReactNode;
  refreshControl?: ReactElement<RefreshControlProps>;
  scrollable?: boolean;
}) {
  const insets = useSafeAreaInsets();
  const content = <>
    {typeof title === "string" ? <Text selectable accessibilityRole="header" style={{
      color: stashTheme.colors.ink,
      fontSize: stashTheme.type.title,
      lineHeight: 38,
      fontWeight: "700",
    }}>{title}</Text> : title}
    {children}
  </>;
  const contentStyle = {
    width: "100%" as const,
    maxWidth: 680,
    alignSelf: "center" as const,
    gap: stashTheme.spacing.lg,
    paddingTop: stashTheme.spacing.lg,
    paddingRight: stashTheme.spacing.lg + insets.right,
    paddingBottom: bottomAction ? stashTheme.spacing.xl : stashTheme.spacing.xl + insets.bottom,
    paddingLeft: stashTheme.spacing.lg + insets.left,
  };

  return <KeyboardAvoidingView testID="screen-keyboard-avoiding-view"
    behavior={process.env.EXPO_OS === "ios" ? "padding" : undefined}
    style={{ flex: 1, backgroundColor: stashTheme.colors.canvas }}>
    {scrollable
      ? <ScrollView contentInsetAdjustmentBehavior="automatic" keyboardShouldPersistTaps="handled"
        refreshControl={refreshControl} contentContainerStyle={contentStyle}>{content}</ScrollView>
      : <View style={[contentStyle, { flex: 1 }]}>{content}</View>}
    {bottomAction ? <View style={{
      paddingTop: stashTheme.spacing.md,
      paddingRight: stashTheme.spacing.lg + insets.right,
      paddingBottom: Math.max(insets.bottom, stashTheme.spacing.md),
      paddingLeft: stashTheme.spacing.lg + insets.left,
      borderTopWidth: 1,
      borderTopColor: stashTheme.colors.rule,
      backgroundColor: stashTheme.colors.canvas,
    }}>
      <View style={{ width: "100%", maxWidth: 680, alignSelf: "center" }}>{bottomAction}</View>
    </View> : null}
  </KeyboardAvoidingView>;
}
