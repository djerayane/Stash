import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter, useLocation } from "react-router";
import { expect, it, vi } from "vitest";

import { NoteTree } from "./note-tree";
import { NoteWorkspace } from "./note-workspace";

const workspaceId = "11111111-1111-4111-8111-111111111111";
const roadmapId = "22222222-2222-4222-8222-222222222222";
const evidenceId = "33333333-3333-4333-8333-333333333333";
const researchId = "44444444-4444-4444-8444-444444444444";

function wrapper(children: React.ReactNode) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return <MemoryRouter><QueryClientProvider client={client}>{children}<LocationProbe /></QueryClientProvider></MemoryRouter>;
}

function LocationProbe() { return <div data-testid="location">{useLocation().pathname}</div>; }

it("names every compact tree action without decorative hierarchy labels", async () => {
  const fetcher = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ nodes: [] }));
  render(wrapper(<NoteTree fetcher={fetcher} token="member" variant="page" workspaceId={workspaceId} />));

  expect(await screen.findByRole("heading", { name: "Note Tree" })).toBeVisible();
  expect(screen.queryByText("Knowledge")).not.toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Create root Note" })).toBeVisible();
  expect(screen.getByRole("button", { name: "Show archived and trashed branches" })).toBeVisible();
  for (const action of screen.getAllByRole("button")) expect(action).toHaveAccessibleName();
});

