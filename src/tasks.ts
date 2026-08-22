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

export type CreateTaskFromBlockOutcome =
  | { status: "created"; task: PortableTaskProjection; blockId: string }
  | { status: "note_not_found" | "block_not_found" | "project_forbidden" };

export interface TaskFromBlockRepository {
  createTaskFromBlock(memberId: string, noteId: string, blockKey: string, draft: CreateTaskFromBlockDraft): Promise<CreateTaskFromBlockOutcome>;
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
}
