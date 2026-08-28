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
    });
    expect(groups.map(({ label, items }) => [label, items.map(({ id }) => id)])).toEqual([
      ["Doing", ["second"]], ["Todo", ["first"]],
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
