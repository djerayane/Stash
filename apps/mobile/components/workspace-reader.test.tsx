import type { MobileWorkspaceSnapshot } from "@stash/domain-types";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { WorkspaceReader } from "./workspace-reader";

const workspaceId = "11111111-1111-4111-8111-111111111111";
const noteId = "22222222-2222-4222-8222-222222222222";
const collectionId = "33333333-3333-4333-8333-333333333333";
const namePropertyId = "44444444-4444-4444-8444-444444444444";
const statusPropertyId = "55555555-5555-4555-8555-555555555555";
const researchRecordId = "66666666-6666-4666-8666-666666666666";
const taskId = "99999999-9999-4999-8999-999999999999";
const statusId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const adaId = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const graceId = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
const ordinalNameId = "abababab-abab-4bab-8bab-abababababab";
const prefixedNameId = "bcbcbcbc-bcbc-4cbc-8cbc-bcbcbcbcbcbc";

afterEach(cleanup);

const snapshot: MobileWorkspaceSnapshot = {
  schema: "stash.mobile-workspace.v1",
  workspaceId,
  refreshedAt: "2026-08-28T10:00:00.000Z",
  members: [],
  noteTree: [{ id: noteId, workspaceId, title: "Research notes", position: "a", childCount: 0 }],
  notes: [{ id: noteId, workspaceId, title: "Research notes", content: "Source notes", revision: 1 }],
  tasks: [{ schema: "stash.task.v1", id: taskId, workspaceId, title: "Prepare interview summary", description: "",
    revision: 2, status: { id: statusId, name: "Stored status", category: "started", position: 1 }, assigneeIds: [],
    projectKeys: [], sourceNoteIds: [] }],
  workflow: { schema: "stash.workspace-workflow.v1", workspaceId,
    statuses: [{ id: statusId, name: "Ready for review", category: "started", position: 1 }] },
  collections: [{
    schema: "stash.collection.v1",
    id: collectionId,
    workspaceId,
    ownerNoteId: noteId,
    title: "Research",
    properties: [
      { id: namePropertyId, name: "Name", position: 1, type: "text" },
      { id: statusPropertyId, name: "Status", position: 2, type: "single_select", options: [{ id: "doing", name: "In progress" }] },
    ],
    records: [{ id: researchRecordId, position: 1, values: { [namePropertyId]: "Interview synthesis", [statusPropertyId]: "doing" } }],
  }],
  viewBlocks: [{
    schema: "stash.view-block.v1",
    id: "77777777-7777-4777-8777-777777777777",
    workspaceId,
    ownerNoteId: noteId,
    blockId: "88888888-8888-4888-8888-888888888888",
    title: "Research",
    definition: { source: { kind: "collection", collectionId }, presentation: "table", filters: [], sorts: [],
      groupBy: statusPropertyId, layout: {} },
  }, {
    schema: "stash.view-block.v1",
    id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    workspaceId,
    ownerNoteId: noteId,
    blockId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
    title: "Delivery",
    definition: { source: { kind: "tasks", workspaceId }, presentation: "board", filters: [], sorts: [],
      groupBy: "task:status", layout: {} },
  }],
  search: [],
};

