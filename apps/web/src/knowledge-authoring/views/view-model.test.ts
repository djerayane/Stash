import { describe, expect, it } from "vitest";

import type { Collection, ViewDefinition } from "@stash/domain-types";
import { evaluateCollectionView, presentationRequirement, updateBoardGroup } from "./view-model";

const titleId = "11111111-1111-4111-8111-111111111111";
const statusId = "22222222-2222-4222-8222-222222222222";
const dateId = "33333333-3333-4333-8333-333333333333";
const collection: Collection = { schema: "stash.collection.v1", id: "44444444-4444-4444-8444-444444444444",
  workspaceId: "55555555-5555-4555-8555-555555555555", ownerNoteId: "66666666-6666-4666-8666-666666666666", title: "Research",
  properties: [{ id: titleId, name: "Idea", type: "text", position: 1 },
    { id: statusId, name: "Status", type: "single_select", position: 2, options: [{ id: "ready", name: "Ready" }, { id: "later", name: "Later" }] },
    { id: dateId, name: "When", type: "date_time", position: 3 }],
  records: [{ id: "77777777-7777-4777-8777-777777777777", position: 1,
    values: { [titleId]: "Map constraints", [statusId]: "ready", [dateId]: { start: "2026-08-27", includeTime: false } } },
  { id: "88888888-8888-4888-8888-888888888888", position: 2,
    values: { [titleId]: "Interview members", [statusId]: "later", [dateId]: { start: "2026-08-28T09:00:00.000Z", includeTime: true } } }] };
const definition: ViewDefinition = { source: { kind: "collection", collectionId: collection.id }, presentation: "table",
  filters: [{ propertyId: statusId, operator: "equals", value: "ready" }], sorts: [{ propertyId: titleId, direction: "descending" }],
  groupBy: statusId, layout: {} };

describe("Collection view model", () => {
  it("evaluates filters, sorting, grouping, and presentation without copying or changing record identities", () => {
    const table = evaluateCollectionView(collection, definition);
    const calendar = evaluateCollectionView(collection, { ...definition, presentation: "calendar", filters: [], groupBy: dateId });

    expect(table.records.map(({ id }) => id)).toEqual(["77777777-7777-4777-8777-777777777777"]);
    expect(table.groups.map(({ key }) => key)).toEqual(["ready"]);
    expect(calendar.records.map(({ id }) => id)).toEqual(collection.records.map(({ id }) => id));
    expect(collection.records[0]?.values[statusId]).toBe("ready");
  });

  it("produces the same canonical value patch for drag and keyboard board movement", () => {
    expect(updateBoardGroup(collection, definition, "77777777-7777-4777-8777-777777777777", "later"))
      .toEqual({ recordId: "77777777-7777-4777-8777-777777777777", values: { [statusId]: "later" } });
    expect(() => updateBoardGroup(collection, { ...definition, groupBy: undefined }, collection.records[0]!.id, "later"))
      .toThrow(/board_group_unavailable/);
    const multi: Collection = { ...collection, properties: collection.properties.map((property) => property.id === statusId
      ? { id: property.id, name: property.name, position: property.position, type: "multi_select" as const,
        options: "options" in property ? property.options : [] } : property) };
    expect(updateBoardGroup(multi, definition, collection.records[0]!.id, "later"))
      .toEqual({ recordId: collection.records[0]!.id, values: { [statusId]: ["later"] } });
  });

  it("requests presentation prerequisites in context", () => {
    const textOnly = { ...collection, properties: collection.properties.slice(0, 1) };

    expect(presentationRequirement(textOnly, "calendar")).toEqual({ propertyType: "date_time", actionLabel: "Add date property" });
    expect(presentationRequirement(textOnly, "board")).toEqual({ propertyType: "single_select", actionLabel: "Add select property" });
    expect(presentationRequirement(collection, "calendar")).toBeUndefined();
    expect(presentationRequirement(collection, "board")).toBeUndefined();
  });

});
