import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ActivityPage, DiscussionsPage, InboxPage, NoteHistoryPage, NotificationsPage } from "./core-workflows";

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

  it("replies, resolves, and creates work from selected Discussion messages", async () => {
    const discussionId = "33333333-3333-4333-8333-333333333333";
    const messageId = "44444444-4444-4444-8444-444444444444";
    const otherDiscussionId = "55555555-5555-4555-8555-555555555555";
    const otherMessageId = "66666666-6666-4666-8666-666666666666";
    const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      if (path.endsWith("/api/notes/22222222-2222-4222-8222-222222222222/discussions")) return Response.json({ discussions: [{ id: discussionId, target: { kind: "note", noteId: "22222222-2222-4222-8222-222222222222" }, createdAt: "2026-08-23T00:00:00Z", messages: [{ id: messageId, content: "Preserve this decision", author: { displayName: "Ada" }, createdAt: "2026-08-23T00:00:00Z" }] }, { id: otherDiscussionId, target: { kind: "note", noteId: "22222222-2222-4222-8222-222222222222" }, createdAt: "2026-08-23T00:00:00Z", messages: [{ id: otherMessageId, content: "Unrelated thread", author: { displayName: "Grace" }, createdAt: "2026-08-23T00:00:00Z" }] }] });
      if (path.endsWith(`/api/discussions/${discussionId}/messages`)) return Response.json({ discussion: {} });
      if (path.endsWith(`/api/discussions/${discussionId}/resolution`)) return Response.json({ discussion: {} });
      if (path.endsWith(`/api/discussions/${discussionId}/work`)) return Response.json({ work: { kind: "note" } }, { status: 201 });
      return Response.json({});
    });
    const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
    render(<QueryClientProvider client={client}><MemoryRouter initialEntries={["/app/notes/22222222-2222-4222-8222-222222222222/discussions"]}><Routes><Route path="/app/notes/:targetId/discussions" element={<DiscussionsPage targetKind="note" token="member" fetcher={fetcher as typeof fetch} />} /></Routes></MemoryRouter></QueryClientProvider>);
    expect(await screen.findByText("Preserve this decision")).toBeVisible();
    fireEvent.click(screen.getByRole("checkbox", { name: /Preserve this decision/ }));
    fireEvent.click(screen.getByRole("checkbox", { name: /Unrelated thread/ }));
    const createButtons = screen.getAllByRole("button", { name: "Create Note from selection" });
    await waitFor(() => expect(createButtons[0]).toBeEnabled());
    fireEvent.click(createButtons[0]!);
    await waitFor(() => expect(fetcher).toHaveBeenCalledWith(expect.stringContaining(`/api/discussions/${discussionId}/work`), expect.objectContaining({ body: expect.stringContaining(messageId) })));
    const workCall = fetcher.mock.calls.find(([path]) => String(path).endsWith(`/api/discussions/${discussionId}/work`))!;
    expect(String(workCall[1]?.body)).not.toContain(otherMessageId);
    fireEvent.change(screen.getAllByRole("textbox", { name: "Reply" })[0]!, { target: { value: "Follow up" } });
    fireEvent.click(screen.getAllByRole("button", { name: "Reply" })[0]!);
    fireEvent.click(screen.getAllByRole("button", { name: "Resolve Discussion" })[0]!);
    await waitFor(() => expect(fetcher).toHaveBeenCalledWith(expect.stringContaining(`/api/discussions/${discussionId}/messages`), expect.anything()));
    await waitFor(() => expect(fetcher).toHaveBeenCalledWith(expect.stringContaining(`/api/discussions/${discussionId}/resolution`), expect.objectContaining({ method: "PUT" })));
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

  it("renders canonical Activity and Notification meaning instead of invented DTO fields", async () => {
    const activity = { schema: "stash.activity.v1", id: "activity-1", workspaceId: "workspace-1", object: { kind: "Note", id: "note-1" }, action: "note_restored", actor: { localAccountId: "member-1", displayName: "Ada" }, cause: { kind: "member", restorationOfRevision: 2 }, occurredAt: "2026-08-23T00:00:00Z", before: { title: "Draft" }, after: { title: "Final" } } as const;
    const fetcher = vi.fn(async (input: RequestInfo | URL) => Response.json(String(input).includes("notifications") ? { notifications: [{ schema: "stash.notification.v1", id: "notification-1", memberId: "member-1", workspaceId: "workspace-1", trigger: "followed_change", summary: "Release restored", activity, createdAt: activity.occurredAt, delivery: "immediate" }] } : { activities: [activity] }));
    const { unmount } = renderWorkflow(<ActivityPage fetcher={fetcher as typeof fetch} token="member" workspaceId="workspace-1" />);
    expect(await screen.findByText("note restored")).toBeVisible(); expect(screen.getByText(/Ada/)).toBeVisible(); expect(screen.getByText((_text, element) => element?.tagName === "P" && element.textContent?.includes("Before: title: Draft After: title: Final") === true)).toBeVisible(); unmount();
    renderWorkflow(<NotificationsPage fetcher={fetcher as typeof fetch} token="member" />);
    expect(await screen.findByRole("heading", { name: "Release restored" })).toBeVisible(); expect(screen.getByText(/followed change · note restored/)).toBeVisible(); expect(screen.getByText(/Member restoration of revision 2/)).toBeVisible();
  });

  it("reviews and recovers a failed Note history restoration with authoritative revision input", async () => {
    let restores = 0; const fetcher = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => { if (init?.method === "POST") { restores += 1; return restores === 1 ? new Response(JSON.stringify({ message: "Restore temporarily unavailable" }), { status: 503 }) : Response.json({ note: { revision: 3 } }); } return Response.json({ revisions: [{ noteId: "note-1", revision: 2, content: "Earlier durable text", recordedAt: "2026-08-23T00:00:00Z", actor: { localAccountId: "member-1", displayName: "Ada" }, cause: { kind: "member" } }] }); });
    const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } }); render(<QueryClientProvider client={client}><MemoryRouter initialEntries={["/app/notes/note-1/history"]}><Routes><Route path="/app/notes/:noteId/history" element={<NoteHistoryPage token="member" fetcher={fetcher as typeof fetch} />} /></Routes></MemoryRouter></QueryClientProvider>);
    fireEvent.click(await screen.findByRole("button", { name: "Review revision" })); expect(screen.getByText("Earlier durable text")).toBeVisible(); fireEvent.click(screen.getByRole("button", { name: "Confirm restore" })); const alert = await screen.findByRole("alert"); await waitFor(() => expect(alert).toHaveFocus()); fireEvent.click(screen.getByRole("button", { name: "Try restore again" })); expect(await screen.findByRole("status")).toHaveTextContent("Revision 2 restored"); expect(JSON.parse(String(fetcher.mock.calls.find(([, init]) => init?.method === "POST")?.[1]?.body))).toMatchObject({ expectedRevision: 2 });
  });
});
