import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";

import { InboxPage, NotificationsPage } from "./core-workflows";

function renderWorkflow(node: React.ReactNode) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(<QueryClientProvider client={client}><MemoryRouter>{node}</MemoryRouter></QueryClientProvider>);
}

afterEach(() => vi.restoreAllMocks());

describe("core React workflows", () => {
  it("captures an Inbox Note through the canonical API and refreshes the list", async () => {
    let notes: { id: string; content: string }[] = [];
    const fetcher = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === "POST") notes = [{ id: "note-1", content: JSON.parse(String(init.body)).content }];
      return new Response(JSON.stringify(init?.method === "POST" ? notes[0] : { notes }), { status: init?.method === "POST" ? 201 : 200, headers: { "content-type": "application/json" } });
    });
    renderWorkflow(<InboxPage fetcher={fetcher as typeof fetch} token="member-token" workspaceId="workspace-1" />);
    await screen.findByText("Your Inbox is clear");
    fireEvent.click(screen.getByRole("button", { name: "Capture Note" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Note content" }), { target: { value: "Plan the release" } });
    fireEvent.click(screen.getByRole("button", { name: /^Capture$/ }));
    expect(await screen.findByRole("heading", { name: "Plan the release" })).toBeVisible();
    expect(fetcher).toHaveBeenCalledWith("/api/workspaces/workspace-1/notes", expect.objectContaining({ method: "POST" }));
  });

  it("keeps a failed remote view recoverable and moves focus to the alert", async () => {
    let attempts = 0;
    const fetcher = vi.fn(async () => { attempts += 1; return attempts === 1 ? new Response(JSON.stringify({ message: "Notifications unavailable" }), { status: 503 }) : new Response(JSON.stringify({ notifications: [] }), { status: 200 }); });
    renderWorkflow(<NotificationsPage fetcher={fetcher as typeof fetch} token="member-token" />);
    const alert = await screen.findByRole("alert");
    await waitFor(() => expect(alert).toHaveFocus());
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByText("You are caught up")).toBeVisible();
    expect(attempts).toBe(2);
  });
});
