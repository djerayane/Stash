import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import type { CollectionProperty } from "@stash/domain-types";
import { CollectionCell, CollectionDraftControl, dateDraftValue, dateValueDraft } from "./collection-cell";

const textProperty: CollectionProperty = { id: "11111111-1111-4111-8111-111111111111", name: "Name", type: "text", position: 1 };
const selectProperty: CollectionProperty = { id: "22222222-2222-4222-8222-222222222222", name: "Status", type: "single_select", position: 2,
  options: [{ id: "open", name: "Open" }, { id: "done", name: "Done" }] };
const dateProperty: CollectionProperty = { id: "33333333-3333-4333-8333-333333333333", name: "When", type: "date_time", position: 3 };

describe("Collection cell editing", () => {
  it("round-trips date-only values and timed instants without applying the timezone twice", () => {
    const dateOnly = dateValueDraft({ start: "2026-08-28", includeTime: false }, 120);
    const timed = dateValueDraft({ start: "2026-08-28T09:00:00.000Z", includeTime: true }, 120);

    expect(dateOnly).toEqual({ kind: "date_time", value: "2026-08-28", includeTime: false });
    expect(dateDraftValue(dateOnly, 120)).toEqual({ start: "2026-08-28", includeTime: false });
    expect(timed).toEqual({ kind: "date_time", value: "2026-08-28T11:00", includeTime: true });
    expect(dateDraftValue(timed, 120)).toEqual({ start: "2026-08-28T09:00:00.000Z", includeTime: true });
  });

  it("keeps the entered draft after repeated save failures and disables editing while a save is pending", async () => {
    let settle: (() => void) | undefined;
    const onSave = vi.fn()
      .mockRejectedValueOnce(new Error("offline"))
      .mockRejectedValueOnce(new Error("still offline"))
      .mockImplementationOnce(() => new Promise<void>((resolve) => { settle = resolve; }));
    render(<CollectionCell property={textProperty} value="Saved" recordLabel="Saved" editable onSave={onSave} onNavigate={vi.fn()} />);
    const input = screen.getByRole("textbox", { name: "Name, Saved" });

    fireEvent.change(input, { target: { value: "Keep this draft" } }); fireEvent.keyDown(input, { key: "Enter" });
    expect(await screen.findByRole("alert")).toHaveTextContent("Value not saved");
    fireEvent.click(screen.getByRole("button", { name: "Retry Name" }));
    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(2));
    expect(input).toHaveValue("Keep this draft");

    fireEvent.click(screen.getByRole("button", { name: "Retry Name" }));
    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(3));
    expect(input).toBeDisabled();
    settle?.(); await waitFor(() => expect(input).not.toBeDisabled());
  });

  it("leaves arrow keys native inside select and date controls", () => {
    const navigate = vi.fn(); const { rerender } = render(<CollectionDraftControl property={selectProperty} value="open" label="Status"
      onChange={vi.fn()} onNavigate={navigate} />);
    fireEvent.keyDown(screen.getByRole("combobox", { name: "Status" }), { key: "ArrowDown" });
    expect(navigate).not.toHaveBeenCalled();

    rerender(<CollectionDraftControl property={dateProperty} value={{ kind: "date_time", value: "2026-08-28T11:00", includeTime: true }}
      label="When" onChange={vi.fn()} onNavigate={navigate} />);
    fireEvent.keyDown(screen.getByLabelText("When"), { key: "ArrowRight" });
    expect(navigate).not.toHaveBeenCalled();
  });

  it("renders date-only values legibly in read-only tables", () => {
    render(<CollectionCell property={dateProperty} value={{ start: "2026-08-28", includeTime: false }} recordLabel="Milestone"
      editable={false} onSave={vi.fn()} onNavigate={vi.fn()} />);
    expect(screen.getByText("2026-08-28")).toBeVisible();
  });
});
