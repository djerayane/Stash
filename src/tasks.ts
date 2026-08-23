import { createHash, randomUUID } from "node:crypto";
import type { PortableTaskProjection } from "./notes.js";
import type { PortableIdentity } from "./workspaces-projects.js";
import type { ActivityCause } from "./activity.js";

export interface CreateTaskFromBlockDraft {
  id: string;
  projectId: string;
  title: string;
  createdAt: string;
  createdBy: PortableIdentity;
}

export interface TaskSourceBlockReference { noteId: string; blockId: string }
export interface LinkedTaskReadModel {
  id: string; key: string; title: string;
  status: PortableTaskProjection["status"];
  sourceBlock: TaskSourceBlockReference;
  relationshipState: "linked" | "broken" | "ambiguous";
}
export interface TaskSourceBlockReadModel extends TaskSourceBlockReference {
  state: "linked" | "broken" | "ambiguous";
}

export interface TaskDependencyWarning {
  code: "incomplete_dependency";
  taskId: string;
}

export type TaskPlanningReadModel = PortableTaskProjection & { revision: number; dependencyWarnings: TaskDependencyWarning[] };

export interface TaskMoveActivity {
  schema: "stash.activity.v1";
  id: string;
  workspaceId: string;
  action: "task_moved";
  object: { kind: "Task"; id: string };
  actor: PortableIdentity;
  cause: { kind: "member" };
  occurredAt: string;
  before: { projectId: string; key: string; status: PortableTaskProjection["status"] };
  after: { projectId: string; key: string; status: PortableTaskProjection["status"] };
}

export interface TaskMoveRepository {
  moveTask(memberId: string, projectId: string, taskKey: string, destinationProjectId: string): Promise<
    | { status: "moved"; task: TaskPlanningReadModel; activity: TaskMoveActivity }
    | { status: "not_found" | "destination_forbidden" | "same_project" }
  >;
}

export type CreateTaskFromBlockOutcome =
  | { status: "created"; task: PortableTaskProjection; sourceBlock: TaskSourceBlockReference }
  | { status: "note_not_found" | "block_not_found" | "project_forbidden" | "ambiguous_block" };

export interface TaskFromBlockRepository {
  createTaskFromBlock(memberId: string, noteId: string, blockKey: string, draft: CreateTaskFromBlockDraft): Promise<CreateTaskFromBlockOutcome>;
  listLinkedTasks(memberId: string, noteId: string): Promise<{ status: "found"; tasks: LinkedTaskReadModel[] } | { status: "note_not_found" }>;
  linkTaskToBlock(memberId: string, taskId: string, noteId: string, blockKey: string): Promise<
    | { status: "linked" | "already_linked"; task: PortableTaskProjection; sourceBlock: TaskSourceBlockReference }
    | { status: "task_not_found" | "note_not_found" | "block_not_found" | "ambiguous_block" }
  >;
  listTaskSourceBlocks(memberId: string, taskId: string): Promise<
    { status: "found"; sourceBlocks: TaskSourceBlockReadModel[] } | { status: "task_not_found" }
  >;
}

export interface TaskActorRepository {
  findPortableMemberIdentity(memberId: string): Promise<PortableIdentity | undefined>;
}

export type TaskPlanningUpdate = Partial<Pick<PortableTaskProjection,
  "title" | "assigneeIds" | "priority" | "labelNames" | "linkedNoteIds" | "dependencies" | "developmentLinks">>
  & { statusId?: string; dueDate?: string | null; estimate?: number | null };

export interface TaskPlanningRepository {
  findTaskByKey(memberId: string, projectId: string, taskKey: string): Promise<
    { status: "found"; task: TaskPlanningReadModel } | { status: "not_found" }
  >;
  updateTaskByKey(memberId: string, projectId: string, taskKey: string, update: TaskPlanningUpdate, cause?: ActivityCause): Promise<
    { status: "updated"; task: TaskPlanningReadModel } | { status: "not_found" | "invalid_reference" }
  >;
}

