import { Color } from "expo-router";
import { Platform } from "react-native";

export const colors = {
  label: Platform.select({ ios: Color.ios.label, android: Color.android.dynamic.onSurface, default: "#171719" })!,
  secondaryLabel: Platform.select({ ios: Color.ios.secondaryLabel, android: Color.android.dynamic.onSurfaceVariant, default: "#5f6068" })!,
  separator: Platform.select({ ios: Color.ios.separator, android: Color.android.dynamic.outlineVariant, default: "#c7c7cc" })!,
  background: Platform.select({ ios: Color.ios.systemBackground, android: Color.android.dynamic.surface, default: "#ffffff" })!,
  accent: Platform.select({ ios: Color.ios.systemBlue, android: Color.android.dynamic.primary, default: "#2463eb" })!,
  destructive: Platform.select({ ios: Color.ios.systemRed, android: Color.android.dynamic.error, default: "#b42318" })!,
  buttonText: Platform.select({ ios: Color.ios.white, android: Color.android.dynamic.onPrimary, default: "#ffffff" })!,
};
