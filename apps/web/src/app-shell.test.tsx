import { act, render, screen } from "@testing-library/react";
import { useState } from "react";
import { MemoryRouter, useLocation } from "react-router";
import { afterEach, expect, test, vi } from "vitest";
import { AppShell, displayLabel, initials, type SessionState } from "./app-shell";

const member: SessionState = {
  status: "authenticated",
  member: { name: "Ada Lovelace", email: "ada@example.com" },
  workspace: { name: "Engine Room" },
  capabilities: [],
};

function LocationProbe() {
  const location = useLocation();
  return <output data-testid="location">{`${location.pathname}${location.search}`}</output>;
}

function renderShell(initialEntry = "/", session: SessionState = member) {
  return render(
    <MemoryRouter initialEntries={[initialEntry]}>
      <AppShell session={session} />
      <LocationProbe />
    </MemoryRouter>,
  );
}

function AuthTransitionHarness() {
  const [session, setSession] = useState<SessionState>({ status: "anonymous" });
  return <><button type="button" onClick={() => setSession(member)}>Authenticate</button><AppShell session={session} /><LocationProbe /></>;
}

afterEach(() => vi.restoreAllMocks());

test("protects deep links and retains the intended destination", async () => {
  render(<MemoryRouter initialEntries={["/app/tasks?assigned=me"]}><AuthTransitionHarness /></MemoryRouter>);
  expect(await screen.findByRole("heading", { name: "Sign in to Stash" })).toBeInTheDocument();
  expect(screen.getByTestId("location")).toHaveTextContent("/sign-in?returnTo=%2Fapp%2Ftasks%3Fassigned%3Dme");
  expect(screen.queryByRole("navigation", { name: "Workspace" })).not.toBeInTheDocument();
  act(() => screen.getByRole("button", { name: "Authenticate" }).click());
  expect(screen.getByTestId("location")).toHaveTextContent("/app/tasks?assigned=me");
  expect(screen.getByRole("heading", { name: "Tasks" })).toBeInTheDocument();
});

test("renders authenticated navigation and deep-linkable route content", async () => {
  renderShell("/app/tasks");
  expect(await screen.findByRole("heading", { name: "Tasks" })).toBeInTheDocument();
  expect(screen.getByRole("navigation", { name: "Workspace" })).toBeInTheDocument();
  expect(screen.getByRole("link", { name: "Tasks" })).toHaveAttribute("aria-current", "page");
  expect(screen.getAllByText("Engine Room")).not.toHaveLength(0);
  expect(screen.getByText("ER")).toBeInTheDocument();
  expect(screen.getByText("AL")).toBeInTheDocument();
});

test("derives identity labels and initials with explicit fallbacks", () => {
  expect(displayLabel("  Project Atlas  ", "Personal workspace")).toBe("Project Atlas");
  expect(displayLabel("   ", "Personal workspace")).toBe("Personal workspace");
  expect(initials("Project Atlas", "PW")).toBe("PA");
  expect(initials("", "M")).toBe("M");
  renderShell("/app/tasks", { status: "authenticated", member: { name: "", email: "member@example.com" }, workspace: { name: "" }, capabilities: [] });
  expect(screen.getAllByText("Personal workspace")).not.toHaveLength(0);
  expect(screen.getByText("PW")).toBeInTheDocument();
  expect(screen.getAllByText("member@example.com")).toHaveLength(2);
  expect(screen.getByText("M")).toBeInTheDocument();
});

test("rejects a return destination outside the authenticated application", () => {
  renderShell("/sign-in?returnTo=https%3A%2F%2Fevil.example");
  expect(screen.getByTestId("location")).toHaveTextContent("/app");
  expect(screen.getByRole("heading", { name: "Good morning." })).toBeInTheDocument();
});

test.each([
  [{ status: "loading" } satisfies SessionState, "Opening your workspace"],
  [{ status: "error", message: "The Instance could not be reached." } satisfies SessionState, "Workspace unavailable"],
])("renders a visible application state", (session, heading) => {
  renderShell("/", session);
  expect(screen.getByRole("heading", { name: heading })).toBeInTheDocument();
});

test("offers a recoverable error action", () => {
  const retry = vi.fn();
  const error = { status: "error", message: "The Instance could not be reached.", retry } satisfies SessionState;
  const view = render(<MemoryRouter><AppShell session={error} /></MemoryRouter>);
  act(() => screen.getByRole("button", { name: "Try again" }).focus());
  view.rerender(<MemoryRouter><AppShell session={error} /></MemoryRouter>);
  expect(screen.getByRole("button", { name: "Try again" })).toHaveFocus();
  act(() => screen.getByRole("button", { name: "Try again" }).click());
  expect(retry).toHaveBeenCalledOnce();
});

test("provides an empty dashboard with one clear next action", () => {
  renderShell("/app");
  expect(screen.getByRole("heading", { name: "Nothing needs your attention" })).toBeInTheDocument();
  expect(screen.getAllByRole("link", { name: "Capture a note" })[0]).toHaveAttribute("href", "/app/notes/new");
});

test("exposes controls only for implemented shell actions", () => {
  renderShell("/app/tasks");
  expect(screen.queryByRole("button")).not.toBeInTheDocument();
  expect(screen.queryByRole("link", { name: "New task" })).not.toBeInTheDocument();
  expect(screen.getByText("New task")).toBeInTheDocument();
  expect(screen.getByText("Search coming soon")).toBeInTheDocument();
  expect(screen.getByRole("link", { name: "New note" })).toHaveAttribute("href", "/app/notes/new");
});