export interface TaskEditBatch { operationId: string; baseRevision: number; changes: TaskPlanningUpdate; createdAt: string; createdBy: PortableIdentity; cause?: ActivityCause }
export interface TaskEditConflict {
  id: string; taskId: string; baseRevision: number; currentRevision: number; fields: string[]; contribution: TaskPlanningUpdate;
  createdAt: string; createdBy: { displayName: string; attribution: "recorded" };
  resolvedAt?: string; resolution?: "keep_current" | "apply_contribution";
}
export type StructuredTaskEditOutcome =
  | { status: "applied"; task: TaskPlanningReadModel; revision: number; appliedFields: string[] }
  | { status: "conflict_preserved"; conflict: TaskEditConflict }
  | { status: "not_found" | "invalid_reference" | "invalid_revision" | "operation_identity_conflict" };
export interface StructuredTaskEditRepository {
  applyStructuredTaskEdit(memberId: string, projectId: string, taskKey: string, batch: TaskEditBatch): Promise<StructuredTaskEditOutcome>;
  listStructuredTaskConflicts(memberId: string, projectId: string, taskKey: string): Promise<
    { status: "found"; revision: number; conflicts: TaskEditConflict[] } | { status: "not_found" }>;
  resolveStructuredTaskConflict(memberId: string, projectId: string, taskKey: string, conflictId: string,
    resolution: "keep_current" | "apply_contribution", expectedRevision: number, operationId?: string): Promise<
      | { status: "resolved"; task: TaskPlanningReadModel; revision: number; activity: unknown }
      | { status: "conflict_changed"; conflict: TaskEditConflict }
      | { status: "not_found" | "conflict_not_found" | "already_resolved" | "invalid_reference" }>;
}
export function taskEditDigest(batch: TaskEditBatch): string {
  return createHash("sha256").update(JSON.stringify({ operationId: batch.operationId, baseRevision: batch.baseRevision,
    changes: Object.fromEntries(Object.entries(batch.changes).sort(([left], [right]) => left.localeCompare(right))) })).digest("hex");
}

