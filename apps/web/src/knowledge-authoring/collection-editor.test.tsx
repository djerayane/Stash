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

function renderWorkspace(fetcher: typeof fetch, noteId = collection.ownerNoteId, editable = true) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={client}><CollectionWorkspace noteId={noteId} token="member" editable={editable} fetcher={fetcher} /></QueryClientProvider>);
}

describe("Collection workspace", () => {
  it("places primary Collection creation directly after the Note-owned Collections", async () => {
    const reused = { ...view, id: "77777777-7777-4777-8777-777777777779", ownerNoteId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      blockId: "88888888-8888-4888-8888-888888888880", title: "Reused research" };
    const fetcher = vi.fn(async () => Response.json({ workspaceId: collection.workspaceId, collections: [collection], availableCollections: [collection],
      availableCollectionNotes: { [collection.id]: "Research note" }, availableNotes: [], views: [reused] })) as typeof fetch;
    renderWorkspace(fetcher);

    const owned = await screen.findByRole("region", { name: "Research" });
    const create = screen.getByRole("button", { name: "New collection" });
    const reusedRegion = screen.getByRole("region", { name: "Reused research" });
    expect(owned.compareDocumentPosition(create) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(create.compareDocumentPosition(reusedRegion) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

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
    const requests: Array<{ path: string; init?: RequestInit }> = []; let current = collection; let staleDelete = true;
    const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => { const path = String(input); requests.push({ path, init });
      if (path.endsWith(`/properties/${statusId}/impact`)) return Response.json({ impact: { collectionId: collection.id, propertyId: statusId,
        affectedValues: 1, affectedRelations: 0, affectedViews: 1, token: "preview-token" } });
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
        if (staleDelete) { staleDelete = false; return Response.json({ message: "Property impact changed. Review the updated impact before deleting.", impact: {
          collectionId: collection.id, propertyId: statusId, affectedValues: 2, affectedRelations: 0, affectedViews: 2, token: "fresh-token",
        } }, { status: 409 }); }
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
    fireEvent.change(screen.getByRole("textbox", { name: "Option 1" }), { target: { value: "In progress" } });
    fireEvent.click(screen.getByRole("button", { name: "Move option 1 down" }));
    fireEvent.click(screen.getByRole("button", { name: "Add option" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Option 3" }), { target: { value: "Blocked" } });
    fireEvent.click(screen.getByRole("button", { name: "Save property" }));
    expect(await within(region).findByRole("columnheader", { name: "Stage" })).toBeVisible();
    const renamedPayload = JSON.parse(String(requests.find(({ path, init }) => path.endsWith(`/properties/${statusId}`)
      && init?.method === "PATCH")?.init?.body));
    expect(renamedPayload.options.slice(0, 2)).toEqual([{ id: "later", name: "Later" }, { id: "ready", name: "In progress" }]);
    expect(renamedPayload.options[2]).toEqual(expect.objectContaining({ name: "Blocked" }));
    expect(renamedPayload.options[2].id).not.toMatch(/^option-/);

    fireEvent.click(within(region).getByRole("button", { name: "Edit Stage property" }));
    fireEvent.click(screen.getByRole("button", { name: "Duplicate property" }));
    expect(await within(region).findByRole("columnheader", { name: "Stage copy" })).toBeVisible();

    fireEvent.click(within(region).getByRole("button", { name: "Edit Stage property" }));
    fireEvent.click(screen.getByRole("button", { name: "Delete property" }));
    const dialog = await screen.findByRole("dialog", { name: "Delete Stage property?" });
    expect(within(dialog).getByText("1 saved value will be removed.")).toBeVisible();
    expect(within(dialog).getByText("1 view will be updated.")).toBeVisible();
    fireEvent.click(within(dialog).getByRole("button", { name: "Delete property" }));
    expect(await within(dialog).findByText("2 saved values will be removed.")).toBeVisible();
    expect(within(dialog).getByRole("alert")).toHaveTextContent("Review the updated impact");
    fireEvent.click(within(dialog).getByRole("button", { name: "Delete property" }));
    await waitFor(() => expect(requests.filter(({ path, init }) => path.endsWith(`/properties/${statusId}`) && init?.method === "DELETE")).toHaveLength(2));
    const deletions = requests.filter(({ path, init }) => path.endsWith(`/properties/${statusId}`) && init?.method === "DELETE");
    expect(JSON.parse(String(deletions[0]?.init?.body))).toEqual({ impactToken: "preview-token" });
    expect(JSON.parse(String(deletions[1]?.init?.body))).toEqual({ impactToken: "fresh-token" });
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
    fireEvent.click(within(region).getByRole("button", { name: "View settings" }));
    const filterBy = within(region).getByRole("combobox", { name: "Filter by" });
    expect(filterBy).toBeVisible();
    expect(within(region).getByRole("combobox", { name: "Density" })).toBeVisible();
    fireEvent.change(filterBy, { target: { value: titleId } });
    fireEvent.change(within(region).getByRole("textbox", { name: "Filter value" }), { target: { value: "No matching idea" } });
    expect(within(region).queryByText("Map constraints")).not.toBeInTheDocument();
    expect(within(region).getByRole("button", { name: /View.*Filtered/ })).toHaveAccessibleName(/Filtered/);
  });

  it("uses option-aware filters and Collection labels for typed relation setup", async () => {
    const other = { ...collection, id: "99999999-9999-4999-8999-999999999998", ownerNoteId: "99999999-9999-4999-8999-999999999997", title: "People" };
    const fetcher = vi.fn(async () => Response.json({ workspaceId: collection.workspaceId, collections: [collection], availableCollections: [collection, other],
      availableCollectionNotes: { [other.id]: "Directory" }, availableNotes: [], views: [], selectionOptions: {
        members: [{ id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", label: "Ada Lovelace" }], attachments: [], notes: [], tasks: [], projects: [],
      } })) as typeof fetch;
    renderWorkspace(fetcher);
    const region = await screen.findByRole("region", { name: "Research" });

    fireEvent.click(within(region).getByRole("button", { name: "View settings" }));
    fireEvent.change(within(region).getByRole("combobox", { name: "Filter by" }), { target: { value: statusId } });
    const filterValue = within(region).getByRole("combobox", { name: "Filter value" });
    expect(filterValue).toHaveDisplayValue("No value");
    expect(within(filterValue).getByRole("option", { name: "Ready" })).toBeVisible();

    fireEvent.click(within(region).getByRole("button", { name: "Add property" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Property name" }), { target: { value: "Person link" } });
    fireEvent.change(screen.getByRole("combobox", { name: "Property type" }), { target: { value: "relation" } });
    fireEvent.change(screen.getByRole("combobox", { name: "Relation target" }), { target: { value: "collection_records" } });
    const target = screen.getByRole("combobox", { name: "Related Collection" });
    expect(within(target).getByRole("option", { name: "People — Directory" })).toHaveValue(other.id);
    expect(screen.queryByRole("textbox", { name: /Collection identity/i })).not.toBeInTheDocument();
  });

  it("keeps the primary text field available and focused when a View hides it", async () => {
    const hiddenPrimary = { ...view, definition: { ...view.definition, layout: { visiblePropertyIds: [statusId] } } };
    const fetcher = vi.fn(async () => Response.json({ workspaceId: collection.workspaceId, collections: [], availableCollections: [collection],
      availableCollectionNotes: { [collection.id]: "Research note" }, availableNotes: [], views: [hiddenPrimary] })) as typeof fetch;
    renderWorkspace(fetcher);
    const region = await screen.findByRole("region", { name: "Research lens" });

    expect(within(region).queryByRole("columnheader", { name: "Idea" })).not.toBeInTheDocument();
    fireEvent.click(within(region).getByRole("button", { name: "New record" }));
    const primary = within(region).getByRole("textbox", { name: "Idea, new record" });
    expect(primary).toBeVisible();
    await waitFor(() => expect(primary).toHaveFocus());
  });

  it("discloses canonical impact once before editing through a cross-Note View", async () => {
    const crossNote = { ...view, ownerNoteId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" };
    const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === "PATCH") return Response.json({ status: "updated" });
      return Response.json({ workspaceId: collection.workspaceId, collections: [], availableCollections: [collection],
        availableCollectionNotes: { [collection.id]: "Research note" }, availableNotes: [], views: [crossNote] });
    }) as typeof fetch;
    renderWorkspace(fetcher, crossNote.ownerNoteId);
    const region = await screen.findByRole("region", { name: "Research lens" });

    fireEvent.click(within(region).getByRole("button", { name: "Edit Idea, Map constraints" }));
    const dialog = await screen.findByRole("dialog", { name: "Edit this canonical record?" });
    expect(within(dialog).getByText(/changes will appear everywhere/i)).toBeVisible();
    fireEvent.click(within(dialog).getByRole("button", { name: "Continue editing" }));
    const editor = within(region).getByRole("textbox", { name: "Idea, Map constraints" });
    await waitFor(() => expect(editor).toHaveFocus());

    fireEvent.change(editor, { target: { value: "Updated everywhere" } });
    fireEvent.blur(editor);
    await waitFor(() => expect(fetcher).toHaveBeenCalledWith(expect.stringContaining(`/records/${recordId}`), expect.objectContaining({ method: "PATCH" })));
    expect(screen.queryByRole("dialog", { name: "Edit this canonical record?" })).not.toBeInTheDocument();
  });

  it("refreshes Collection deletion impact after a stale confirmation", async () => {
    const initial = { noteId: collection.ownerNoteId, collections: [{ id: collection.id, title: collection.title, recordCount: 1 }],
      relations: [], viewBlocks: [], token: "old-impact" };
    const refreshed = { ...initial, collections: [{ id: collection.id, title: collection.title, recordCount: 3 }],
      relations: [{ collectionId: collection.id, recordId, propertyId: statusId, referenceCount: 4 }], token: "new-impact" };
    const deletionBodies: unknown[] = []; let stale = true;
    const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => { const path = String(input);
      if (path.endsWith("/impact")) return Response.json({ impact: initial });
      if (path.endsWith("/delete") && init?.method === "POST") { deletionBodies.push(JSON.parse(String(init.body)));
        if (stale) { stale = false; return Response.json({ message: "Collection impact changed. Review the updated impact before deleting.", impact: refreshed }, { status: 409 }); }
        return Response.json({ status: "deleted", impact: refreshed }); }
      return Response.json({ workspaceId: collection.workspaceId, collections: [collection], availableCollections: [collection], availableNotes: [], views: [] });
    }) as typeof fetch;
    renderWorkspace(fetcher);
    const region = await screen.findByRole("region", { name: "Research" });

    fireEvent.click(within(region).getByRole("button", { name: "Collection actions" }));
    fireEvent.click(within(region).getByRole("button", { name: "Delete collection" }));
    const dialog = await screen.findByRole("dialog", { name: "Delete Research collection?" });
    fireEvent.click(within(dialog).getByRole("button", { name: "Delete collection" }));
    expect(await within(dialog).findByText("3 records will be deleted.")).toBeVisible();
    expect(within(dialog).getByText("4 relation references will be removed.")).toBeVisible();
    expect(within(dialog).getByRole("alert")).toHaveTextContent("Review the updated impact");
    fireEvent.click(within(dialog).getByRole("button", { name: "Delete collection" }));
    await waitFor(() => expect(deletionBodies).toHaveLength(2));
    expect(deletionBodies).toEqual([
      { confirmed: true, impactToken: "old-impact", collectionIds: [collection.id] },
      { confirmed: true, impactToken: "new-impact", collectionIds: [collection.id] },
    ]);
  });

  it("keeps filtered arrow navigation bounded to rendered rows", async () => {
    const hiddenRecord = { id: "66666666-6666-4666-8666-666666666667", position: 2,
      values: { [titleId]: "Hidden", [statusId]: "later" } };
    const filteredCollection = { ...collection, records: [...collection.records, hiddenRecord] };
    const filtered = { ...view, definition: { ...view.definition, filters: [{ propertyId: statusId, operator: "equals" as const, value: "ready" }] } };
    const fetcher = vi.fn(async () => Response.json({ workspaceId: collection.workspaceId, collections: [], availableCollections: [filteredCollection],
      availableCollectionNotes: { [collection.id]: "Research note" }, availableNotes: [], views: [filtered] })) as typeof fetch;
    const focus = vi.spyOn(HTMLElement.prototype, "focus");
    renderWorkspace(fetcher);
    const region = await screen.findByRole("region", { name: "Research lens" });
    const cell = within(region).getByRole("textbox", { name: "Idea, Map constraints" });
    cell.focus(); focus.mockClear();

    fireEvent.keyDown(cell, { key: "ArrowDown" });

    expect(focus).toHaveBeenCalledTimes(1);
    expect(focus.mock.instances[0]).toBe(cell);
    focus.mockRestore();
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
        availableCollectionNotes: { [collection.id]: "Research note", [other.id]: "Field notes" }, availableNotes: [
          { id: collection.ownerNoteId, title: "Research note" }, { id: other.ownerNoteId, title: "Field notes" },
        ], views: [] });
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
    expect(within(moveDialog).getByRole("option", { name: "Field notes" })).toBeVisible();
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

  it("renders every saved Collection View independently with source ownership and safe canonical actions", async () => {
    const second: ViewBlock = { ...view, id: "77777777-7777-4777-8777-777777777778", blockId: "88888888-8888-4888-8888-888888888889",
      title: "Later ideas", definition: { ...view.definition, presentation: "list", filters: [{ propertyId: statusId, operator: "equals", value: "later" }] } };
    const fetcher = vi.fn(async () => Response.json({ workspaceId: collection.workspaceId, collections: [collection], availableCollections: [collection],
      availableCollectionNotes: { [collection.id]: "Research note" }, availableNotes: [{ id: collection.ownerNoteId, title: "Research note" }], views: [view, second] })) as typeof fetch;
    renderWorkspace(fetcher);

    expect(await screen.findByRole("region", { name: "Research" })).toBeVisible();
    const firstView = screen.getByRole("region", { name: "Research lens" });
    const secondView = screen.getByRole("region", { name: "Later ideas" });
    expect(within(firstView).getByText("View of Research · From Research note")).toBeVisible();
    expect(within(firstView).getByRole("textbox", { name: "Idea, Map constraints" })).toHaveValue("Map constraints");
    expect(within(secondView).queryByText("Map constraints")).not.toBeInTheDocument();
    expect(within(firstView).queryByRole("button", { name: "Collection actions" })).not.toBeInTheDocument();
    expect(within(firstView).queryByRole("button", { name: "Edit Status property" })).not.toBeInTheDocument();
    const viewName = within(firstView).getByRole("textbox", { name: "Idea, Map constraints" }) as HTMLInputElement;
    viewName.focus(); viewName.setSelectionRange(viewName.value.length, viewName.value.length);
    fireEvent.keyDown(viewName, { key: "ArrowRight" });
    expect(within(firstView).getByRole("combobox", { name: "Status, Map constraints" })).toHaveFocus();
  });

  it("prevents every persisted View mutation when the workspace is read-only", async () => {
    const readOnlyView = { ...view, definition: { ...view.definition, presentation: "list" as const } };
    const fetcher = vi.fn(async () => Response.json({ workspaceId: collection.workspaceId, collections: [collection], availableCollections: [collection],
      availableCollectionNotes: { [collection.id]: "Research note" }, views: [readOnlyView] })) as typeof fetch;
    renderWorkspace(fetcher, collection.ownerNoteId, false);
    const savedView = await screen.findByRole("region", { name: "Research lens" });

    expect(within(savedView).getByRole("button", { name: "Board" })).toBeDisabled();
    fireEvent.click(within(savedView).getByRole("button", { name: /Map constraints/ }));
    fireEvent.click(within(savedView).getByRole("button", { name: /View/ }));
    expect(fetcher).not.toHaveBeenCalledWith(expect.stringContaining("/api/view-blocks/"), expect.objectContaining({ method: "PATCH" }));
  });

  it("keeps failed required-property and Board actions adjacent and retryable", async () => {
    let propertyAttempts = 0; let moveAttempts = 0; const requests: Array<{ path: string; init?: RequestInit }> = [];
    let current: Collection = { ...collection, properties: [collection.properties[0]!] };
    const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => { const path = String(input); requests.push({ path, init });
      if (path.endsWith("/properties") && init?.method === "POST") { propertyAttempts += 1;
        if (propertyAttempts === 1) return Response.json({ message: "Connection lost while adding Status." }, { status: 503 });
        const property = JSON.parse(String(init.body)); current = { ...current, properties: [...current.properties, property] };
        return Response.json({ property }, { status: 201 }); }
      if (path.endsWith(`/records/${recordId}`) && init?.method === "PATCH") { moveAttempts += 1;
        if (moveAttempts === 1) return Response.json({ message: "Move could not be saved." }, { status: 503 });
        return Response.json({ status: "updated" }); }
      return Response.json({ workspaceId: collection.workspaceId, collections: [current], availableCollections: [current], views: [] });
    }) as typeof fetch;
    renderWorkspace(fetcher);
    const region = await screen.findByRole("region", { name: "Research" });

    fireEvent.click(within(region).getByRole("button", { name: "Board" }));
    fireEvent.click(within(region).getByRole("button", { name: "Add select property" }));
    expect(await within(region).findByRole("alert")).toHaveTextContent("Connection lost while adding Status");
    fireEvent.click(within(region).getByRole("button", { name: "Try again" }));
    expect(await within(region).findByRole("region", { name: "Research board" })).toBeVisible();

    expect(within(region).getByRole("heading", { name: "No value" })).toBeVisible();
    fireEvent.click(within(region).getByRole("button", { name: "Move Map constraints to Done" }));
    expect(await within(region).findByRole("alert")).toHaveTextContent("Move not saved");
    fireEvent.click(within(region).getByRole("button", { name: "Try again" }));
    await waitFor(() => expect(moveAttempts).toBe(2));
  });
});
