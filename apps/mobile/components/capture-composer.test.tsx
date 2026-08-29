import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { Text } from "react-native";
import { afterEach, describe, expect, it, vi } from "vitest";

import { CaptureComposer } from "./capture-composer";

afterEach(cleanup);

describe("CaptureComposer", () => {
  it("keeps optional structure collapsed after composer mode and media", () => {
    const { container } = render(<CaptureComposer content="" checklist={false} onContentChange={vi.fn()} onChecklistChange={vi.fn()}
      media={<Text>Media controls</Text>} structure={<Text>Project Atlas</Text>} />);

    const composer = screen.getByLabelText("Note text");
    const mode = screen.getByRole("switch", { name: "Checklist capture" });
    const media = screen.getByText("Media controls");
    const structure = screen.getByRole("button", { name: "Add project, tag, or reminder" });
    expect(composer.compareDocumentPosition(mode) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(mode.compareDocumentPosition(media) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(media.compareDocumentPosition(structure) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(container.textContent).not.toContain("Project Atlas");

    fireEvent.click(structure);
    expect(screen.getByText("Project Atlas")).toBeTruthy();
  });
});
