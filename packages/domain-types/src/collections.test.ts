import { describe, expect, it } from "vitest";

import { normalizeViewDefinition } from "./collections";

describe("Task view definitions", () => {
  it("accepts canonical Task fields for filters, sorts, and grouping", () => {
    const workspaceId = "11111111-1111-4111-8111-111111111111";
    expect(normalizeViewDefinition({
      source: { kind: "tasks", workspaceId }, presentation: "board",
      filters: [{ propertyId: "task:project", operator: "equals", value: "STASH-173" }],
      sorts: [{ propertyId: "task:title", direction: "ascending" }],
      groupBy: "task:status", layout: {},
    })).toMatchObject({ groupBy: "task:status", sorts: [{ propertyId: "task:title" }] });
  });

  it("rejects Task fields absent from the canonical mobile read model", () => {
    expect(() => normalizeViewDefinition({
      source: { kind: "tasks", workspaceId: "11111111-1111-4111-8111-111111111111" }, presentation: "list",
      filters: [], sorts: [{ propertyId: "task:due_date", direction: "ascending" }], layout: {},
    })).toThrow("invalid_view_definition");
  });
});
