import { render, screen } from "@testing-library/react";
import { expect, test } from "vitest";
import { AppShell } from "./app-shell";

test("renders the member workspace navigation", () => {
  render(<AppShell />);
  expect(screen.getByRole("navigation", { name: "Workspace" })).toBeInTheDocument();
  expect(screen.getByRole("link", { name: "Notes" })).toHaveAttribute("href", "/notes");
  expect(screen.getByRole("link", { name: "Tasks" })).toHaveAttribute("href", "/tasks");
});
