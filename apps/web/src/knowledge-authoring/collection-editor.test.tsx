import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import type { Collection, ViewBlock } from "@stash/domain-types";
import { CollectionWorkspace } from "./collection-editor";

const titleId = "11111111-1111-4111-8111-111111111111"; const statusId = "22222222-2222-4222-8222-222222222222";
const recordId = "66666666-6666-4666-8666-666666666666";
const collection: Collection = { schema: "stash.collection.v1", id: "33333333-3333-4333-8333-333333333333",
  workspaceId: "44444444-4444-4444-8444-444444444444", ownerNoteId: "55555555-5555-4555-8555-555555555555", title: "Research",
  properties: [{ id: titleId, name: "Idea", type: "text", position: 1 },
    { id: statusId, name: "Status", type: "single_select", position: 2, options: [{ id: "ready", name: "Ready" }, { id: "later", name: "Later" }] }],
  records: [{ id: recordId, position: 1, values: { [titleId]: "Map constraints", [statusId]: "ready" } }] };
const view: ViewBlock = { schema: "stash.view-block.v1", id: "77777777-7777-4777-8777-777777777777", workspaceId: collection.workspaceId,
  ownerNoteId: collection.ownerNoteId, blockId: "88888888-8888-4888-8888-888888888888", title: "Research lens",
  definition: { source: { kind: "collection", collectionId: collection.id }, presentation: "table", filters: [], sorts: [], groupBy: statusId, layout: {} } };

function renderWorkspace(fetcher: typeof fetch, noteId = collection.ownerNoteId) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={client}><CollectionWorkspace noteId={noteId} token="member" fetcher={fetcher} /></QueryClientProvider>);
}