it("creates children and offers keyboard and pointer alternatives for moving Notes", async () => {
  const nodes = [
    { id: roadmapId, workspaceId, title: "Roadmap", position: "1", childCount: 1 },
    { id: evidenceId, workspaceId, parentId: roadmapId, title: "Evidence", position: "1", childCount: 0 },
    { id: researchId, workspaceId, title: "Research", position: "2", childCount: 0 },
  ];
  const requests: Array<{ path: string; method: string; body?: any }> = [];
  vi.spyOn(window, "confirm").mockReturnValue(true);
  const fetcher = vi.fn<typeof fetch>(async (input, init) => {
    const path = String(input); const method = init?.method ?? "GET";
    requests.push({ path, method, ...(init?.body ? { body: JSON.parse(String(init.body)) } : {}) });
    if (method === "POST" && path.endsWith("/note-tree")) return new Response(JSON.stringify({ node: {
      id: "55555555-5555-4555-8555-555555555555", workspaceId, parentId: roadmapId, title: "Questions", position: "2", childCount: 0,
    } }), { status: 201 });
    if (method === "POST" && path.endsWith("/branch-preview")) return Response.json({ impact: { projectAccessChanges:
      JSON.parse(String(init?.body)).parentId === roadmapId ? [{ noteId: researchId, noteTitle: "Research", projectId: "project-1", projectName: "Launch", effect: "gained" }] : [],
      descendants: [], descendantCount: 0, collectionCount: 0, externalLinks: [] } });
    if (method === "POST" && path.endsWith("/move")) return new Response(JSON.stringify({ status: "moved", movedIds: [researchId], projectAccessChanges: [] }));
    return new Response(JSON.stringify({ nodes }));
  });
  render(wrapper(<NoteTree activeNoteId={evidenceId} fetcher={fetcher} token="member" workspaceId={workspaceId} />));
  expect(await screen.findByRole("tree", { name: "Note Tree" })).toBeInTheDocument();
  expect(screen.getByRole("treeitem", { name: "Evidence" })).toHaveAttribute("aria-current", "page");
  const researchActions = within(screen.getByRole("treeitem", { name: "Research" }));
  expect(researchActions.getByRole("button", { name: "Add child to Research" })).toBeInTheDocument();
  expect(researchActions.getByText("More actions for Research", { selector: "summary" })).toBeInTheDocument();

  const roadmapItem = screen.getByRole("treeitem", { name: "Roadmap" });
  const evidenceItem = screen.getByRole("treeitem", { name: "Evidence" });
  roadmapItem.focus(); fireEvent.keyDown(roadmapItem, { key: "ArrowRight" }); expect(evidenceItem).toHaveFocus();
  fireEvent.keyDown(evidenceItem, { key: "ArrowLeft" }); expect(roadmapItem).toHaveFocus();
  fireEvent.keyDown(roadmapItem, { key: "End" }); expect(screen.getByRole("treeitem", { name: "Research" })).toHaveFocus();
  fireEvent.keyDown(screen.getByRole("treeitem", { name: "Research" }), { key: "Home" }); expect(roadmapItem).toHaveFocus();

  fireEvent.keyDown(screen.getByRole("button", { name: "Add child to Roadmap" }), { key: "Enter" });
  expect(screen.getByTestId("location")).toHaveTextContent("/");

  fireEvent.click(screen.getByRole("button", { name: "Add child to Roadmap" }));
  fireEvent.change(screen.getByRole("textbox", { name: "Child Note title" }), { target: { value: "Questions" } });
  fireEvent.click(screen.getByRole("button", { name: "Create child Note" }));
  await waitFor(() => expect(requests).toContainEqual(expect.objectContaining({ method: "POST", body: { title: "Questions", parentId: roadmapId } })));

  fireEvent.click(screen.getByRole("button", { name: "Add sibling to Evidence" }));
  fireEvent.change(screen.getByRole("textbox", { name: "Sibling Note title" }), { target: { value: "Decision" } });
  fireEvent.click(screen.getByRole("button", { name: "Create sibling Note" }));
  await waitFor(() => expect(requests).toContainEqual(expect.objectContaining({ method: "POST", body: { title: "Decision", parentId: roadmapId } })));

  fireEvent.click(screen.getByRole("button", { name: "Move Research before Roadmap" }));
  await waitFor(() => expect(requests).toContainEqual(expect.objectContaining({ path: `/api/notes/${researchId}/move`, body: { beforeId: roadmapId } })));
  expect(screen.getByRole("status")).toHaveTextContent("Research moved");

  fireEvent.keyDown(screen.getByRole("treeitem", { name: "Research" }), { key: "ArrowRight", altKey: true });
  await waitFor(() => expect(requests).toContainEqual(expect.objectContaining({ path: `/api/notes/${researchId}/move`, body: { parentId: roadmapId } })));
  fireEvent.keyDown(evidenceItem, { key: "ArrowLeft", altKey: true });
  await waitFor(() => expect(requests).toContainEqual(expect.objectContaining({ path: `/api/notes/${evidenceId}/move`, body: {} })));

  const data = new Map<string, string>();
  const transfer = { setData: (type: string, value: string) => data.set(type, value), getData: (type: string) => data.get(type) ?? "", effectAllowed: "move" };
  fireEvent.dragStart(screen.getByRole("treeitem", { name: "Research" }), { dataTransfer: transfer });
  Object.defineProperty(roadmapItem, "getBoundingClientRect", { value: () => ({ top: 0, height: 30, bottom: 30, left: 0, right: 300, width: 300, x: 0, y: 0, toJSON() {} }) });
  fireEvent.drop(roadmapItem, { dataTransfer: transfer, clientY: 5 });
  await waitFor(() => expect(requests).toContainEqual(expect.objectContaining({ path: `/api/notes/${researchId}/move`, body: { beforeId: roadmapId } })));
  expect(window.confirm).toHaveBeenCalledWith(expect.stringContaining("Research gains Launch"));
});

it("expands a collapsed destination before restoring focus to a nested Note", async () => {
  let nested = false;
  const fetcher = vi.fn<typeof fetch>(async (input, init) => {
    const path = String(input); const method = init?.method ?? "GET";
    if (method === "POST" && path.endsWith("/branch-preview")) return Response.json({ impact: {
      projectAccessChanges: [], descendants: [], descendantCount: 0, collectionCount: 0, externalLinks: [],
    } });
    if (method === "POST" && path.endsWith("/move")) { nested = true; return Response.json({ status: "moved", movedIds: [researchId], projectAccessChanges: [] }); }
    return Response.json({ nodes: [
      { id: roadmapId, workspaceId, title: "Roadmap", position: "1", childCount: nested ? 2 : 1 },
      { id: evidenceId, workspaceId, parentId: roadmapId, title: "Evidence", position: "1", childCount: 0 },
      { id: researchId, workspaceId, ...(nested ? { parentId: roadmapId } : {}), title: "Research", position: nested ? "1" : "2", childCount: 0 },
    ] });
  });
  render(wrapper(<NoteTree fetcher={fetcher} token="member" workspaceId={workspaceId} />));

  const roadmap = await screen.findByRole("treeitem", { name: "Roadmap" });
  fireEvent.click(within(roadmap).getByRole("button", { name: "Collapse Roadmap" }));
  const research = screen.getByRole("treeitem", { name: "Research" });
  research.focus();
  fireEvent.click(within(research).getByRole("button", { name: "Nest Research under Roadmap" }));

  await waitFor(() => expect(screen.getByRole("treeitem", { name: "Roadmap" })).toHaveAttribute("aria-expanded", "true"));
  expect(screen.getByRole("treeitem", { name: "Research" })).toHaveFocus();
});

