import { describe, expect, it } from "vitest";

import {
  displayCollectionPropertyValue,
  groupReadableRecords,
  readablePresentationName,
  visibleNoteTree,
} from "./workspace-reader-model";

describe("mobile Workspace reader model", () => {
  it("hides descendants when a Note branch is collapsed", () => {
    const nodes = [
      { id: "root", workspaceId: "workspace", title: "Root", position: "a", childCount: 1 },
      { id: "child", workspaceId: "workspace", parentId: "root", title: "Child", position: "b", childCount: 1 },
      { id: "leaf", workspaceId: "workspace", parentId: "child", title: "Leaf", position: "c", childCount: 0 },
    ];
    expect(visibleNoteTree(nodes, new Set(["child"])).map(({ id }) => id)).toEqual(["root", "child"]);
  });

  it("preserves Collection grouping, filtering, and sorting in readable views", () => {
    const records = [
      { id: "second", position: 2, values: { status: "doing", title: "Beta" } },
      { id: "first", position: 1, values: { status: "todo", title: "Alpha" } },
      { id: "hidden", position: 3, values: { status: "done", title: "Archive" } },
    ];
    const groups = groupReadableRecords(records, {
      filters: [{ propertyId: "title", operator: "not_equals", value: "Archive" }],
      sorts: [{ propertyId: "title", direction: "descending" }], groupBy: "status",
    }, [{ id: "status", name: "Status", position: 2, type: "single_select",
      options: [{ id: "doing", name: "In progress" }, { id: "todo", name: "Not started" }] }]);
    expect(groups.map(({ label, items }) => [label, items.map(({ id }) => id)])).toEqual([
      ["In progress", ["second"]], ["Not started", ["first"]],
    ]);
  });

  it("places a multi-value Collection record in every matching readable group", () => {
    const records = [
      { id: "both", position: 1, values: { tags: ["research", "writing"] } },
      { id: "empty", position: 2, values: { tags: [] } },
    ];
    const groups = groupReadableRecords(records, { filters: [], sorts: [], groupBy: "tags" }, [{
      id: "tags", name: "Tags", position: 1, type: "multi_select",
      options: [{ id: "research", name: "Research" }, { id: "writing", name: "Writing" }],
    }]);

    expect(groups.map(({ label, items }) => [label, items.map(({ id }) => id)])).toEqual([
      ["Research", ["both"]],
      ["Writing", ["both"]],
      ["No value", ["empty"]],
    ]);
  });

  it("uses each relation fallback as a readable group without exposing relation IDs", () => {
    const groups = groupReadableRecords([{ id: "related", position: 1, values: { related: [
      { id: "11111111-1111-4111-8111-111111111111", fallback: "Design brief" },
      { id: "22222222-2222-4222-8222-222222222222", fallback: "Research notes" },
    ] } }], { filters: [], sorts: [], groupBy: "related" }, [{
      id: "related", name: "Related", position: 1, type: "relation", target: { kind: "notes" },
    }]);

    expect(groups.map(({ label }) => label)).toEqual(["Design brief", "Research notes"]);
  });

  it("matches web grouping when different relation identities share one fallback", () => {
    const groups = groupReadableRecords([
      { id: "first", position: 1, values: { related: [{ id: "11111111-1111-4111-8111-111111111111", fallback: "Unavailable note" }] } },
      { id: "second", position: 2, values: { related: [{ id: "22222222-2222-4222-8222-222222222222", fallback: "Unavailable note" }] } },
    ], { filters: [], sorts: [], groupBy: "related" }, [{
      id: "related", name: "Related", position: 1, type: "relation", target: { kind: "notes" },
    }]);

    expect(groups.map(({ label, items }) => [label, items.map(({ id }) => id)])).toEqual([
      ["Unavailable note", ["first", "second"]],
    ]);
  });

  it("limits a focused Collection view to its canonical record", () => {
    const records = [
      { id: "first", position: 1, values: { title: "Alpha" } },
      { id: "second", position: 2, values: { title: "Beta" } },
    ];
    expect(groupReadableRecords(records, {
      filters: [], sorts: [], focused: { recordId: "second" },
    }).flatMap(({ items }) => items.map(({ id }) => id))).toEqual(["second"]);
  });

  it("uses readable presentation and typed property values", () => {
    expect(readablePresentationName("table")).toBe("Table");
    expect(displayCollectionPropertyValue({
      id: "status", name: "Status", position: 2, type: "single_select",
      options: [{ id: "doing", name: "In progress" }],
    }, "doing")).toBe("In progress");
  });
});
