import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { expect, test, vi } from "vitest";
import { NoteWorkspace } from "./note-workspace";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((complete) => { resolve = complete; });
  return { promise, resolve };
}

test("renders and edits the starter tutorial contribution", async () => {
  const requests: Array<{ path: string; init?: RequestInit }> = []; const propertyId = "property-1";
  const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => { const path = String(input); requests.push({ path, init });
    if (path.endsWith("/context")) return Response.json({ noteId: "root", workspaceId: "workspace", state: "active", revision: 1, createdAt: new Date(0).toISOString(), historyCount: 1, access: "edit", accessSource: "workspace", breadcrumbs: [{ id: "root", title: "Start here" }], outgoingLinks: [], backlinks: [], projectIds: [], projects: [] });
    if (path.includes("tasks?scope=projectless")) return Response.json({ tasks: [{ id: "task-1", title: "Shape your first idea", status: { id: "ready", name: "Ready", category: "unstarted" } }] });
    if (init?.method === "PUT") return Response.json({ tutorial: {} });
    if (init?.method === "DELETE") return Response.json({ removed: true });
    return Response.json({ tutorial: { workspaceId: "workspace", rootNoteId: "root", notes: [{ id: "root", title: "Start here", content: "Guide" }, { id: "child-1", parentId: "root", title: "Connect your thinking", content: "Link Notes when ideas belong together." }, { id: "child-2", parentId: "root", title: "Plan the next step", content: "Keep action nearby." }], links: [{ id: "link-1", sourceNoteId: "child-1", targetNoteId: "child-2", label: "Continue planning" }], collection: { schema: "stash.collection.v1", id: "collection-1", workspaceId: "workspace", ownerNoteId: "child-1", title: "Ideas to explore", properties: [{ id: propertyId, name: "Idea", type: "text", position: 1 }], records: [{ id: "record-1", position: 1, values: { [propertyId]: "Shape your first idea" } }] }, viewBlock: { schema: "stash.view-block.v1", id: "view-1", workspaceId: "workspace", ownerNoteId: "child-2", blockId: "view-1", title: "First moves", definition: { source: { kind: "tasks", workspaceId: "workspace" }, presentation: "list", filters: [], sorts: [], layout: {} } } } });
  }) as typeof fetch;
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const workspace = (noteId: string, editor: string) => <QueryClientProvider client={client}><MemoryRouter><NoteWorkspace
    fetcher={fetcher} noteId={noteId} token="member"><p>{editor}</p></NoteWorkspace></MemoryRouter></QueryClientProvider>;
  const view = render(workspace("root", "Editable Note"));
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
  view.rerender(workspace("other-note", "Another Note editor"));
  expect(await screen.findByText("Another Note editor")).toBeVisible();
  expect(screen.queryByText("The starter tutorial and its sample Tasks were permanently removed.")).not.toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Open Note context" })).toBeVisible();
});

test("clears archived branch state when direct navigation reuses the Note workspace", async () => {
  const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input);
    if (path.endsWith("/branch-preview")) return Response.json({ impact: { noteId: "first-note", title: "First Note",
      descendantCount: 0, descendants: [], collectionCount: 0, collectionRelocationRequired: false,
      externalLinks: [], projectAccessChanges: [] } });
    if (path.endsWith("/archive") && init?.method === "POST") return Response.json({ status: "updated", affectedIds: ["first-note"] });
    if (path.endsWith("/starter-tutorial")) return Response.json({ message: "Not a tutorial" }, { status: 404 });
    return Response.json({ noteId: path.includes("second-note") ? "second-note" : "first-note", workspaceId: "workspace",
      state: "active", revision: 1, createdAt: new Date(0).toISOString(), historyCount: 1, access: "edit",
      accessSource: "workspace", breadcrumbs: [{ id: path.includes("second-note") ? "second-note" : "first-note",
        title: path.includes("second-note") ? "Second Note" : "First Note" }], outgoingLinks: [], backlinks: [], projectIds: [], projects: [] });
  }) as typeof fetch;
  vi.spyOn(window, "confirm").mockReturnValueOnce(true);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const workspace = (noteId: string, editor: string) => <QueryClientProvider client={client}><MemoryRouter><NoteWorkspace
    fetcher={fetcher} noteId={noteId} token="member"><p>{editor}</p></NoteWorkspace></MemoryRouter></QueryClientProvider>;
  const view = render(workspace("first-note", "First Note editor"));
  fireEvent.click(await screen.findByRole("button", { name: "Archive Note branch" }));
  expect(await screen.findByText("This Note branch is archived. Restore it to return it to the Note Tree.")).toBeVisible();
  view.rerender(workspace("second-note", "Second Note editor"));
  expect(await screen.findByText("Second Note editor")).toBeVisible();
  expect(screen.queryByText(/This Note branch is archived/)).not.toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "Restore Note branch" })).not.toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Open Note context" })).toBeVisible();
});

