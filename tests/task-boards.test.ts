import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { JSDOM } from "jsdom";

import { BoardService, type Board, type BoardRepository, type BoardTask } from "../src/boards.js";
import { startInstance, type DatabaseProbe, type RunningInstance } from "../src/instance.js";
import type { MemberAccessResolver } from "../src/workspaces-projects.js";

const projectId = "22222222-2222-4222-8222-222222222222";
const backlogId = "33333333-3333-4333-8333-333333333333";
const progressId = "44444444-4444-4444-8444-444444444444";
const doneId = "55555555-5555-4555-8555-555555555555";
const archivedId = "66666666-6666-4666-8666-666666666666";

class BoardFake implements DatabaseProbe, BoardRepository {
  boards: Board[] = [];
  tasks: BoardTask[] = [
    { id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", key: "STASH-1", title: "Shape the board", status: { id: backlogId, name: "Backlog", category: "unstarted" }, assigneeIds: [], priority: "high", labelNames: ["planning"] },
    { id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", key: "STASH-2", title: "Ship the board", status: { id: progressId, name: "In Progress", category: "started" }, assigneeIds: [], priority: "urgent", labelNames: [] },
  ];
  fail = false;
  failNextBoardRead = false;
  moveCalls = 0;
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
    if (this.failNextBoardRead) { this.failNextBoardRead = false; throw new Error("postgres://secret"); }
    return { status: "found" as const, board: structuredClone(board), tasks: structuredClone(this.tasks), statuses: [
      { id: backlogId, name: "Backlog", category: "unstarted" as const, position: 0, archived: false },
      { id: progressId, name: "In Progress", category: "started" as const, position: 1, archived: false },
      { id: doneId, name: "Done", category: "completed" as const, position: 2, archived: false },
      { id: archivedId, name: "Cancelled", category: "completed" as const, position: 3, archived: true },
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
    this.moveCalls += 1; task.status = status; return { status: "moved" as const, task: structuredClone(task) };
  }
}

const access: MemberAccessResolver = { async authenticateBearer(value) {
  if (value === "Bearer member") return { accountId: "ada", sessionId: "member" };
  if (value === "Bearer guest") return { accountId: "grace", sessionId: "guest" };
  return undefined;
} };

async function eventually(assertion: () => void) {
  const deadline = Date.now() + 1_000;
  while (true) {
    try { assertion(); return; }
    catch (error) { if (Date.now() >= deadline) throw error; await new Promise((resolve) => setTimeout(resolve, 5)); }
  }
}

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
    assert.match(surface, /className='visually-hidden'/); assert.match(surface, /htmlFor=select\.id/);
    assert.match(surface, /button\.disabled=true;select\.disabled=true/);
    assert.match(surface, /task\.key\+' moved to '\+destinationName\+'\.'/);
    assert.match(surface, /focusTaskKey:task\.key/); assert.match(surface, /movedCard\?\.focus\(\)/);
    assert.match(surface, /select\.value=column\.id/); assert.match(surface, /select\.focus\(\)/);
    assert.match(surface, /prefers-reduced-motion/); assert.match(surface, /gsap\.from/);
    assert.match(surface, /message\.textContent=options\.announcement\|\|body\.board\.name\+' loaded\.'/);
    assert.doesNotMatch(surface, /if\(!message\.textContent\)/);
    assert.match(surface, /boards\.replaceChildren\(\);current=undefined;columns\.replaceChildren\(\);pendingFocusTaskKey=undefined;message\.dataset\.error='false';/);
    assert.match(surface, /if\(!body\.boards\.length\)\{message\.textContent='No board views exist yet\.';return\}/);
    assert.match(surface, /body\.columns\.filter\(target=>!target\.archived\)/);
    assert.match(surface, /read only destination/);
  });

