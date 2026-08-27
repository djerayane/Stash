import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import type { Collection, ViewBlock } from "@stash/domain-types";
import { CollectionWorkspace } from "./collection-editor";

const titleId = "11111111-1111-4111-8111-111111111111"; const statusId = "22222222-2222-4222-8222-222222222222";
const collection: Collection = { schema: "stash.collection.v1", id: "33333333-3333-4333-8333-333333333333",
  workspaceId: "44444444-4444-4444-8444-444444444444", ownerNoteId: "55555555-5555-4555-8555-555555555555", title: "Research",
  properties: [{ id: titleId, name: "Idea", type: "text", position: 1 },
    { id: statusId, name: "Status", type: "single_select", position: 2, options: [{ id: "ready", name: "Ready" }, { id: "later", name: "Later" }] }],
  records: [{ id: "66666666-6666-4666-8666-666666666666", position: 1, values: { [titleId]: "Map constraints", [statusId]: "ready" } }] };
const view: ViewBlock = { schema: "stash.view-block.v1", id: "77777777-7777-4777-8777-777777777777", workspaceId: collection.workspaceId,
  ownerNoteId: collection.ownerNoteId, blockId: "88888888-8888-4888-8888-888888888888", title: "Research lens",
  definition: { source: { kind: "collection", collectionId: collection.id }, presentation: "table", filters: [], sorts: [], groupBy: statusId, layout: {} } };

describe("Collection workspace", () => {
  it("creates the first Collection in an empty Note using the Note workspace identity", async () => {
    const requests: Array<{ path: string; init?: RequestInit }> = [];
    const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input); requests.push({ path, init });
      if (!init?.method) return Response.json({ workspaceId: collection.workspaceId, collections: [], views: [] });
      return Response.json({ status: "created" }, { status: 201 });
    }) as typeof fetch;
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(<QueryClientProvider client={client}><CollectionWorkspace noteId={collection.ownerNoteId} token="member" fetcher={fetcher} /></QueryClientProvider>);

    fireEvent.click(await screen.findByRole("button", { name: "New Collection" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Collection title" }), { target: { value: "Reading list" } });
    fireEvent.click(screen.getByRole("button", { name: "Create Collection" }));
    await waitFor(() => expect(requests.some(({ init }) => init?.method === "POST"
      && JSON.parse(String(init.body)).workspaceId === collection.workspaceId)).toBe(true));
  });

  it("offers accessible table, board, list, and calendar lenses with a non-drag board move", async () => {
    const requests: Array<{ path: string; init?: RequestInit }> = [];
    let currentCollection = collection;
    const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => { const path = String(input); requests.push({ path, init });
      if (path.endsWith("/collections")) return Response.json({ workspaceId: collection.workspaceId, collections: [currentCollection], views: [view] });
      if (path.endsWith(`/view-blocks/${view.id}`) && !init?.method) return Response.json({ view, source: { kind: "collection", collection: currentCollection } });
      if (path.includes(`/records/${collection.records[0]!.id}`) && init?.method === "PATCH") {
        const values = (JSON.parse(String(init.body)) as { values: Collection["records"][number]["values"] }).values;
        currentCollection = { ...currentCollection, records: currentCollection.records.map((record) => record.id === collection.records[0]!.id
          ? { ...record, values: { ...record.values, ...values } } : record) };
      }
      return Response.json({ status: "updated" });
    }) as typeof fetch;
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(<QueryClientProvider client={client}><CollectionWorkspace noteId={collection.ownerNoteId} token="member" fetcher={fetcher} /></QueryClientProvider>);

    expect(await screen.findByRole("table", { name: "Research lens" })).toBeVisible();
    const presentation = screen.getByRole("combobox", { name: "Presentation" });
    fireEvent.change(presentation, { target: { value: "board" } });
    expect(await screen.findByRole("region", { name: "Research lens board" })).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Move Map constraints to Later" }));
    await waitFor(() => expect(requests.some(({ path, init }) => path.includes(`/records/${collection.records[0]!.id}`)
      && init?.method === "PATCH" && String(init.body).includes("later"))).toBe(true));
    expect(await screen.findByRole("button", { name: "Move Map constraints to Ready" })).toBeVisible();
    fireEvent.change(presentation, { target: { value: "list" } });
    expect(await screen.findByRole("list", { name: "Research lens" })).toBeVisible();
    fireEvent.change(presentation, { target: { value: "calendar" } });
    expect(await screen.findByRole("region", { name: "Research lens calendar" })).toBeVisible();
  });
});