export class InvalidTaskFromBlockInput extends Error {}

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export class TaskService {
  constructor(private readonly tasks: Partial<TaskFromBlockRepository & TaskPlanningRepository & TaskMoveRepository & StructuredTaskEditRepository>, private readonly actors: TaskActorRepository) {}

  async createFromBlock(memberId: string, noteId: string, blockKey: string, value: unknown): Promise<CreateTaskFromBlockOutcome> {
    if (!uuid.test(noteId) || !uuid.test(blockKey) || value === null || typeof value !== "object" || Array.isArray(value))
      throw new InvalidTaskFromBlockInput();
    const input = value as Record<string, unknown>;
    if (typeof input.projectId !== "string" || !uuid.test(input.projectId) || typeof input.title !== "string"
      || !input.title.trim() || input.title.trim().length > 500
      || !Object.keys(input).every((key) => key === "projectId" || key === "title")) throw new InvalidTaskFromBlockInput();
    const actor = await this.actors.findPortableMemberIdentity(memberId);
    if (!actor) throw new Error("member_identity_unavailable");
    if (!this.tasks.createTaskFromBlock) throw new Error("task_creation_unavailable");
    return this.tasks.createTaskFromBlock(memberId, noteId, blockKey, {
      id: randomUUID(), projectId: input.projectId, title: input.title.trim(),
      createdAt: new Date().toISOString(), createdBy: actor,
    });
  }

  async listLinked(memberId: string, noteId: string) {
    if (!uuid.test(noteId)) throw new InvalidTaskFromBlockInput();
    if (!this.tasks.listLinkedTasks) throw new Error("task_read_unavailable");
    return this.tasks.listLinkedTasks(memberId, noteId);
  }

  async linkBlock(memberId: string, taskId: string, value: unknown) {
    if (!uuid.test(taskId) || value === null || typeof value !== "object" || Array.isArray(value))
      throw new InvalidTaskFromBlockInput();
    const input = value as Record<string, unknown>;
    if (typeof input.noteId !== "string" || !uuid.test(input.noteId)
      || typeof input.blockKey !== "string" || !uuid.test(input.blockKey)
      || !Object.keys(input).every((key) => key === "noteId" || key === "blockKey"))
      throw new InvalidTaskFromBlockInput();
    if (!this.tasks.linkTaskToBlock) throw new Error("task_link_unavailable");
    return this.tasks.linkTaskToBlock(memberId, taskId, input.noteId, input.blockKey);
  }

  async listSourceBlocks(memberId: string, taskId: string) {
    if (!uuid.test(taskId)) throw new InvalidTaskFromBlockInput();
    if (!this.tasks.listTaskSourceBlocks) throw new Error("task_read_unavailable");
    return this.tasks.listTaskSourceBlocks(memberId, taskId);
  }
  async findByKey(memberId: string, projectId: string, taskKey: string) {
    if (!uuid.test(projectId) || !isTaskKey(taskKey) || !this.tasks.findTaskByKey) throw new InvalidTaskFromBlockInput();
    return this.tasks.findTaskByKey(memberId, projectId, taskKey.toUpperCase());
  }

  async updateByKey(memberId: string, projectId: string, taskKey: string, value: unknown, cause?: ActivityCause) {
    if (!uuid.test(projectId) || !isTaskKey(taskKey) || !this.tasks.updateTaskByKey || !isPlanningUpdate(value))
      throw new InvalidTaskFromBlockInput();
    const update = normalizePlanningUpdate(value as TaskPlanningUpdate);
    return this.tasks.updateTaskByKey(memberId, projectId, taskKey.toUpperCase(), update, cause);
  }

  async move(memberId: string, projectId: string, taskKey: string, value: unknown) {
    if (!uuid.test(projectId) || !isTaskKey(taskKey) || !this.tasks.moveTask || !isPlainObject(value)
      || typeof value.destinationProjectId !== "string" || !uuid.test(value.destinationProjectId)
      || Object.keys(value).some((key) => key !== "destinationProjectId")) throw new InvalidTaskFromBlockInput();
    return this.tasks.moveTask(memberId, projectId, taskKey.toUpperCase(), value.destinationProjectId);
  }

  async applyStructuredEdit(memberId: string, projectId: string, taskKey: string, value: unknown) {
    if (!uuid.test(projectId) || !isTaskKey(taskKey) || !this.tasks.applyStructuredTaskEdit || !isPlainObject(value)
      || typeof value.operationId !== "string" || !uuid.test(value.operationId)
      || !Number.isSafeInteger(value.baseRevision) || (value.baseRevision as number) < 1 || !isPlanningUpdate(value.changes)
      || Object.keys(value).some((key) => !["operationId", "baseRevision", "changes"].includes(key))) throw new InvalidTaskFromBlockInput();
    const actor = await this.actors.findPortableMemberIdentity(memberId);
    if (!actor) throw new Error("member_identity_unavailable");
    return this.tasks.applyStructuredTaskEdit(memberId, projectId, taskKey.toUpperCase(), { operationId: value.operationId,
      baseRevision: value.baseRevision as number, changes: normalizePlanningUpdate(value.changes as TaskPlanningUpdate),
      createdAt: new Date().toISOString(), createdBy: actor });
  }
  async applyProposedEdit(memberId: string, projectId: string, taskKey: string, operationId: string, baseRevision: number,
    changes: unknown, cause: ActivityCause) {
    if (!uuid.test(projectId) || !isTaskKey(taskKey) || !uuid.test(operationId) || !Number.isSafeInteger(baseRevision) || baseRevision < 1
      || !this.tasks.applyStructuredTaskEdit || !isPlanningUpdate(changes)) throw new InvalidTaskFromBlockInput();
    const actor = await this.actors.findPortableMemberIdentity(memberId); if (!actor) throw new Error("member_identity_unavailable");
    return this.tasks.applyStructuredTaskEdit(memberId, projectId, taskKey.toUpperCase(), { operationId, baseRevision,
      changes: normalizePlanningUpdate(changes as TaskPlanningUpdate), createdAt: new Date().toISOString(), createdBy: actor, cause });
  }

  async listStructuredConflicts(memberId: string, projectId: string, taskKey: string) {
    if (!uuid.test(projectId) || !isTaskKey(taskKey) || !this.tasks.listStructuredTaskConflicts) throw new InvalidTaskFromBlockInput();
    return this.tasks.listStructuredTaskConflicts(memberId, projectId, taskKey.toUpperCase());
  }

  async resolveStructuredConflict(memberId: string, projectId: string, taskKey: string, conflictId: string, value: unknown) {
    if (!uuid.test(projectId) || !isTaskKey(taskKey) || !uuid.test(conflictId) || !this.tasks.resolveStructuredTaskConflict
      || !isPlainObject(value) || !["keep_current", "apply_contribution"].includes(value.resolution as string)
      || !Number.isSafeInteger(value.expectedRevision) || (value.expectedRevision as number) < 0
      || value.operationId !== undefined && (typeof value.operationId !== "string" || !uuid.test(value.operationId))
      || Object.keys(value).some((key) => !["resolution", "expectedRevision", "operationId"].includes(key))) throw new InvalidTaskFromBlockInput();
    return this.tasks.resolveStructuredTaskConflict(memberId, projectId, taskKey.toUpperCase(), conflictId,
      value.resolution as "keep_current" | "apply_contribution", value.expectedRevision as number, value.operationId as string | undefined);
  }
}

