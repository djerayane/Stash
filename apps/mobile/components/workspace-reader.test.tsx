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

    expect(screen.getByRole("heading", { name: "Research" })).toBeTruthy();
    expect(screen.getByText("Table from Research in Research notes")).toBeTruthy();
    expect(screen.getByRole("heading", { name: "In progress" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Interview synthesis" })).toBeTruthy();
    expect(screen.getByLabelText("Status: In progress")).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Ready for review" })).toBeTruthy();
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
});