  it("moves a Task through the keyboard form and preserves an operable recovery path", async () => {
    const { database, request } = await run();
    const board = (await (await request("", "POST", { name: "Delivery", groupBy: "status" })).json() as { board: Board }).board;
    const surface = await (await fetch(`${instance!.url}/boards`)).text();
    const dom = new JSDOM(surface, { runScripts: "outside-only", url: `${instance!.url}/boards` });
    const { window } = dom;
    Object.defineProperties(window, {
      fetch: { value: (input: string, init?: RequestInit) => fetch(new URL(input, window.location.href), init) },
      matchMedia: { value: () => ({ matches: true }) },
      gsap: { value: { from() {} } },
    });
    const moduleScript = [...window.document.scripts].find(({ type }) => type === "module")?.textContent;
    assert.ok(moduleScript); window.eval(moduleScript);
    const token = window.document.querySelector<HTMLInputElement>("#token")!;
    const project = window.document.querySelector<HTMLInputElement>("#project")!;
    token.value = "member"; project.value = projectId;
    window.document.querySelector<HTMLFormElement>("#connect")!.dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true }));
    await eventually(() => assert.equal(window.document.querySelectorAll(".task").length, 2));

    const sourceCard = [...window.document.querySelectorAll<HTMLElement>(".task")].find(({ dataset }) => dataset.taskKey === "STASH-1")!;
    const moveForm = sourceCard.querySelector<HTMLFormElement>("form")!;
    const destination = moveForm.querySelector<HTMLSelectElement>("select")!;
    destination.value = progressId;
    moveForm.dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true }));
    await eventually(() => assert.equal(window.document.querySelector("#message")!.textContent, "STASH-1 moved to In Progress."));
    assert.equal(database.tasks[0]!.status.id, progressId);
    assert.equal((window.document.activeElement as HTMLElement).dataset.taskKey, "STASH-1");

    const movedCard = window.document.activeElement as HTMLElement;
    const retryForm = movedCard.querySelector<HTMLFormElement>("form")!;
    const retrySelect = retryForm.querySelector<HTMLSelectElement>("select")!;
    retrySelect.value = backlogId; database.fail = true;
    retryForm.dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true }));
    await eventually(() => assert.equal(window.document.querySelector("#message")!.getAttribute("data-error"), "true"));
    assert.equal(window.document.querySelector("#message")!.textContent, "The board could not be loaded or saved. Try again.");
    assert.equal(retrySelect.value, progressId); assert.equal(window.document.activeElement, retrySelect);
    assert.equal(database.tasks[0]!.status.id, progressId);
    dom.window.close();
  });

  it("preserves a committed move when its board refresh fails and reconciles without moving twice", async () => {
    const { database, request } = await run();
    await request("", "POST", { name: "Delivery", groupBy: "status" });
    const surface = await (await fetch(`${instance!.url}/boards`)).text();
    const dom = new JSDOM(surface, { runScripts: "outside-only", url: `${instance!.url}/boards` });
    const { window } = dom;
    Object.defineProperties(window, {
      fetch: { value: (input: string, init?: RequestInit) => fetch(new URL(input, window.location.href), init) },
      matchMedia: { value: () => ({ matches: true }) },
      gsap: { value: { from() {} } },
    });
    const moduleScript = [...window.document.scripts].find(({ type }) => type === "module")?.textContent;
    assert.ok(moduleScript); window.eval(moduleScript);
    window.document.querySelector<HTMLInputElement>("#token")!.value = "member";
    window.document.querySelector<HTMLInputElement>("#project")!.value = projectId;
    window.document.querySelector<HTMLFormElement>("#connect")!.dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true }));
    await eventually(() => assert.equal(window.document.querySelectorAll(".task").length, 2));

    const task = [...window.document.querySelectorAll<HTMLElement>(".task")].find(({ dataset }) => dataset.taskKey === "STASH-1")!;
    const form = task.querySelector<HTMLFormElement>("form")!;
    const select = form.querySelector<HTMLSelectElement>("select")!;
    const button = form.querySelector<HTMLButtonElement>("button")!;
    select.value = progressId; database.failNextBoardRead = true;
    form.dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true }));
    await eventually(() => assert.match(window.document.querySelector("#message")!.textContent!, /STASH-1 moved to In Progress.*could not be refreshed/i));
    assert.equal(database.tasks[0]!.status.id, progressId); assert.equal(database.moveCalls, 1);
    assert.equal(select.disabled, true); assert.equal(button.disabled, true); assert.equal(select.value, progressId);
    const refresh = window.document.querySelector<HTMLButtonElement>("#refresh-board")!;
    assert.equal(window.document.activeElement, refresh); assert.equal(refresh.disabled, false);
    button.click();
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(database.moveCalls, 1);

    refresh.click();
    await eventually(() => assert.equal(window.document.querySelector("#message")!.textContent, "Delivery loaded."));
    assert.equal(database.moveCalls, 1); assert.equal((window.document.activeElement as HTMLElement).dataset.taskKey, "STASH-1");
    const progressColumn = [...window.document.querySelectorAll<HTMLElement>(".column")].find((column) => column.querySelector("h2")?.textContent?.startsWith("In Progress"));
    assert.equal(progressColumn?.querySelector<HTMLElement>(".task")?.dataset.taskKey, "STASH-1");
    dom.window.close();
  });

  it("keeps Tasks in an occupied archived status visible without offering that status as a destination", async () => {
    const { database, request } = await run();
    database.tasks.push({ id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc", key: "STASH-3", title: "Cancelled work",
      status: { id: archivedId, name: "Cancelled", category: "completed" }, assigneeIds: [], priority: "none", labelNames: [] });
    const board = (await (await request("", "POST", { name: "Delivery", groupBy: "status" })).json() as { board: Board }).board;
    const body = await (await request(`/${board.id}`)).json() as any;
    const archived = body.columns.find((column: any) => column.id === archivedId);
    assert.equal(archived.name, "Cancelled (archived)"); assert.equal(archived.archived, true);
    assert.deepEqual(archived.tasks.map((task: BoardTask) => task.key), ["STASH-3"]);
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