function normalizePlanningUpdate(value: TaskPlanningUpdate): TaskPlanningUpdate {
  const update = { ...value };
  if (typeof update.title === "string") update.title = update.title.trim();
  if (update.assigneeIds) update.assigneeIds = [...new Set(update.assigneeIds)];
  if (update.labelNames) update.labelNames = [...new Set(update.labelNames.map((label) => label.trim()))];
  if (update.linkedNoteIds) update.linkedNoteIds = [...new Set(update.linkedNoteIds)];
  return update;
}

function isTaskKey(value: string): boolean { return /^[A-Za-z][A-Za-z0-9-]{1,19}-[1-9][0-9]*$/.test(value); }
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
export function isPlanningUpdate(value: unknown): value is TaskPlanningUpdate {
  if (!isPlainObject(value) || Object.keys(value).length === 0) return false;
  const allowed = ["title", "statusId", "assigneeIds", "priority", "labelNames", "dueDate", "estimate", "linkedNoteIds", "dependencies", "developmentLinks"];
  if (!Object.keys(value).every((key) => allowed.includes(key))) return false;
  if (value.title !== undefined && (typeof value.title !== "string" || !value.title.trim() || value.title.trim().length > 500)) return false;
  if (value.statusId !== undefined && (typeof value.statusId !== "string" || !uuid.test(value.statusId))) return false;
  for (const key of ["assigneeIds", "linkedNoteIds"] as const) {
    const ids = value[key];
    if (ids !== undefined && (!Array.isArray(ids) || ids.length > 100 || ids.some((id) => typeof id !== "string" || !uuid.test(id)))) return false;
  }
  if (value.priority !== undefined && !["none", "low", "medium", "high", "urgent"].includes(value.priority as string)) return false;
  if (value.labelNames !== undefined && (!Array.isArray(value.labelNames) || value.labelNames.length > 100
    || value.labelNames.some((label) => typeof label !== "string" || !label.trim() || label.trim().length > 100))) return false;
  if (value.dueDate !== undefined && value.dueDate !== null && (typeof value.dueDate !== "string" || !isCalendarDate(value.dueDate))) return false;
  if (value.estimate !== undefined && value.estimate !== null && (typeof value.estimate !== "number" || !Number.isFinite(value.estimate)
    || value.estimate < 0 || value.estimate > 1_000_000)) return false;
  if (value.dependencies !== undefined && (!Array.isArray(value.dependencies) || value.dependencies.length > 100
    || value.dependencies.some((dependency) => !isPlainObject(dependency) || typeof dependency.taskId !== "string" || !uuid.test(dependency.taskId)
      || !["depends_on", "required_by"].includes(dependency.type as string) || Object.keys(dependency).some((key) => !["taskId", "type"].includes(key))))) return false;
  if (value.developmentLinks !== undefined && (!Array.isArray(value.developmentLinks) || value.developmentLinks.length > 100
    || value.developmentLinks.some((link) => !isPlainObject(link) || typeof link.provider !== "string" || !link.provider.trim()
      || typeof link.url !== "string" || !isHttpUrl(link.url) || !["branch", "commit", "pull_request"].includes(link.kind as string)
      || Object.keys(link).some((key) => !["provider", "url", "kind"].includes(key))))) return false;
  return true;
}
function isHttpUrl(value: string): boolean {
  try { const url = new URL(value); return url.protocol === "https:" || url.protocol === "http:"; } catch { return false; }
}
function isCalendarDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split("-").map(Number) as [number, number, number];
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}
