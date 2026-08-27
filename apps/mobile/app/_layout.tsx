import { Stack } from "expo-router";

export default function RootLayout() {
  return <Stack screenOptions={{ headerLargeTitle: true }}>
    <Stack.Screen name="index" options={{ title: "Capture" }} />
    <Stack.Screen name="workspace" options={{ title: "Workspace" }} />
    <Stack.Screen name="pairing" options={{ title: "Pair Instance" }} />
  </Stack>;
}