it("lists removed branches from durable Workspace state and restores them", async () => {
  const removedId = "55555555-5555-4555-8555-555555555555";
  const requests: string[] = [];
  const fetcher = vi.fn<typeof fetch>(async (input, init) => { const path = String(input); requests.push(path);
    if (path.endsWith("/removed")) return Response.json({ branches: [{ id: removedId, workspaceId, title: "Archived field notes", state: "archived", removedAt: "2026-08-26T10:00:00.000Z" }] });
    if (path.endsWith("/restore") && init?.method === "POST") return Response.json({ status: "restored", restoredIds: [removedId], parentRestored: true });
    return Response.json({ nodes: [] });
  });
  render(wrapper(<NoteTree fetcher={fetcher} token="member" workspaceId={workspaceId} />));
  fireEvent.click(await screen.findByRole("button", { name: "Show archived and trashed branches" }));
  expect(await screen.findByText("Archived field notes")).toBeVisible();
  fireEvent.click(screen.getByRole("button", { name: "Restore Archived field notes" }));
  await waitFor(() => expect(requests).toContain(`/api/notes/${removedId}/restore`));
});

it("keeps contextual knowledge closed by default and restores focus after keyboard use", async () => {
  const requests: Array<{ path: string; method: string; body?: any }> = [];
  const context = {
    noteId: evidenceId,
    workspaceId,
    breadcrumbs: [{ id: roadmapId, title: "Roadmap" }, { id: evidenceId, title: "Evidence" }],
    outgoingLinks: [{ id: "link-1", noteId: researchId, title: "Research", label: "Supports", relationshipType: "supports" }],
    backlinks: [{ id: "link-2", noteId: roadmapId, title: "Roadmap", label: "Evidence" }],
    projectIds: ["project-1"],
    projects: [{ id: "project-1", name: "Launch", key: "LAUNCH" }],
    state: "active" as const,
    parent: { id: roadmapId, title: "Roadmap" },
    revision: 3,
    createdAt: "2026-08-25T10:00:00.000Z",
    historyCount: 3,
    access: "edit" as const,
    accessSource: "workspace" as const,
  };
  vi.spyOn(window, "confirm").mockReturnValue(true);
  const fetcher = vi.fn<typeof fetch>(async (input, init) => {
    const path = String(input); const method = init?.method ?? "GET";
    requests.push({ path, method, ...(init?.body ? { body: JSON.parse(String(init.body)) } : {}) });
    if (path.endsWith("/branch-preview")) return Response.json({ impact: { noteId: evidenceId, title: "Evidence", descendantCount: 2,
      descendants: [{ noteId: roadmapId, title: "Observations" }, { noteId: researchId, title: "Sources" }], collectionCount: 1,
      externalLinks: [{ noteId: researchId, title: "Research", direction: "outgoing" }], projectAccessChanges:
        [{ noteId: evidenceId, noteTitle: "Evidence", projectId: "project-1", projectName: "Launch", effect: "lost" }] } });
    if (path.endsWith("/archive")) return Response.json({ status: "updated", affectedIds: [evidenceId] });
    if (path.endsWith("/restore")) return Response.json({ status: "restored", restoredIds: [evidenceId], parentRestored: true });
    if (path.endsWith("/context/links") && method === "POST") return new Response(JSON.stringify({ link: { id: "new-link" } }), { status: 201 });
    if (path.endsWith(`/notes/${evidenceId}/discussions`)) return Response.json({ discussions: [{ id: "discussion-1", target: { kind: "note" },
      messages: [{ id: "message-1", content: "Verify the source", createdAt: "2026-08-26T10:00:00.000Z", author: { displayName: "Ada" } }] }] });
    if (path === "/api/discussions" && method === "POST") return new Response(JSON.stringify({ discussion: { id: "discussion-2" } }), { status: 201 });
    if (path.endsWith("/note-tree")) return Response.json({ nodes: [{ id: evidenceId, title: "Evidence" }, { id: researchId, title: "Research" }] });
    return Response.json(context);
  });
  render(wrapper(<NoteWorkspace fetcher={fetcher} noteId={evidenceId} token="member"><article>Editor stays central</article></NoteWorkspace>));
  expect(await screen.findByRole("navigation", { name: "Breadcrumb" })).toHaveTextContent("RoadmapEvidence");
  expect(screen.queryByRole("complementary", { name: "Note context" })).not.toBeInTheDocument();
  const open = screen.getByRole("button", { name: "Open Note context" });
  fireEvent.click(open);
  const drawer = screen.getByRole("complementary", { name: "Note context" });
  expect(drawer).toHaveTextContent("Roadmap");
  expect(drawer).toHaveTextContent("Research");
  const target = within(drawer).getByRole("combobox", { name: "Target Note" });
  await screen.findByRole("option", { name: "Research" });
  fireEvent.change(target, { target: { value: researchId } });
  expect(target).toHaveValue(researchId);
  fireEvent.change(within(drawer).getByRole("textbox", { name: "Relationship type" }), { target: { value: "supports" } });
  fireEvent.submit(within(drawer).getByRole("button", { name: "Create Note link" }).closest("form")!);
  await waitFor(() => expect(requests).toContainEqual(expect.objectContaining({ path: `/api/notes/${evidenceId}/context/links`, method: "POST",
    body: { targetNoteId: researchId, label: "Note", relationshipType: "supports" } })));
  const linksTab = within(drawer).getByRole("tab", { name: "Links" }); linksTab.focus(); fireEvent.keyDown(linksTab, { key: "ArrowRight" });
  expect(linksTab).toHaveAttribute("id", `note-context-${evidenceId}-tab-links`);
  expect(linksTab).toHaveAttribute("aria-controls", `note-context-${evidenceId}-panel-links`);
  expect(within(drawer).getByRole("tab", { name: "Properties" })).toHaveFocus();
  const propertiesPanel = within(drawer).getByRole("tabpanel", { name: "Properties" });
  expect(propertiesPanel).toHaveAttribute("aria-labelledby", `note-context-${evidenceId}-tab-properties`);
  expect(propertiesPanel).toHaveAttribute("id", `note-context-${evidenceId}-panel-properties`);
  expect(propertiesPanel).toHaveTextContent("Active");
  expect(propertiesPanel).toHaveTextContent("Roadmap");
  expect(propertiesPanel).toHaveTextContent("Revision 3");
  expect(within(drawer).getByRole("link", { name: "Open Note history and revisions" })).toHaveAttribute("href", `/app/notes/${evidenceId}/history`);
  fireEvent.click(within(drawer).getByRole("tab", { name: "Projects" }));
  expect(within(drawer).getByRole("link", { name: "Launch" })).toHaveAttribute("href", "/app/projects/project-1/boards");
  fireEvent.click(within(drawer).getByRole("tab", { name: "Sharing" }));
  expect(within(drawer).getByRole("tabpanel", { name: "Sharing" })).toHaveTextContent("Can edit");
  expect(within(drawer).getByRole("link", { name: "Review Launch Project access" })).toHaveAttribute("href", "/app/projects/project-1/boards");
  fireEvent.click(within(drawer).getByRole("tab", { name: "Discussions" }));
  expect(await within(drawer).findByText("Verify the source")).toBeVisible();
  fireEvent.change(within(drawer).getByRole("textbox", { name: "Start a Discussion" }), { target: { value: "Record the uncertainty" } });
  fireEvent.click(within(drawer).getByRole("button", { name: "Start Discussion" }));
  await waitFor(() => expect(requests).toContainEqual(expect.objectContaining({ path: "/api/discussions", method: "POST",
    body: { target: { kind: "note", noteId: evidenceId }, message: "Record the uncertainty" } })));
  fireEvent.click(within(drawer).getByRole("button", { name: "Close Note context" }));
  await waitFor(() => expect(open).toHaveFocus());

  fireEvent.click(screen.getByRole("button", { name: "Archive Note branch" }));
  await waitFor(() => expect(window.confirm).toHaveBeenCalledWith(expect.stringContaining("2 descendants")));
  expect(window.confirm).toHaveBeenCalledWith(expect.stringContaining("Observations, Sources"));
  expect(window.confirm).toHaveBeenCalledWith(expect.stringContaining("outgoing Research"));
  expect(window.confirm).toHaveBeenCalledWith(expect.stringContaining("Evidence loses Launch"));
  expect(await screen.findByRole("button", { name: "Restore Note branch" })).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Restore Note branch" }));
  await waitFor(() => expect(requests).toContainEqual(expect.objectContaining({ path: `/api/notes/${evidenceId}/restore`, method: "POST" })));
});

