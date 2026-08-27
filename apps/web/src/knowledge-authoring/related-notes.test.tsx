import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { expect, it, vi } from "vitest";

import { RelatedNotes } from "./related-notes";

const noteId = "11111111-1111-4111-8111-111111111111";
const childId = "22222222-2222-4222-8222-222222222222";
const deeperId = "33333333-3333-4333-8333-333333333333";
const workspaceId = "44444444-4444-4444-8444-444444444444";
const alternateId = "66666666-6666-4666-8666-666666666666";

it("offers bounded progressive relationship navigation with an equivalent keyboard-navigable outline", async () => {
  const requests: Array<{ path: string; method: string; body?: unknown }> = [];
  const fetcher = vi.fn<typeof fetch>(async (input, init) => {
    const path = String(input); const method = init?.method ?? "GET";
    requests.push({ path, method, ...(init?.body ? { body: JSON.parse(String(init.body)) } : {}) });
    if (path.includes("/relationships?") && path.includes("depth=1")) return Response.json({ rootId: noteId, depth: 1, limit: 24,
      direction: path.includes("direction=incoming") ? "incoming" : "both", hasMore: true,
      nodes: [{ id: noteId, title: "Research", depth: 0 }, { id: childId, title: "Evidence", depth: 1 }],
      edges: [{ id: "link-1", sourceNoteId: noteId, targetNoteId: childId, kind: "note-link", relationshipType: "supports" }],
      outline: [{ id: noteId, title: "Research", depth: 0 }, { id: childId, title: "Evidence", depth: 1 }] });
    if (path.includes("/relationships?") && path.includes("depth=2")) return Response.json({ rootId: noteId, depth: 2, limit: 24,
      direction: "both", hasMore: false,
      nodes: [{ id: noteId, title: "Research", depth: 0 }, { id: childId, title: "Evidence", depth: 1 }, { id: deeperId, title: "Decision", depth: 2 }],
      edges: [], outline: [{ id: noteId, title: "Research", depth: 0 }, { id: childId, title: "Evidence", depth: 1 },
        { id: deeperId, title: "Decision", depth: 2 }] });
    if (path.endsWith("/relationships/maintenance")) return Response.json({ orphans: [{ id: deeperId, title: "Decision" }],
      brokenLinks: [{ id: "55555555-5555-4555-8555-555555555555", sourceNoteId: noteId, sourceTitle: "Research",
        label: "Missing source", targetPath: "notes/missing.md", revision: 2, candidates: [
          { id: childId, title: "Evidence" }, { id: alternateId, title: "Alternative evidence" },
        ] }] });
    if (method === "POST" && path.includes("/repair")) return Response.json({ status: "repaired" });
    return new Response(null, { status: 404 });
  });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  render(<QueryClientProvider client={client}><MemoryRouter><RelatedNotes access="edit" fetcher={fetcher}
    noteId={noteId} token="member" workspaceId={workspaceId} /></MemoryRouter></QueryClientProvider>);

  const region = await screen.findByRole("region", { name: "Related Notes" });
  expect(await within(region).findByRole("link", { name: "Evidence" })).toHaveAttribute("href", `/app/notes/${childId}`);
  expect(within(region).getByTestId("relationship-visual")).toHaveAttribute("aria-hidden", "true");
  expect(within(region).getByRole("list", { name: "Related Notes outline" })).toBeVisible();

  fireEvent.click(within(region).getByRole("button", { name: "Expand related Notes" }));
  expect(await within(region).findByRole("link", { name: "Decision" })).toBeVisible();
  await waitFor(() => expect(requests.some(({ path }) => path.includes("depth=2"))).toBe(true));

  fireEvent.change(within(region).getByRole("combobox", { name: "Relationship direction" }), { target: { value: "incoming" } });
  await waitFor(() => expect(requests.some(({ path }) => path.includes("direction=incoming"))).toBe(true));
  fireEvent.change(within(region).getByRole("textbox", { name: "Relationship types" }), { target: { value: "supports, untyped" } });
  await waitFor(() => expect(requests.some(({ path }) => path.includes("relationType=supports") && path.includes("relationType=untyped"))).toBe(true));

  fireEvent.click(within(region).getByRole("button", { name: "Review relationship maintenance" }));
  expect(await within(region).findByText("Missing source")).toBeVisible();
  expect(within(region).getByRole("link", { name: "Decision" })).toBeVisible();
  fireEvent.change(within(region).getByRole("combobox", { name: "Repair target for Missing source" }), { target: { value: alternateId } });
  fireEvent.click(within(region).getByRole("button", { name: "Repair Missing source" }));
  await waitFor(() => expect(requests).toContainEqual(expect.objectContaining({ method: "POST",
    path: `/api/notes/${noteId}/links/55555555-5555-4555-8555-555555555555/repair`,
    body: { targetNoteId: alternateId, expectedRevision: 2 } })));
  expect(await within(region).findByRole("status")).toHaveTextContent("Link repaired");
});
