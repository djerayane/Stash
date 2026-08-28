import { Stack } from "expo-router";
import { StatusBar } from "expo-status-bar";

import { ensureDomException } from "@/src/native-runtime";
import { stashTheme } from "@/theme/theme";

ensureDomException(globalThis);

export default function RootLayout() {
  return <>
    <StatusBar style="dark" backgroundColor={stashTheme.colors.canvas} />
    <Stack screenOptions={{
      headerLargeTitle: true,
      headerShadowVisible: false,
      headerTintColor: stashTheme.colors.accent,
      headerStyle: { backgroundColor: stashTheme.colors.canvas },
      headerLargeStyle: { backgroundColor: stashTheme.colors.canvas },
      headerTitleStyle: { color: stashTheme.colors.ink },
      headerLargeTitleStyle: { color: stashTheme.colors.ink },
      contentStyle: { backgroundColor: stashTheme.colors.canvas },
    }}>
      <Stack.Screen name="index" options={{ title: "Capture" }} />
      <Stack.Screen name="workspace" options={{ title: "Workspace" }} />
      <Stack.Screen name="pairing" options={{ title: "Pair Instance" }} />
    </Stack>
  </>;
}
