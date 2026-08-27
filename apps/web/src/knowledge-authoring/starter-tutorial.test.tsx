import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { expect, test, vi } from "vitest";
import { NoteWorkspace } from "./note-workspace";

test("renders and edits the starter tutorial contribution", async () => {
  const requests: Array<{ path: string; init?: RequestInit }> = []; const propertyId = "property-1";
  const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => { const path = String(input); requests.push({ path, init });
    if (path.endsWith("/context")) return Response.json({ noteId: "root", workspaceId: "workspace", state: "active", revision: 1, createdAt: new Date(0).toISOString(), historyCount: 1, access: "edit", accessSource: "workspace", breadcrumbs: [{ id: "root", title: "Start here" }], outgoingLinks: [], backlinks: [], projectIds: [], projects: [] });
    if (path.includes("tasks?scope=projectless")) return Response.json({ tasks: [{ id: "task-1", title: "Shape your first idea", status: { id: "ready", name: "Ready", category: "unstarted" } }] });
    if (init?.method === "PUT") return Response.json({ tutorial: {} });
    if (init?.method === "DELETE") return Response.json({ removed: true });
    return Response.json({ tutorial: { workspaceId: "workspace", rootNoteId: "root", notes: [{ id: "root", title: "Start here", content: "Guide" }, { id: "child-1", parentId: "root", title: "Connect your thinking", content: "Link Notes when ideas belong together." }, { id: "child-2", parentId: "root", title: "Plan the next step", content: "Keep action nearby." }], links: [{ id: "link-1", sourceNoteId: "child-1", targetNoteId: "child-2", label: "Continue planning" }], collection: { schema: "stash.collection.v1", id: "collection-1", workspaceId: "workspace", ownerNoteId: "child-1", title: "Ideas to explore", properties: [{ id: propertyId, name: "Idea", type: "text", position: 1 }], records: [{ id: "record-1", position: 1, values: { [propertyId]: "Shape your first idea" } }] }, viewBlock: { schema: "stash.view-block.v1", id: "view-1", workspaceId: "workspace", ownerNoteId: "child-2", blockId: "view-1", title: "First moves", source: { kind: "tasks", workspaceId: "workspace", project: "none" }, definition: { query: { scope: "projectless", titleContains: "" }, layout: "list" } } } });
  }) as typeof fetch;
  render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><MemoryRouter><NoteWorkspace fetcher={fetcher} noteId="root" token="member"><p>Editable Note</p></NoteWorkspace></MemoryRouter></QueryClientProvider>);
  expect(await screen.findByRole("heading", { name: "Try the pieces together" })).toBeVisible();
  expect(screen.getByRole("link", { name: /Connect your thinking/ })).toBeVisible(); expect(screen.getByRole("link", { name: /Continue planning/ })).toBeVisible();
  expect(screen.getByRole("textbox", { name: "Idea" })).toHaveValue("Shape your first idea"); expect(await screen.findByText("Ready")).toBeVisible();
  fireEvent.change(screen.getByRole("textbox", { name: "Collection title" }), { target: { value: "Questions worth keeping" } });
  fireEvent.change(screen.getByRole("textbox", { name: "Idea" }), { target: { value: "Shape a durable question" } });
  fireEvent.click(screen.getByRole("button", { name: "Save Collection" }));
  await waitFor(() => expect(requests.some(({ path, init }) => path.endsWith("/starter-tutorial/collection") && init?.method === "PUT" && String(init.body).includes("Questions worth keeping"))).toBe(true));
  fireEvent.change(screen.getByRole("combobox", { name: "Layout" }), { target: { value: "table" } });
  fireEvent.change(screen.getByRole("textbox", { name: "Task title contains" }), { target: { value: "Shape" } });
  fireEvent.click(screen.getByRole("button", { name: "Save Task View" }));
  await waitFor(() => expect(requests.some(({ path, init }) => path.endsWith("/starter-tutorial/view") && init?.method === "PUT" && String(init.body).includes("table"))).toBe(true));
  vi.spyOn(window, "confirm").mockReturnValueOnce(true);
  fireEvent.click(screen.getByRole("button", { name: "Remove tutorial" }));
  expect(await screen.findByText("The starter tutorial and its sample Tasks were permanently removed.")).toHaveFocus();
  expect(screen.queryByRole("button", { name: "Restore Note branch" })).not.toBeInTheDocument();
});

test("keeps an unavailable optional tutorial from competing with the Note editor", async () => {
  const fetcher = vi.fn(async (input: RequestInfo | URL) => String(input).endsWith("/context")
    ? Response.json({ noteId: "root", workspaceId: "workspace", state: "active", revision: 1, createdAt: new Date(0).toISOString(), historyCount: 1, access: "edit", accessSource: "workspace", breadcrumbs: [{ id: "root", title: "Start here" }], outgoingLinks: [], backlinks: [], projectIds: [], projects: [] })
    : Response.json({ message: "Tutorial unavailable" }, { status: 503 })) as typeof fetch;
  render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><MemoryRouter><NoteWorkspace fetcher={fetcher} noteId="root" token="member"><div role="alert">The Note editor is unavailable.</div></NoteWorkspace></MemoryRouter></QueryClientProvider>);
  await waitFor(() => expect(fetcher).toHaveBeenCalledWith("/api/notes/root/starter-tutorial", expect.anything()));
  expect(screen.getAllByRole("alert")).toHaveLength(1);
  expect(screen.queryByText("Tutorial unavailable")).not.toBeInTheDocument();
});
