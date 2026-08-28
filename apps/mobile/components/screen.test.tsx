import { cleanup, render, screen } from "@testing-library/react";
import { Pressable, Text } from "react-native";
import { afterEach, describe, expect, it, vi } from "vitest";

import { Screen } from "./screen";

vi.mock("react-native-safe-area-context", () => ({ useSafeAreaInsets: () => ({ top: 0, right: 0, bottom: 24, left: 0 }) }));
vi.mock("react-native", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react-native")>();
  return {
    ...actual,
    KeyboardAvoidingView: ({ behavior, testID, children, ...props }: {
      behavior?: string; testID?: string; children?: React.ReactNode;
    }) => <div data-testid={testID} data-keyboard-behavior={behavior} {...props}>{children}</div>,
  };
});

afterEach(() => { cleanup(); delete process.env.EXPO_OS; });

describe("Screen", () => {
  it("keeps a named title and bottom action around the readable content measure", () => {
    render(<Screen title="Capture" bottomAction={<Pressable accessibilityRole="button"><Text>Save capture</Text></Pressable>}>
      <Text>Composer</Text>
    </Screen>);

    const title = screen.getByRole("heading", { name: "Capture" });
    const composer = screen.getByText("Composer");
    const action = screen.getByRole("button", { name: "Save capture" });
    expect(title.compareDocumentPosition(composer) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(composer.compareDocumentPosition(action) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("moves the stable bottom action above the iOS software keyboard", () => {
    process.env.EXPO_OS = "ios";
    render(<Screen bottomAction={<Pressable accessibilityRole="button"><Text>Pair Instance</Text></Pressable>}>
      <Text>Pairing fields</Text>
    </Screen>);

    expect(screen.getByTestId("screen-keyboard-avoiding-view").getAttribute("data-keyboard-behavior")).toBe("padding");
  });
});
