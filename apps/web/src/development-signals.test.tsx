import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { MemoryRouter } from "react-router";

import { DevelopmentSignalsPage } from "./development-signals";

const signal = { id: "signal-1", deliveryId: "delivery", repositoryId: "987", kind: "pull_request", providerId: "42", url: "https://github.com/acme/stash/pull/42", label: "#42 Shared work", occurredAt: "2026-08-23T08:00:00.000Z" };
const suggestion = { id: "11111111-1111-4111-8111-111111111111", signalId: "signal-1", taskId: "task", projectId: "project", taskKey: "STASH-36", taskTitle: "Receive GitHub development Signals", matchedKey: "OLD-1", status: "pending_confirmation" };

function renderPage(fetcher: typeof fetch) {
  return render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })}>
    <MemoryRouter><DevelopmentSignalsPage projectId="project" taskKey="STASH-36" fetcher={fetcher} token="member" /></MemoryRouter>
  </QueryClientProvider>);
}

describe("development Signals", () => {
  it("shows activity and confirms an ambiguous suggestion without reloading", async () => {
    let confirmed = false;
    const fetcher = vi.fn<typeof fetch>(async (input, init) => {
      if (String(input).endsWith("/automations")) return Response.json({ automation: { recipes: [], transitions: [], availableStatuses: [] } });
      if (init?.method === "POST") { confirmed = true; return Response.json({ suggestion: { ...suggestion, status: "confirmed" } }); }
      return Response.json({ signals: [{ signal, suggestions: [{ ...suggestion, status: confirmed ? "confirmed" : "pending_confirmation" }] }] });
    });
    renderPage(fetcher);
    expect(await screen.findByRole("heading", { name: "Development Signals" })).toBeVisible();
    expect(await screen.findByText("#42 Shared work")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Review match" }));
    expect(screen.getByRole("dialog", { name: "Confirm Task relationship" })).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Confirm relationship" }));
    await waitFor(() => expect(screen.getByText("Relationship confirmed")).toBeVisible());
    expect(fetcher.mock.calls.filter(([input]) => String(input).includes("development-signals")).length).toBe(3);
  });

  it("keeps recoverable loading failures visible and retryable", async () => {
    let attempts = 0;
    const fetcher = vi.fn<typeof fetch>(async (input) => {
      if (String(input).endsWith("/automations")) return Response.json({ automation: { recipes: [], transitions: [], availableStatuses: [] } });
      attempts += 1;
      return attempts === 1 ? Response.json({ message: "Signals are temporarily unavailable." }, { status: 503 }) : Response.json({ signals: [] });
    });
    renderPage(fetcher);
    expect(await screen.findByRole("alert")).toHaveTextContent("Signals are temporarily unavailable.");
    expect(screen.getByRole("alert")).toHaveFocus();
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByText("No development activity yet")).toBeVisible();
  });
});
