import gsap from "gsap";
import { useEffect, useRef } from "react";
import { Text, View } from "react-native";
import { colors } from "@/theme/colors";

export function StatusFeedback({ message }: { message: string }) {
  const ref = useRef<View>(null);
  useEffect(() => {
    if (matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const node = ref.current as unknown as HTMLElement;
    const tween = gsap.fromTo(node, { autoAlpha: 0 }, { autoAlpha: 1, duration: 0.16, ease: "power2.out" });
    return () => { tween.kill(); };
  }, [message]);
  return <View ref={ref} key={message}><Text selectable accessibilityLiveRegion="polite" style={{ color: colors.secondaryLabel, fontSize: 15, lineHeight: 21 }}>{message}</Text></View>;
}
