import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { Text } from "react-native";
import { afterEach, describe, expect, it, vi } from "vitest";

import { CaptureScreenComposition } from "./capture-screen";

vi.mock("react-native-safe-area-context", () => ({ useSafeAreaInsets: () => ({ top: 0, right: 0, bottom: 24, left: 0 }) }));

afterEach(cleanup);

describe("CaptureScreenComposition", () => {
  it("integrates status, destinations, composer, media, collapsed structure, and the stable Save contract", () => {
    const save = vi.fn();
    render(<CaptureScreenComposition
      status={{ variant: "waiting", message: "Saved captures synchronize when your Instance is reachable." }}
      destinations={<Text>Capture destinations</Text>}
      content="Remember this"
      checklist={false}
      onContentChange={vi.fn()}
      onChecklistChange={vi.fn()}
      media={<Text>Media controls</Text>}
      structure={<Text>Project Atlas</Text>}
      saveLabel="Save capture"
      saveDisabled={false}
      onSave={save}
    />);

    const status = screen.getByRole("status");
    const destinations = screen.getByText("Capture destinations");
    const composer = screen.getByLabelText("Note text");
    const media = screen.getByText("Media controls");
    const structure = screen.getByRole("button", { name: "Add project, tag, or reminder" });
    const saveButton = screen.getByRole("button", { name: "Save capture" });
    for (const [before, after] of [[status, destinations], [destinations, composer], [composer, media], [media, structure], [structure, saveButton]]) {
      expect(before.compareDocumentPosition(after) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    }
    expect((saveButton as HTMLButtonElement).disabled).toBe(false);
    expect(getComputedStyle(saveButton).minHeight).toBe("44px");
    expect(getComputedStyle(saveButton).backgroundColor).toBe("rgb(191, 56, 31)");
    expect(screen.queryByText("Project Atlas")).toBeNull();

    fireEvent.click(structure);
    expect(screen.getByText("Project Atlas")).toBeTruthy();
    fireEvent.click(saveButton);
    expect(save).toHaveBeenCalledOnce();
  });
});
