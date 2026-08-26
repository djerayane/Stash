import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { expect, it, vi } from "vitest";

import { NoteTree } from "./note-tree";
import { NoteWorkspace } from "./note-workspace";

const workspaceId = "11111111-1111-4111-8111-111111111111";
const roadmapId = "22222222-2222-4222-8222-222222222222";
const evidenceId = "33333333-3333-4333-8333-333333333333";
const researchId = "44444444-4444-4444-8444-444444444444";

function wrapper(children: React.ReactNode) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return <MemoryRouter><QueryClientProvider client={client}>{children}</QueryClientProvider></MemoryRouter>;
}

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
      JSON.parse(String(init?.body)).parentId === roadmapId ? [{ noteId: researchId, projectId: "project-1", effect: "gained" }] : [] } });
    if (method === "POST" && path.endsWith("/move")) return new Response(JSON.stringify({ status: "moved", movedIds: [researchId], projectAccessChanges: [] }));
    return new Response(JSON.stringify({ nodes }));
  });
  render(wrapper(<NoteTree activeNoteId={evidenceId} fetcher={fetcher} token="member" workspaceId={workspaceId} />));
  expect(await screen.findByRole("tree", { name: "Note Tree" })).toBeInTheDocument();
  expect(screen.getByRole("treeitem", { name: "Evidence" })).toHaveAttribute("aria-current", "page");

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

  const data = new Map<string, string>();
  const transfer = { setData: (type: string, value: string) => data.set(type, value), getData: (type: string) => data.get(type) ?? "", effectAllowed: "move" };
  fireEvent.dragStart(screen.getByRole("treeitem", { name: "Research" }), { dataTransfer: transfer });
  fireEvent.drop(screen.getByRole("treeitem", { name: "Roadmap" }), { dataTransfer: transfer });
  await waitFor(() => expect(requests).toContainEqual(expect.objectContaining({ path: `/api/notes/${researchId}/move`, body: { parentId: roadmapId } })));
  expect(window.confirm).toHaveBeenCalledWith(expect.stringContaining("Project access"));
});

it("keeps contextual knowledge closed by default and restores focus after keyboard use", async () => {
  const requests: Array<{ path: string; method: string; body?: any }> = [];
  const context = {
    noteId: evidenceId,
    breadcrumbs: [{ id: roadmapId, title: "Roadmap" }, { id: evidenceId, title: "Evidence" }],
    outgoingLinks: [{ id: "link-1", noteId: researchId, title: "Research", label: "Supports", relationshipType: "supports" }],
    backlinks: [{ id: "link-2", noteId: roadmapId, title: "Roadmap", label: "Evidence" }],
    projectIds: ["project-1"],
  };
  vi.spyOn(window, "confirm").mockReturnValue(true);
  const fetcher = vi.fn<typeof fetch>(async (input, init) => {
    const path = String(input); const method = init?.method ?? "GET";
    requests.push({ path, method, ...(init?.body ? { body: JSON.parse(String(init.body)) } : {}) });
    if (path.endsWith("/branch-preview")) return Response.json({ impact: { noteId: evidenceId, title: "Evidence", descendantCount: 2,
      collectionCount: 1, externalLinks: [{ noteId: researchId, title: "Research", direction: "outgoing" }], projectAccessChanges: [] } });
    if (path.endsWith("/archive")) return Response.json({ status: "updated", affectedIds: [evidenceId] });
    if (path.endsWith("/restore")) return Response.json({ status: "restored", restoredIds: [evidenceId], parentRestored: true });
    if (path.endsWith("/links") && method === "POST") return new Response(JSON.stringify({ link: { id: "new-link" } }), { status: 201 });
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
  fireEvent.change(within(drawer).getByRole("textbox", { name: "Target Note ID" }), { target: { value: researchId } });
  fireEvent.change(within(drawer).getByRole("textbox", { name: "Relationship type" }), { target: { value: "supports" } });
  fireEvent.click(within(drawer).getByRole("button", { name: "Create Note link" }));
  await waitFor(() => expect(requests).toContainEqual(expect.objectContaining({ path: `/api/notes/${evidenceId}/links`, method: "POST",
    body: { targetNoteId: researchId, label: "Note", relationshipType: "supports" } })));
  fireEvent.click(within(drawer).getByRole("button", { name: "Close Note context" }));
  await waitFor(() => expect(open).toHaveFocus());

  fireEvent.click(screen.getByRole("button", { name: "Archive Note branch" }));
  await waitFor(() => expect(window.confirm).toHaveBeenCalledWith(expect.stringContaining("2 descendants")));
  expect(await screen.findByRole("button", { name: "Restore Note branch" })).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Restore Note branch" }));
  await waitFor(() => expect(requests).toContainEqual(expect.objectContaining({ path: `/api/notes/${evidenceId}/restore`, method: "POST" })));
});