it("keeps inherited Project Guests read-only while preserving Note context and Discussion reading", async () => {
  const requests: Array<{ path: string; method: string }> = [];
  const context = {
    noteId: evidenceId,
    workspaceId,
    breadcrumbs: [{ id: roadmapId, title: "Roadmap" }, { id: evidenceId, title: "Evidence" }],
    outgoingLinks: [],
    backlinks: [],
    projectIds: ["project-1"],
    projects: [{ id: "project-1", name: "Launch", key: "LAUNCH" }],
    state: "active" as const,
    parent: { id: roadmapId, title: "Roadmap" },
    revision: 3,
    createdAt: "2026-08-25T10:00:00.000Z",
    historyCount: 3,
    access: "read" as const,
    accessSource: "project" as const,
  };
  const fetcher = vi.fn<typeof fetch>(async (input, init) => {
    const path = String(input); const method = init?.method ?? "GET";
    requests.push({ path, method });
    if (path.endsWith(`/notes/${evidenceId}/discussions`)) return Response.json({ discussions: [{ id: "discussion-guest",
      target: { kind: "note" }, messages: [{ id: "message-guest", content: "Owner review context",
        createdAt: "2026-08-26T10:00:00.000Z", author: { displayName: "Ada" } }] }] });
    return Response.json(context);
  });
  render(wrapper(<NoteWorkspace fetcher={fetcher} noteId={evidenceId} token="guest"><article>Read-only editor</article></NoteWorkspace>));

  expect(await screen.findByRole("navigation", { name: "Breadcrumb" })).toHaveTextContent("RoadmapEvidence");
  expect(screen.getByRole("link", { name: "View history" })).toBeInTheDocument();
  expect(screen.getByText(/read-only access/i)).toBeVisible();
  expect(screen.queryByRole("button", { name: "Archive Note branch" })).not.toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "Move Note branch to trash" })).not.toBeInTheDocument();

  fireEvent.click(screen.getByRole("button", { name: "Open Note context" }));
  const drawer = screen.getByRole("complementary", { name: "Note context" });
  expect(within(drawer).queryByRole("button", { name: "Create Note link" })).not.toBeInTheDocument();
  expect(within(drawer).getByText(/links are read-only/i)).toBeVisible();
  fireEvent.click(within(drawer).getByRole("tab", { name: "Projects" }));
  expect(within(drawer).getByRole("link", { name: "Launch" })).toBeInTheDocument();
  expect(within(drawer).getByText(/project associations are read-only/i)).toBeVisible();
  fireEvent.click(within(drawer).getByRole("tab", { name: "Discussions" }));
  expect(await within(drawer).findByText("Owner review context")).toBeVisible();
  expect(within(drawer).getByText(/follow this discussion/i)).toBeVisible();
  expect(within(drawer).queryByRole("textbox", { name: "Start a Discussion" })).not.toBeInTheDocument();
  expect(within(drawer).queryByRole("textbox", { name: "Reply" })).not.toBeInTheDocument();
  expect(within(drawer).queryByRole("button", { name: "Resolve Discussion" })).not.toBeInTheDocument();
  expect(requests.every(({ method }) => method === "GET")).toBe(true);
  expect(requests.some(({ path }) => path.endsWith("/note-tree"))).toBe(false);
});
