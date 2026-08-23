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
      if (String(input).endsWith("/repository-connections")) return Response.json({ repositoryConnections: [] });
      if (String(input).endsWith("/development-artifacts")) return Response.json({ artifacts: [] });
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
      if (String(input).endsWith("/repository-connections")) return Response.json({ repositoryConnections: [] });
      if (String(input).endsWith("/development-artifacts")) return Response.json({ artifacts: [] });
      attempts += 1;
      return attempts === 1 ? Response.json({ message: "Signals are temporarily unavailable." }, { status: 503 }) : Response.json({ signals: [] });
    });
    renderPage(fetcher);
    expect(await screen.findByRole("alert")).toHaveTextContent("Signals are temporarily unavailable.");
    expect(screen.getByRole("alert")).toHaveFocus();
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByText("No development activity yet")).toBeVisible();
  });

  it("creates a branch through a named Project Repository Connection", async () => {
    const requests: Array<{ path: string; body?: string }> = [];
    const fetcher = vi.fn<typeof fetch>(async (input, init) => {
      const path = String(input); requests.push({ path, body: typeof init?.body === "string" ? init.body : undefined });
      if (path.endsWith("/repository-connections")) return Response.json({ repositoryConnections: [{ id: "22222222-2222-4222-8222-222222222222", repositoryUrl: "https://github.com/acme/stash" }] });
      if (path.endsWith("/development-artifacts") && init?.method === "POST") return Response.json({ artifact: { kind: "branch", providerId: "refs/heads/STASH-36-work", url: "https://github.com/acme/stash/tree/STASH-36-work", label: "STASH-36-work" } }, { status: 201 });
      if (path.endsWith("/development-artifacts")) return Response.json({ artifacts: [] });
      if (path.endsWith("/automations")) return Response.json({ automation: { recipes: [], transitions: [], availableStatuses: [] } });
      return Response.json({ signals: [] });
    });
    renderPage(fetcher);
    expect(await screen.findByRole("combobox", { name: "Repository" })).toHaveDisplayValue("acme/stash");
    fireEvent.change(screen.getByRole("textbox", { name: "Branch name (optional)" }), { target: { value: "STASH-36-work" } });
    fireEvent.click(screen.getByRole("button", { name: "Create branch" }));
    await waitFor(() => expect(requests.some(({ body }) => body?.includes('"action":"create_branch"') && body.includes('"connectionId":"22222222-2222-4222-8222-222222222222"'))).toBe(true));
  });
});
