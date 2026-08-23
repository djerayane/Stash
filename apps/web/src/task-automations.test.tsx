import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { TaskAutomations } from "./task-automations";

function setup(fetcher: typeof fetch) {
  render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })}>
    <TaskAutomations projectId="project" taskKey="STASH-37" fetcher={fetcher} token="member" />
  </QueryClientProvider>);
}

const state = { recipes: [{ id: "recipe", trigger: "branch_created", targetStatus: { id: "progress", name: "In progress" }, enabled: true }],
  transitions: [{ id: "transition", automationId: "recipe", signalId: "signal", before: { id: "ready", name: "Ready" }, after: { id: "progress", name: "In progress" }, occurredAt: "2026-08-23T09:00:00.000Z" }],
  availableStatuses: [{ id: "progress", name: "In progress" }] };

describe("Task Automations", () => {
  it("renders an explainable When/If/Then recipe and reversible transition", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ automation: state }));
    setup(fetcher);
    expect(await screen.findByText("When a branch is created")).toBeVisible();
    expect(screen.getByText("Ready → In progress")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Undo status change" }));
    await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(2));
    expect(fetcher.mock.calls[1]?.[1]).toMatchObject({ method: "POST" });
  });

  it("focuses a recoverable failure and retries", async () => {
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json({ message: "Automations are unavailable." }, { status: 503 }))
      .mockResolvedValueOnce(Response.json({ automation: { ...state, transitions: [] } }));
    setup(fetcher);
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveFocus();
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByText("When a branch is created")).toBeVisible();
  });

  it("focuses a failed reversal and retries it without losing the transition", async () => {
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json({ automation: state }))
      .mockResolvedValueOnce(Response.json({ message: "The status could not be restored." }, { status: 503 }))
      .mockResolvedValueOnce(Response.json({ transition: { ...state.transitions[0], reversedAt: "2026-08-23T10:00:00.000Z" } }))
      .mockResolvedValueOnce(Response.json({ automation: { ...state, transitions: [{ ...state.transitions[0], reversedAt: "2026-08-23T10:00:00.000Z" }] } }));
    setup(fetcher);
    fireEvent.click(await screen.findByRole("button", { name: "Undo status change" }));
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveFocus();
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByText("Reversed")).toBeVisible();
  });
});
