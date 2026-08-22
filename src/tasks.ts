import { randomUUID } from "node:crypto";
import type { PortableTaskProjection } from "./notes.js";
import type { PortableIdentity } from "./workspaces-projects.js";

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

export class InvalidTaskFromBlockInput extends Error {}

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export class TaskService {
  constructor(private readonly tasks: TaskFromBlockRepository, private readonly actors: TaskActorRepository) {}

  async createFromBlock(memberId: string, noteId: string, blockKey: string, value: unknown): Promise<CreateTaskFromBlockOutcome> {
    if (!uuid.test(noteId) || !uuid.test(blockKey) || value === null || typeof value !== "object" || Array.isArray(value))
      throw new InvalidTaskFromBlockInput();
    const input = value as Record<string, unknown>;
    if (typeof input.projectId !== "string" || !uuid.test(input.projectId) || typeof input.title !== "string"
      || !input.title.trim() || input.title.trim().length > 500
      || !Object.keys(input).every((key) => key === "projectId" || key === "title")) throw new InvalidTaskFromBlockInput();
    const actor = await this.actors.findPortableMemberIdentity(memberId);
    if (!actor) throw new Error("member_identity_unavailable");
    return this.tasks.createTaskFromBlock(memberId, noteId, blockKey, {
      id: randomUUID(), projectId: input.projectId, title: input.title.trim(),
      createdAt: new Date().toISOString(), createdBy: actor,
    });
  }

  async listLinked(memberId: string, noteId: string) {
    if (!uuid.test(noteId)) throw new InvalidTaskFromBlockInput();
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
    return this.tasks.linkTaskToBlock(memberId, taskId, input.noteId, input.blockKey);
  }

  async listSourceBlocks(memberId: string, taskId: string) {
    if (!uuid.test(taskId)) throw new InvalidTaskFromBlockInput();
    return this.tasks.listTaskSourceBlocks(memberId, taskId);
  }
}
