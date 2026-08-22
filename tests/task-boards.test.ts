import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";

import { BoardService, type Board, type BoardRepository, type BoardTask } from "../src/boards.js";
import { startInstance, type DatabaseProbe, type RunningInstance } from "../src/instance.js";
import type { MemberAccessResolver } from "../src/workspaces-projects.js";

const projectId = "22222222-2222-4222-8222-222222222222";
const backlogId = "33333333-3333-4333-8333-333333333333";
const progressId = "44444444-4444-4444-8444-444444444444";
const doneId = "55555555-5555-4555-8555-555555555555";

class BoardFake implements DatabaseProbe, BoardRepository {
  boards: Board[] = [];
  tasks: BoardTask[] = [
    { id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", key: "STASH-1", title: "Shape the board", status: { id: backlogId, name: "Backlog", category: "unstarted" }, assigneeIds: [], priority: "high", labelNames: ["planning"] },
    { id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", key: "STASH-2", title: "Ship the board", status: { id: progressId, name: "In Progress", category: "started" }, assigneeIds: [], priority: "urgent", labelNames: [] },
  ];
  fail = false;
  async verifyConnection() {}
  async close() {}
  private canRead(memberId: string) { return ["ada", "grace"].includes(memberId); }
  async listBoards(memberId: string, requestedProjectId: string) {
    if (!this.canRead(memberId) || requestedProjectId !== projectId) return { status: "not_found" as const };
    if (this.fail) throw new Error("postgres://secret");
    return { status: "found" as const, boards: structuredClone(this.boards) };
  }
  async createBoard(memberId: string, board: Board) {
    if (memberId === "grace") return { status: "forbidden" as const };
    if (memberId !== "ada" || board.projectId !== projectId) return { status: "not_found" as const };
    if (this.fail) throw new Error("postgres://secret");
    this.boards.push(structuredClone(board)); return { status: "created" as const, board: structuredClone(board) };
  }
  async readBoard(memberId: string, requestedProjectId: string, boardId: string) {
    if (!this.canRead(memberId) || requestedProjectId !== projectId) return { status: "not_found" as const };
    const board = this.boards.find(({ id }) => id === boardId); if (!board) return { status: "not_found" as const };
    return { status: "found" as const, board: structuredClone(board), tasks: structuredClone(this.tasks), statuses: [
      { id: backlogId, name: "Backlog", category: "unstarted" as const, position: 0, archived: false },
      { id: progressId, name: "In Progress", category: "started" as const, position: 1, archived: false },
      { id: doneId, name: "Done", category: "completed" as const, position: 2, archived: false },
    ] };
  }
  async moveTaskOnBoard(memberId: string, requestedProjectId: string, boardId: string, taskKey: string, statusId: string) {
    if (memberId === "grace") return { status: "forbidden" as const };
    const board = this.boards.find(({ id }) => id === boardId);
    const task = this.tasks.find(({ key }) => key === taskKey);
    if (memberId !== "ada" || requestedProjectId !== projectId || !board || !task) return { status: "not_found" as const };
    if (board.groupBy !== "status") return { status: "unsupported_group" as const };
    const status = [{ id: backlogId, name: "Backlog", category: "unstarted" as const }, { id: progressId, name: "In Progress", category: "started" as const }, { id: doneId, name: "Done", category: "completed" as const }].find(({ id }) => id === statusId);
    if (!status) return { status: "invalid_status" as const };
    if (this.fail) throw new Error("postgres://secret");
    task.status = status; return { status: "moved" as const, task: structuredClone(task) };
  }
}

const access: MemberAccessResolver = { async authenticateBearer(value) {
  if (value === "Bearer member") return { accountId: "ada", sessionId: "member" };
  if (value === "Bearer guest") return { accountId: "grace", sessionId: "guest" };
  return undefined;
} };

describe("Task board views", () => {
  let instance: RunningInstance | undefined;
  afterEach(async () => instance?.close());
  async function run() {
    const database = new BoardFake();
    instance = await startInstance({ database, host: "127.0.0.1", port: 0, instanceAdminToken: "admin", memberAccess: access, boards: new BoardService(database) });
    const request = (path = "", method = "GET", body?: unknown, token = "member") => fetch(`${instance!.url}/api/projects/${projectId}/boards${path}`, {
      method, headers: { authorization: `Bearer ${token}`, ...(body === undefined ? {} : { "content-type": "application/json" }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { database, request };
  }

  it("persists multiple views without duplicating canonical Tasks", async () => {
    const { database, request } = await run();
    const status = await request("", "POST", { name: "Delivery", groupBy: "status" });
    const priority = await request("", "POST", { name: "Urgency", groupBy: "priority" });
    assert.equal(status.status, 201); assert.equal(priority.status, 201);
    const boards = (await (await request()).json() as { boards: Board[] }).boards;
    assert.deepEqual(boards.map(({ name, groupBy }) => [name, groupBy]), [["Delivery", "status"], ["Urgency", "priority"]]);
    const statusView = await request(`/${boards[0]!.id}`); const priorityView = await request(`/${boards[1]!.id}`);
    assert.deepEqual((await statusView.json() as any).columns.map((column: any) => [column.name, column.tasks.map((task: BoardTask) => task.key)]), [["Backlog", ["STASH-1"]], ["In Progress", ["STASH-2"]], ["Done", []]]);
    assert.deepEqual((await priorityView.json() as any).columns.filter((column: any) => column.tasks.length).map((column: any) => [column.name, column.tasks.map((task: BoardTask) => task.key)]), [["High", ["STASH-1"]], ["Urgent", ["STASH-2"]]]);
    assert.equal(database.tasks.length, 2);
  });

  it("serves a keyboard-operable board surface with visible failure feedback", async () => {
    await run(); const response = await fetch(`${instance!.url}/boards`); const surface = await response.text();
    assert.equal(response.status, 200); assert.match(surface, /aria-live="polite"/); assert.match(surface, /Move .* to status/);
    assert.match(surface, /prefers-reduced-motion/); assert.match(surface, /gsap\.from/);
    assert.match(surface, /message\.textContent=body\.board\.name\+' loaded\.'/);
    assert.doesNotMatch(surface, /if\(!message\.textContent\)/);
    assert.match(surface, /boards\.replaceChildren\(\);current=undefined;columns\.replaceChildren\(\);message\.dataset\.error='false';/);
    assert.match(surface, /if\(!body\.boards\.length\)\{message\.textContent='No board views exist yet\.';return\}/);
  });

  it("moves the canonical Task through a status board and exposes the result in every view", async () => {
    const { database, request } = await run();
    const created = await request("", "POST", { name: "Delivery", groupBy: "status" });
    const board = (await created.json() as { board: Board }).board;
    const moved = await request(`/${board.id}/tasks/STASH-1`, "PATCH", { statusId: progressId });
    assert.equal(moved.status, 200); assert.equal(database.tasks[0]!.status.id, progressId);
    const view = await request(`/${board.id}`);
    assert.deepEqual((await view.json() as any).columns.find((column: any) => column.id === progressId).tasks.map((task: BoardTask) => task.key), ["STASH-1", "STASH-2"]);
  });

  it("lets selected Guests read boards but not create views or move Tasks", async () => {
    const { request } = await run();
    const board = (await (await request("", "POST", { name: "Delivery", groupBy: "status" })).json() as { board: Board }).board;
    assert.equal((await request(`/${board.id}`, "GET", undefined, "guest")).status, 200);
    assert.equal((await request("", "POST", { name: "Guest copy", groupBy: "status" }, "guest")).status, 403);
    assert.equal((await request(`/${board.id}/tasks/STASH-1`, "PATCH", { statusId: progressId }, "guest")).status, 403);
  });

  it("surfaces invalid input, unsupported moves, missing access, and persistence failures", async () => {
    const { database, request } = await run();
    for (const body of [{ name: "", groupBy: "status" }, { name: "Unknown", groupBy: "label" }, { name: "Extra", groupBy: "status", extra: true }]) assert.equal((await request("", "POST", body)).status, 422);
    const priority = (await (await request("", "POST", { name: "Urgency", groupBy: "priority" })).json() as { board: Board }).board;
    assert.equal((await request(`/${priority.id}/tasks/STASH-1`, "PATCH", { statusId: progressId })).status, 409);
    assert.equal((await request(`/${priority.id}/tasks/STASH-1`, "PATCH", { statusId: "bad" })).status, 422);
    assert.equal((await request(`/${priority.id}`, "GET", undefined, "unknown")).status, 401);
    database.fail = true; const failed = await request(); assert.equal(failed.status, 503); assert.doesNotMatch(await failed.text(), /postgres|secret/i);
  });
});
