import Animated, { FadeIn, FadeOut, ReduceMotion } from "react-native-reanimated";
import { Text } from "react-native";
import { colors } from "@/theme/colors";

export function StatusFeedback({ message }: { message: string }) {
  return <Animated.View key={message} entering={FadeIn.duration(160).reduceMotion(ReduceMotion.System)} exiting={FadeOut.duration(120).reduceMotion(ReduceMotion.System)}>
    <Text selectable accessibilityLiveRegion="polite" style={{ color: colors.secondaryLabel, fontSize: 15, lineHeight: 21 }}>{message}</Text>
  </Animated.View>;
}
