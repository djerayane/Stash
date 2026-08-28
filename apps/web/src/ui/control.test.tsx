import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { Button, IconButton, StatusNotice } from "./control";

describe("shared controls", () => {
  it("keeps pending actions named and unavailable", () => {
    render(<Button pending pendingLabel="Saving capture">Save capture</Button>);

    expect(screen.getByRole("button", { name: "Saving capture" })).toBeDisabled();
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
