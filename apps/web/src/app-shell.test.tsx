import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter, useLocation } from "react-router";
import { expect, test } from "vitest";
import { AppShell } from "./app-shell";

function RoutedShell() {
  const location = useLocation();
  return <><AppShell /><output data-testid="location">{location.pathname}</output></>;
}

test("navigates inside the React application without replacing the document", () => {
  const client = new QueryClient({ defaultOptions: { queries: { enabled: false } } });
  render(<QueryClientProvider client={client}><MemoryRouter><RoutedShell /></MemoryRouter></QueryClientProvider>);
  expect(screen.getByRole("navigation", { name: "Workspace" })).toBeInTheDocument();
  const notes = screen.getByRole("link", { name: "Notes" });
  fireEvent.click(notes);
  expect(screen.getByTestId("location")).toHaveTextContent("/notes");
  expect(notes).toHaveAttribute("aria-current", "page");
  expect(screen.getByRole("link", { name: "Tasks" })).toHaveAttribute("href", "/tasks");
});
