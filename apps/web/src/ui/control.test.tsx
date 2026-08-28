import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { Button, Field, FilterDisclosure, IconButton, StatusNotice } from "./control";

describe("shared controls", () => {
  it("keeps pending actions named and unavailable", () => {
    render(<Button pending>Save capture</Button>);

    expect(screen.getByRole("button", { name: "Saving capture" })).toBeDisabled();
  });

  it("exposes the complete action hierarchy", () => {
    render(<><Button variant="primary">Save</Button><Button variant="secondary">Cancel</Button><Button variant="danger">Delete</Button></>);

    expect(screen.getByRole("button", { name: "Save" })).toHaveAttribute("data-variant", "primary");
    expect(screen.getByRole("button", { name: "Cancel" })).toHaveAttribute("data-variant", "secondary");
    expect(screen.getByRole("button", { name: "Delete" })).toHaveAttribute("data-variant", "danger");
  });

  it("forwards wrapper semantics through fields", () => {
    render(<Field label="Title" data-source="collection" className="consumer"><input /></Field>);

    expect(screen.getByText("Title").closest("label")).toHaveAttribute("data-source", "collection");
    expect(screen.getByText("Title").closest("label")).toHaveClass("consumer");
  });

  it("exposes the common Filters disclosure without hiding consumer content", () => {
    render(<FilterDisclosure className="consumer"><Button variant="secondary">My Tasks</Button></FilterDisclosure>);

    const summary = screen.getByText("Filters", { selector: "summary" });
    const disclosure = screen.getByRole("group", { name: "Filters" });
    expect(disclosure).toHaveClass("consumer");
    expect(disclosure).toHaveAttribute("open");
    expect(screen.getByRole("button", { name: "My Tasks" })).toBeVisible();
    fireEvent.click(summary);
    expect(disclosure).not.toHaveAttribute("open");
  });

  it("requires icon controls to expose their action", () => {
    render(<IconButton label="Add property">+</IconButton>);

    expect(screen.getByRole("button", { name: "Add property" })).toBeVisible();
  });

  it("announces status without making settled feedback urgent", () => {
    render(<StatusNotice tone="success">Synchronized</StatusNotice>);

    expect(screen.getByRole("status")).toHaveTextContent("Synchronized");
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });
});