describe("WorkspaceReader", () => {
  it("offers accessible Notes, Tasks, Search, and Views navigation", () => {
    render(<WorkspaceReader snapshot={snapshot} pendingTaskIds={new Set()} onUpdateTaskStatus={vi.fn()} />);

    for (const name of ["Notes", "Tasks", "Search", "Views"]) {
      expect(screen.getByRole("tab", { name })).toBeTruthy();
    }
  });

  it("announces a Collection source and presentation as readable property rows", () => {
    render(<WorkspaceReader snapshot={snapshot} pendingTaskIds={new Set()} onUpdateTaskStatus={vi.fn()} />);
    fireEvent.click(screen.getByRole("tab", { name: "Views" }));

    expect(screen.getAllByRole("heading", { name: "Research" }).length).toBeGreaterThan(0);
    expect(screen.getByText("Table from Research in Research notes")).toBeTruthy();
    expect(screen.getByRole("heading", { name: "In progress" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Interview synthesis" })).toBeTruthy();
    expect(screen.getByLabelText("Status: In progress")).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Ready for review" })).toBeTruthy();
  });

  it("opens a direct cached Collection without requiring a saved View and queues a record edit", async () => {
    const updateRecord = vi.fn(async () => undefined);
    render(<WorkspaceReader snapshot={{ ...snapshot, viewBlocks: [] }} pendingTaskIds={new Set()}
      pendingCollectionRecordIds={new Set()} onUpdateTaskStatus={vi.fn()} onUpdateCollectionRecord={updateRecord} />);
    fireEvent.click(screen.getByRole("tab", { name: "Views" }));

    fireEvent.click(screen.getByRole("button", { name: "Open Collection Research" }));
    expect(screen.getByText("Owned by Research notes")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Open record Interview synthesis" }));
    const editor = screen.getByLabelText("Edit Name for Interview synthesis");
    fireEvent.change(editor, { target: { value: "Interview findings" } });
    fireEvent.click(screen.getByRole("button", { name: "Save Interview synthesis" }));

    expect(updateRecord).toHaveBeenCalledWith(collectionId, researchRecordId, {
      [namePropertyId]: "Interview findings",
    });
  });

  it("counts a multi-grouped Collection record once and uses its primary text label", () => {
    const tagsId = "13131313-1313-4313-8313-131313131313";
    const groupedSnapshot: MobileWorkspaceSnapshot = {
      ...snapshot,
      collections: [{ ...snapshot.collections[0]!, properties: [
        { id: statusPropertyId, name: "Status", position: 1, type: "single_select", options: [{ id: "doing", name: "In progress" }] },
        { id: namePropertyId, name: "Name", position: 2, type: "text" },
        { id: tagsId, name: "Tags", position: 3, type: "multi_select", options: [
          { id: "research", name: "Research" }, { id: "writing", name: "Writing" },
        ] },
      ], records: [{ ...snapshot.collections[0]!.records[0]!, values: {
        ...snapshot.collections[0]!.records[0]!.values, [tagsId]: ["research", "writing"],
      } }] }],
      viewBlocks: [{ ...snapshot.viewBlocks[0]!, definition: {
        ...snapshot.viewBlocks[0]!.definition, groupBy: tagsId,
      } }],
    };
    render(<WorkspaceReader snapshot={groupedSnapshot} pendingTaskIds={new Set()} onUpdateTaskStatus={vi.fn()} />);
    fireEvent.click(screen.getByRole("tab", { name: "Views" }));

    expect(screen.queryByText("2 records")).toBeNull();
    expect(screen.getAllByText("1 record").length).toBeGreaterThan(0);
    expect(screen.getAllByRole("heading", { name: "Interview synthesis" })).toHaveLength(2);
    expect(screen.getAllByRole("heading", { name: "Research" }).length).toBeGreaterThan(0);
    expect(screen.getByRole("heading", { name: "Writing" })).toBeTruthy();
  });

  it("disables every Task status action while that Task has a pending contribution", () => {
    const nextStatus = { id: "12121212-1212-4212-8212-121212121212", name: "Done", category: "completed", position: 2 };
    render(<WorkspaceReader snapshot={{ ...snapshot, workflow: { ...snapshot.workflow,
      statuses: [...snapshot.workflow.statuses, nextStatus] } }} pendingTaskIds={new Set([taskId])} onUpdateTaskStatus={vi.fn()} />);
    fireEvent.click(screen.getByRole("tab", { name: "Tasks" }));

    expect(screen.getByRole("button", { name: "Set Prepare interview summary status to Ready for review" })).toHaveProperty("disabled", true);
    expect(screen.getByRole("button", { name: "Set Prepare interview summary status to Done" })).toHaveProperty("disabled", true);
  });

  it("keeps different single-assignee Task groups distinct and names their Members", () => {
    const assignedSnapshot = {
      ...snapshot,
      members: [{ id: adaId, name: "Ada Lovelace" }, { id: graceId, name: "Grace Hopper" }],
      tasks: [
        { ...snapshot.tasks[0]!, assigneeIds: [adaId] },
        { ...snapshot.tasks[0]!, id: "ffffffff-ffff-4fff-8fff-ffffffffffff", title: "Validate compiler", assigneeIds: [graceId] },
      ],
      viewBlocks: [{ ...snapshot.viewBlocks[1]!, definition: {
        ...snapshot.viewBlocks[1]!.definition, groupBy: "task:assignee" as const,
      } }],
    };
    render(<WorkspaceReader snapshot={assignedSnapshot} pendingTaskIds={new Set()} onUpdateTaskStatus={vi.fn()} />);
    fireEvent.click(screen.getByRole("tab", { name: "Views" }));

    expect(screen.getByRole("heading", { name: "Ada Lovelace" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Grace Hopper" })).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "1 assignee" })).toBeNull();
  });

  it("disambiguates different assignee groups whose Members share one name", () => {
    const assignedSnapshot = {
      ...snapshot,
      members: [{ id: adaId, name: "Alex Smith" }, { id: graceId, name: "Alex Smith" }],
      tasks: [
        { ...snapshot.tasks[0]!, assigneeIds: [adaId] },
        { ...snapshot.tasks[0]!, id: "ffffffff-ffff-4fff-8fff-ffffffffffff", title: "Validate compiler", assigneeIds: [graceId] },
      ],
      viewBlocks: [{ ...snapshot.viewBlocks[1]!, definition: {
        ...snapshot.viewBlocks[1]!.definition, groupBy: "task:assignee" as const,
      } }],
    };
    render(<WorkspaceReader snapshot={assignedSnapshot} pendingTaskIds={new Set()} onUpdateTaskStatus={vi.fn()} />);
    fireEvent.click(screen.getByRole("tab", { name: "Views" }));

    expect(screen.getByRole("heading", { name: "Group 1 of 2 · Alex Smith" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Group 2 of 2 · Alex Smith" })).toBeTruthy();
    expect(screen.queryByText(new RegExp(adaId))).toBeNull();
    expect(screen.queryByText(new RegExp(graceId))).toBeNull();
  });

  it("keeps assignee group labels unique when a Member name matches a generated ordinal label", () => {
    const assignedSnapshot = {
      ...snapshot,
      members: [
        { id: adaId, name: "Alex Smith" },
        { id: graceId, name: "Alex Smith" },
        { id: ordinalNameId, name: "Alex Smith · 1 of 2" },
        { id: prefixedNameId, name: "Group 1 of 4 · Alex Smith" },
      ],
      tasks: [
        { ...snapshot.tasks[0]!, assigneeIds: [adaId] },
        { ...snapshot.tasks[0]!, id: "ffffffff-ffff-4fff-8fff-ffffffffffff", title: "Validate compiler", assigneeIds: [graceId] },
        { ...snapshot.tasks[0]!, id: "acacacac-acac-4cac-8cac-acacacacacac", title: "Review generated labels", assigneeIds: [ordinalNameId] },
        { ...snapshot.tasks[0]!, id: "cdcdcdcd-cdcd-4dcd-8dcd-cdcdcdcdcdcd", title: "Review prefixed labels", assigneeIds: [prefixedNameId] },
      ],
      viewBlocks: [{ ...snapshot.viewBlocks[1]!, definition: {
        ...snapshot.viewBlocks[1]!.definition, groupBy: "task:assignee" as const,
      } }],
    };
    render(<WorkspaceReader snapshot={assignedSnapshot} pendingTaskIds={new Set()} onUpdateTaskStatus={vi.fn()} />);
    fireEvent.click(screen.getByRole("tab", { name: "Views" }));

    const labels = screen.getAllByRole("heading", { name: /Alex Smith/ }).map(({ textContent }) => textContent);
    expect(labels).toEqual([
      "Group 1 of 4 · Alex Smith",
      "Group 2 of 4 · Alex Smith · 1 of 2",
      "Group 3 of 4 · Group 1 of 4 · Alex Smith",
      "Group 4 of 4 · Alex Smith",
    ]);
    expect(new Set(labels).size).toBe(4);
    expect(screen.queryByText(new RegExp(adaId))).toBeNull();
    expect(screen.queryByText(new RegExp(graceId))).toBeNull();
    expect(screen.queryByText(new RegExp(ordinalNameId))).toBeNull();
    expect(screen.queryByText(new RegExp(prefixedNameId))).toBeNull();
  });

  it("disambiguates repeated unknown assignee groups without exposing their IDs", () => {
    const assignedSnapshot = {
      ...snapshot,
      tasks: [
        { ...snapshot.tasks[0]!, assigneeIds: [adaId] },
        { ...snapshot.tasks[0]!, id: "ffffffff-ffff-4fff-8fff-ffffffffffff", title: "Validate compiler", assigneeIds: [graceId] },
      ],
      viewBlocks: [{ ...snapshot.viewBlocks[1]!, definition: {
        ...snapshot.viewBlocks[1]!.definition, groupBy: "task:assignee" as const,
      } }],
    };
    render(<WorkspaceReader snapshot={assignedSnapshot} pendingTaskIds={new Set()} onUpdateTaskStatus={vi.fn()} />);
    fireEvent.click(screen.getByRole("tab", { name: "Views" }));

    expect(screen.getByRole("heading", { name: "Group 1 of 2 · Unknown Member" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Group 2 of 2 · Unknown Member" })).toBeTruthy();
    expect(screen.queryByText(new RegExp(adaId))).toBeNull();
    expect(screen.queryByText(new RegExp(graceId))).toBeNull();
  });
});
