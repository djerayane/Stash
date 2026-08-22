import { randomUUID } from "node:crypto";
import { normalizeExplicitOffsetTimestamp } from "./explicit-offset-timestamp.js";
import type { PortableIdentity } from "./workspaces-projects.js";

export interface NoteReminder {
  at: string;
}

export interface NoteRecord {
  id: string;
  workspaceId: string;
  content: string;
  tags: string[];
  createdByMemberId: string;
  createdAt: string;
  projectId?: string;
  reminder?: NoteReminder;
}

export interface PortableNoteProjection {
  schema: "stash.note.v1";
  id: string;
  workspaceId: string;
  content: string;
  tags: string[];
  createdAt: string;
  createdBy: PortableIdentity;
  projectId?: string;
  reminder?: NoteReminder;
}

export interface NoteRepository {
  findPortableMemberIdentity(memberId: string): Promise<PortableIdentity | undefined>;
  createNote(
    memberId: string,
    note: NoteRecord,
    projection: PortableNoteProjection,
  ): Promise<"created" | "workspace_forbidden" | "project_forbidden">;
}

export class InvalidNoteInput extends Error {}

interface NoteInput {
  content: string;
  projectId?: string;
  tags?: string[];
  reminder?: NoteReminder;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function isNoteInput(value: unknown): value is NoteInput {
  if (!isPlainObject(value) || typeof value.content !== "string" || value.content.trim().length === 0) {
    return false;
  }
  if (value.projectId !== undefined && (typeof value.projectId !== "string" || !isUuid(value.projectId))) {
    return false;
  }
  if (value.tags !== undefined && (!Array.isArray(value.tags)
    || value.tags.length > 50
    || value.tags.some((tag) => typeof tag !== "string" || tag.trim().length === 0 || tag.trim().length > 100))) {
    return false;
  }
  if (value.reminder !== undefined) {
    if (!isPlainObject(value.reminder)
      || Object.keys(value.reminder).length !== 1
      || typeof value.reminder.at !== "string"
      || normalizeExplicitOffsetTimestamp(value.reminder.at) === undefined) return false;
  }
  return Object.keys(value).every((key) => ["content", "projectId", "tags", "reminder"].includes(key));
}

export class NoteService {
  readonly #repository: NoteRepository;

  constructor(repository: NoteRepository) {
    this.#repository = repository;
  }

  async capture(memberId: string, workspaceId: string, value: unknown): Promise<
    | { status: "created"; note: NoteRecord; projection: PortableNoteProjection }
    | { status: "workspace_forbidden" | "project_forbidden" }
  > {
    if (!isUuid(workspaceId) || !isNoteInput(value)) throw new InvalidNoteInput();
    const createdBy = await this.#repository.findPortableMemberIdentity(memberId);
    if (!createdBy) throw new Error("member_identity_unavailable");
    const tags = [...new Set((value.tags ?? []).map((tag) => tag.trim()))];
    const note: NoteRecord = {
      id: randomUUID(),
      workspaceId,
      content: value.content,
      tags,
      createdByMemberId: memberId,
      createdAt: new Date().toISOString(),
      ...(value.projectId ? { projectId: value.projectId } : {}),
      ...(value.reminder ? { reminder: { at: normalizeExplicitOffsetTimestamp(value.reminder.at)! } } : {}),
    };
    const projection: PortableNoteProjection = {
      schema: "stash.note.v1",
      id: note.id,
      workspaceId: note.workspaceId,
      content: note.content,
      tags: note.tags,
      createdAt: note.createdAt,
      createdBy,
      ...(note.projectId ? { projectId: note.projectId } : {}),
      ...(note.reminder ? { reminder: note.reminder } : {}),
    };
    const status = await this.#repository.createNote(memberId, note, projection);
    return status === "created" ? { status, note, projection } : { status };
  }
}