describe("Collection workspace", () => {
  it("creates an immediately useful table with a Name property", async () => {
    const requests: Array<{ path: string; init?: RequestInit }> = []; let collections: Collection[] = [];
    const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input); requests.push({ path, init });
      if (init?.method === "POST") { const next = JSON.parse(String(init.body)) as Collection; collections = [next];
        return Response.json({ collection: next }, { status: 201 }); }
      return Response.json({ workspaceId: collection.workspaceId, collections, availableCollections: collections, views: [] });
    }) as typeof fetch;
    renderWorkspace(fetcher);

    fireEvent.click(await screen.findByRole("button", { name: "New collection" }));

    const region = await screen.findByRole("region", { name: "Untitled collection" });
    expect(within(region).getByRole("columnheader", { name: "Name" })).toBeVisible();
    await waitFor(() => expect(within(region).getByRole("textbox", { name: "Collection title" })).toHaveFocus());
    const created = requests.find(({ init }) => init?.method === "POST");
    expect(JSON.parse(String(created?.init?.body)).properties).toEqual([
      expect.objectContaining({ name: "Name", type: "text", position: 1 }),
    ]);
  });

  it("adds a trailing property and record inline, and preserves a failed cell draft for retry", async () => {
    const requests: Array<{ path: string; init?: RequestInit }> = []; let current = collection; let failCellOnce = true;
    const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input); requests.push({ path, init });
      if (!init?.method) return Response.json({ workspaceId: collection.workspaceId, collections: [current], availableCollections: [current], views: [] });
      const body = init.body ? JSON.parse(String(init.body)) : undefined;
      if (path.endsWith("/properties") && init.method === "POST") {
        current = { ...current, properties: [...current.properties, body] }; return Response.json({ property: body }, { status: 201 });
      }
      if (path.endsWith("/records") && init.method === "POST") {
        current = { ...current, records: [...current.records, body] }; return Response.json({ record: body }, { status: 201 });
      }
      if (path.endsWith(`/records/${recordId}`) && init.method === "PATCH") {
        if (failCellOnce) { failCellOnce = false; return Response.json({ message: "The value could not be saved." }, { status: 503 }); }
        current = { ...current, records: current.records.map((record) => record.id === recordId
          ? { ...record, values: { ...record.values, ...body.values } } : record) };
        return Response.json({ status: "updated" });
      }
      return Response.json({ status: "updated" });
    }) as typeof fetch;
    renderWorkspace(fetcher);
    const region = await screen.findByRole("region", { name: "Research" });

    fireEvent.click(within(region).getByRole("button", { name: "Add property" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Property name" }), { target: { value: "Score" } });
    fireEvent.change(screen.getByRole("combobox", { name: "Property type" }), { target: { value: "number" } });
    fireEvent.click(screen.getByRole("button", { name: "Add property" }));
    expect(await within(region).findByRole("columnheader", { name: "Score" })).toBeVisible();
    await waitFor(() => expect(within(region).getByRole("button", { name: "Edit Score property" })).toHaveFocus());

    fireEvent.click(within(region).getByRole("button", { name: "New record" }));
    const newName = within(region).getByRole("textbox", { name: "Idea, new record" });
    fireEvent.change(newName, { target: { value: "Research interviews" } });
    fireEvent.keyDown(newName, { key: "Enter" });
    await waitFor(() => expect(requests.some(({ path, init }) => path.endsWith("/records") && init?.method === "POST")).toBe(true));

    const cell = within(region).getByRole("textbox", { name: "Idea, Map constraints" }) as HTMLInputElement;
    cell.focus(); cell.setSelectionRange(cell.value.length, cell.value.length);
    fireEvent.keyDown(cell, { key: "ArrowRight" });
    expect(within(region).getByRole("combobox", { name: "Status, Map constraints" })).toHaveFocus();
    fireEvent.change(cell, { target: { value: "Preserved draft" } });
    fireEvent.blur(cell);
    expect(await within(region).findByRole("alert")).toHaveTextContent("Value not saved");
    expect(cell).toHaveValue("Preserved draft");
    fireEvent.click(within(region).getByRole("button", { name: "Retry Idea" }));
    await waitFor(() => expect(requests.filter(({ path, init }) => path.endsWith(`/records/${recordId}`) && init?.method === "PATCH")).toHaveLength(2));
  });

  it("keeps property changes in the header and reports property deletion impact before confirmation", async () => {
    const requests: Array<{ path: string; init?: RequestInit }> = []; let current = collection;
    const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => { const path = String(input); requests.push({ path, init });
      if (!init?.method) return Response.json({ workspaceId: collection.workspaceId, collections: [current], availableCollections: [current], views: [view] });
      const body = init.body ? JSON.parse(String(init.body)) : undefined;
      if (path.endsWith(`/properties/${statusId}`) && init.method === "PATCH") {
        current = { ...current, properties: current.properties.map((property) => property.id === statusId ? { ...property, name: body.name } : property) };
        return Response.json({ collection: current });
      }
      if (path.endsWith("/properties") && init.method === "POST") {
        current = { ...current, properties: [...current.properties, body] };
        return Response.json({ property: body }, { status: 201 });
      }
      if (path.endsWith(`/properties/${statusId}`) && init.method === "DELETE") {
        current = { ...current, properties: current.properties.filter(({ id }) => id !== statusId),
          records: current.records.map((record) => ({ ...record, values: { [titleId]: record.values[titleId]! } })) };
        return Response.json({ collection: current, impact: { affectedValues: 1, affectedRelations: 0, affectedViews: 1 } });
      }
      return Response.json({ collection: current });
    }) as typeof fetch;
    renderWorkspace(fetcher);
    const region = await screen.findByRole("region", { name: "Research" });

    fireEvent.click(within(region).getByRole("button", { name: "Edit Status property" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Property name" }), { target: { value: "Stage" } });
    fireEvent.click(screen.getByRole("button", { name: "Save property" }));
    expect(await within(region).findByRole("columnheader", { name: "Stage" })).toBeVisible();
    const renamedPayload = JSON.parse(String(requests.find(({ path, init }) => path.endsWith(`/properties/${statusId}`)
      && init?.method === "PATCH")?.init?.body));
    expect(renamedPayload.options.map(({ id }: { id: string }) => id)).toEqual(["ready", "later"]);

    fireEvent.click(within(region).getByRole("button", { name: "Edit Stage property" }));
    fireEvent.click(screen.getByRole("button", { name: "Duplicate property" }));
    expect(await within(region).findByRole("columnheader", { name: "Stage copy" })).toBeVisible();

    fireEvent.click(within(region).getByRole("button", { name: "Edit Stage property" }));
    fireEvent.click(screen.getByRole("button", { name: "Delete property" }));
    const dialog = await screen.findByRole("dialog", { name: "Delete Stage property?" });
    expect(within(dialog).getByText("1 saved value will be removed.")).toBeVisible();
    expect(within(dialog).getByText("1 view will be updated.")).toBeVisible();
    fireEvent.click(within(dialog).getByRole("button", { name: "Delete property" }));
    await waitFor(() => expect(requests.some(({ path, init }) => path.endsWith(`/properties/${statusId}`) && init?.method === "DELETE")).toBe(true));
  });

  it("requests required properties in context and keeps advanced settings behind View", async () => {
    let current = { ...collection, properties: collection.properties.slice(0, 1) }; const requests: Array<{ path: string; init?: RequestInit }> = [];
    const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => { const path = String(input); requests.push({ path, init });
      if (!init?.method) return Response.json({ workspaceId: collection.workspaceId, collections: [current], availableCollections: [current], views: [] });
      if (path.endsWith("/properties")) { const property = JSON.parse(String(init.body)); current = { ...current, properties: [...current.properties, property] };
        return Response.json({ property }, { status: 201 }); }
      return Response.json({ status: "updated" });
    }) as typeof fetch;
    renderWorkspace(fetcher);
    const region = await screen.findByRole("region", { name: "Research" });

    expect(within(region).queryByRole("combobox", { name: "Filter by" })).not.toBeInTheDocument();
    fireEvent.click(within(region).getByRole("button", { name: "Calendar" }));
    expect(within(region).getByText("Calendar needs a date property.")).toBeVisible();
    fireEvent.click(within(region).getByRole("button", { name: "Add date property" }));
    expect(await within(region).findByRole("region", { name: "Research calendar" })).toBeVisible();
    fireEvent.click(within(region).getByRole("button", { name: "View" }));
    const filterBy = within(region).getByRole("combobox", { name: "Filter by" });
    expect(filterBy).toBeVisible();
    expect(within(region).getByRole("combobox", { name: "Density" })).toBeVisible();
    fireEvent.change(filterBy, { target: { value: titleId } });
    fireEvent.change(within(region).getByRole("textbox", { name: "Filter value" }), { target: { value: "No matching idea" } });
    expect(within(region).queryByText("Map constraints")).not.toBeInTheDocument();
  });

  it("names cross-Note reuse explicitly and restores focus after move and delete impact review", async () => {
    const other = { ...collection, id: "99999999-9999-4999-8999-999999999998", ownerNoteId: "99999999-9999-4999-8999-999999999999", title: "Shared research" };
    const impact = { noteId: collection.ownerNoteId, collections: [{ id: collection.id, title: collection.title, recordCount: 1 }],
      relations: [{ collectionId: collection.id, recordId, propertyId: titleId, referenceCount: 2 }],
      viewBlocks: [{ id: view.id, title: view.title, ownerNoteId: view.ownerNoteId }], token: "exact-impact" };
    const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => { const path = String(input);
      if (path.endsWith("/impact")) return Response.json({ impact });
      if (init?.method === "POST") return Response.json({ view }, { status: 201 });
      return Response.json({ workspaceId: collection.workspaceId, collections: [collection], availableCollections: [collection, other],
        availableCollectionNotes: { [collection.id]: "Research note", [other.id]: "Field notes" }, views: [] });
    }) as typeof fetch;
    renderWorkspace(fetcher);

    fireEvent.click(await screen.findByRole("button", { name: "Insert view of another collection" }));
    expect(screen.getByRole("option", { name: "Shared research — Field notes" })).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Cancel insert view" }));
    const region = screen.getByRole("region", { name: "Research" }); const more = within(region).getByRole("button", { name: "Collection actions" });
    fireEvent.click(more); fireEvent.click(within(region).getByRole("button", { name: "Move to another Note" }));
    const moveDialog = await screen.findByRole("dialog", { name: "Move Research collection?" });
    expect(within(moveDialog).getByText("1 record will move with this Collection.")).toBeVisible();
    expect(within(moveDialog).getByText("2 relation references will keep pointing to it.")).toBeVisible();
    expect(within(moveDialog).getByText("1 inserted view will keep showing it.")).toBeVisible();
    fireEvent.click(within(moveDialog).getByRole("button", { name: "Cancel move" }));
    await waitFor(() => expect(more).toHaveFocus());

    fireEvent.click(more); fireEvent.click(within(region).getByRole("button", { name: "Delete collection" }));
    expect(await screen.findByRole("dialog", { name: "Delete Research collection?" })).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Cancel deletion" }));
    await waitFor(() => expect(more).toHaveFocus());
  });

  it("duplicates Collection structure without copying canonical records", async () => {
    const requests: Array<{ path: string; init?: RequestInit }> = []; let collections = [collection];
    const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => { const path = String(input); requests.push({ path, init });
      if (init?.method === "POST") { const duplicate = JSON.parse(String(init.body)) as Collection; collections = [...collections, duplicate];
        return Response.json({ collection: duplicate }, { status: 201 }); }
      return Response.json({ workspaceId: collection.workspaceId, collections, availableCollections: collections, views: [] });
    }) as typeof fetch;
    renderWorkspace(fetcher);
    const region = await screen.findByRole("region", { name: "Research" });

    fireEvent.click(within(region).getByRole("button", { name: "Collection actions" }));
    fireEvent.click(within(region).getByRole("button", { name: "Duplicate" }));

    expect(await screen.findByRole("region", { name: "Research copy" })).toBeVisible();
    const duplicate = JSON.parse(String(requests.find(({ init }) => init?.method === "POST")?.init?.body)) as Collection;
    expect(duplicate.records).toEqual([]);
    expect(duplicate.properties).toHaveLength(collection.properties.length);
    expect(duplicate.properties.map(({ id }) => id)).not.toEqual(collection.properties.map(({ id }) => id));
  });
});
