import { randomUUID } from "node:crypto";
import type { WorkflowStatus } from "./project-workflows.js";

export type BoardGrouping = "status" | "priority";
export interface Board { schema: "stash.board.v1"; id: string; projectId: string; name: string; groupBy: BoardGrouping; createdAt: string }
export interface BoardTask { id: string; key: string; title: string; status: Pick<WorkflowStatus, "id" | "name" | "category">; assigneeIds: string[]; priority: "none" | "low" | "medium" | "high" | "urgent"; labelNames: string[] }
export interface BoardColumn { id: string; name: string; tasks: BoardTask[] }
export interface BoardRepository {
  listBoards(memberId: string, projectId: string): Promise<{ status: "found"; boards: Board[] } | { status: "not_found" }>;
  createBoard(memberId: string, board: Board): Promise<{ status: "created"; board: Board } | { status: "forbidden" | "not_found" }>;
  readBoard(memberId: string, projectId: string, boardId: string): Promise<{ status: "found"; board: Board; tasks: BoardTask[]; statuses: WorkflowStatus[] } | { status: "not_found" }>;
  moveTaskOnBoard(memberId: string, projectId: string, boardId: string, taskKey: string, statusId: string): Promise<{ status: "moved"; task: BoardTask } | { status: "forbidden" | "not_found" | "invalid_status" | "unsupported_group" }>;
}
export class InvalidBoardInput extends Error {}
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const taskKey = /^[A-Za-z][A-Za-z0-9-]{1,19}-[1-9][0-9]*$/;

export class BoardService {
  constructor(private readonly boards: BoardRepository) {}
  async list(memberId: string, projectId: string) { this.project(projectId); return this.boards.listBoards(memberId, projectId); }
  async create(memberId: string, projectId: string, value: unknown) {
    this.project(projectId); if (!plain(value) || Object.keys(value).length !== 2 || typeof value.name !== "string" || !value.name.trim() || value.name.trim().length > 100 || !["status", "priority"].includes(value.groupBy as string)) throw new InvalidBoardInput();
    return this.boards.createBoard(memberId, { schema: "stash.board.v1", id: randomUUID(), projectId, name: value.name.trim(), groupBy: value.groupBy as BoardGrouping, createdAt: new Date().toISOString() });
  }
  async read(memberId: string, projectId: string, boardId: string) {
    this.project(projectId); if (!uuid.test(boardId)) throw new InvalidBoardInput();
    const result = await this.boards.readBoard(memberId, projectId, boardId); if (result.status !== "found") return result;
    return { status: "found" as const, board: result.board, columns: columns(result.board, result.tasks, result.statuses) };
  }
  async move(memberId: string, projectId: string, boardId: string, key: string, value: unknown) {
    this.project(projectId); if (!uuid.test(boardId) || !taskKey.test(key) || !plain(value) || Object.keys(value).length !== 1 || typeof value.statusId !== "string" || !uuid.test(value.statusId)) throw new InvalidBoardInput();
    return this.boards.moveTaskOnBoard(memberId, projectId, boardId, key.toUpperCase(), value.statusId);
  }
  private project(projectId: string) { if (!uuid.test(projectId)) throw new InvalidBoardInput(); }
}
function plain(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === "object" && !Array.isArray(value); }
function columns(board: Board, tasks: BoardTask[], statuses: WorkflowStatus[]): BoardColumn[] {
  if (board.groupBy === "status") return statuses.filter(({ archived }) => !archived).sort((a,b) => a.position-b.position).map((status) => ({ id: status.id, name: status.name, tasks: tasks.filter((task) => task.status.id === status.id) }));
  const priorities = ["none", "low", "medium", "high", "urgent"] as const;
  return priorities.map((priority) => ({ id: priority, name: priority[0]!.toUpperCase() + priority.slice(1), tasks: tasks.filter((task) => task.priority === priority) }));
}