test("ignores an ordinary branch removal response that completes after direct Note navigation", async () => {
  const archive = deferred<Response>();
  const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input);
    if (path.endsWith("/branch-preview")) return Response.json({ impact: { noteId: "first-note", title: "First Note",
      descendantCount: 0, descendants: [], collectionCount: 0, collectionRelocationRequired: false,
      externalLinks: [], projectAccessChanges: [] } });
    if (path.endsWith("/archive") && init?.method === "POST") return archive.promise;
    if (path.endsWith("/starter-tutorial")) return Response.json({ message: "Not a tutorial" }, { status: 404 });
    const second = path.includes("second-note");
    return Response.json({ noteId: second ? "second-note" : "first-note", workspaceId: "workspace", state: "active",
      revision: 1, createdAt: new Date(0).toISOString(), historyCount: 1, access: "edit", accessSource: "workspace",
      breadcrumbs: [{ id: second ? "second-note" : "first-note", title: second ? "Second Note" : "First Note" }],
      outgoingLinks: [], backlinks: [], projectIds: [], projects: [] });
  }) as typeof fetch;
  vi.spyOn(window, "confirm").mockReturnValueOnce(true);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  client.setQueryData(["note-tree", "workspace"], { nodes: [] });
  const workspace = (noteId: string, editor: string) => <QueryClientProvider client={client}><MemoryRouter><NoteWorkspace
    fetcher={fetcher} noteId={noteId} token="member"><p>{editor}</p></NoteWorkspace></MemoryRouter></QueryClientProvider>;
  const view = render(workspace("first-note", "First Note editor"));
  fireEvent.click(await screen.findByRole("button", { name: "Archive Note branch" }));
  await waitFor(() => expect(fetcher).toHaveBeenCalledWith("/api/notes/first-note/archive", expect.objectContaining({ method: "POST" })));
  view.rerender(workspace("second-note", "Second Note editor"));
  await act(async () => archive.resolve(Response.json({ status: "updated", affectedIds: ["first-note"] })));
  expect(await screen.findByText("Second Note editor")).toBeVisible();
  expect(screen.queryByText(/This Note branch is archived/)).not.toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "Restore Note branch" })).not.toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Open Note context" })).toBeVisible();
  expect(client.getQueryState(["note-tree", "workspace"])?.isInvalidated).toBe(true);
});

test("ignores permanent tutorial removal that completes after direct Note navigation", async () => {
  const removal = deferred<Response>(); const propertyId = "property-1";
  const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input); const second = path.includes("second-note");
    if (path.endsWith("/context")) return Response.json({ noteId: second ? "second-note" : "first-note", workspaceId: "workspace",
      state: "active", revision: 1, createdAt: new Date(0).toISOString(), historyCount: 1, access: "edit", accessSource: "workspace",
      breadcrumbs: [{ id: second ? "second-note" : "first-note", title: second ? "Second Note" : "First Note" }],
      outgoingLinks: [], backlinks: [], projectIds: [], projects: [] });
    if (path.includes("tasks?scope=projectless")) return Response.json({ tasks: [] });
    if (init?.method === "DELETE") return removal.promise;
    if (second) return Response.json({ message: "Not a tutorial" }, { status: 404 });
    return Response.json({ tutorial: { workspaceId: "workspace", rootNoteId: "first-note",
      notes: [{ id: "first-note", title: "Start here", content: "Guide" }], links: [],
      collection: { schema: "stash.collection.v1", id: "collection-1", workspaceId: "workspace", ownerNoteId: "first-note",
        title: "Ideas", properties: [{ id: propertyId, name: "Idea", type: "text", position: 1 }],
        records: [{ id: "record-1", position: 1, values: { [propertyId]: "Question" } }] },
      viewBlock: { schema: "stash.view-block.v1", id: "view-1", workspaceId: "workspace", ownerNoteId: "first-note",
        blockId: "view-1", title: "First moves",
        definition: { source: { kind: "tasks", workspaceId: "workspace" }, presentation: "list", filters: [], sorts: [], layout: {} } } } });
  }) as typeof fetch;
  vi.spyOn(window, "confirm").mockReturnValueOnce(true);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  client.setQueryData(["note-tree", "workspace"], { nodes: [] });
  const workspace = (noteId: string, editor: string) => <QueryClientProvider client={client}><MemoryRouter><NoteWorkspace
    fetcher={fetcher} noteId={noteId} token="member"><p>{editor}</p></NoteWorkspace></MemoryRouter></QueryClientProvider>;
  const view = render(workspace("first-note", "First Note editor"));
  fireEvent.click(await screen.findByRole("button", { name: "Remove tutorial" }));
  await waitFor(() => expect(fetcher).toHaveBeenCalledWith("/api/notes/first-note/starter-tutorial", expect.objectContaining({ method: "DELETE" })));
  view.rerender(workspace("second-note", "Second Note editor"));
  const newContext = await screen.findByRole("button", { name: "Open Note context" });
  newContext.focus();
  await act(async () => removal.resolve(Response.json({ removed: true })));
  expect(await screen.findByText("Second Note editor")).toBeVisible();
  expect(screen.queryByText("The starter tutorial and its sample Tasks were permanently removed.")).not.toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "Restore Note branch" })).not.toBeInTheDocument();
  expect(newContext).toHaveFocus();
  expect(client.getQueryState(["note-tree", "workspace"])?.isInvalidated).toBe(true);
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
