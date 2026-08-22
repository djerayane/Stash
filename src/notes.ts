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
  archivedAt?: string;
}

export interface PortableNoteStateProjection {
  schema: "stash.note.v2";
  note: Omit<NoteRecord, "createdByMemberId">;
  createdBy: PortableIdentity;
}

export interface PortableNoteLinkProjection {
  schema: "stash.note-link.v1"; id: string; workspaceId: string; sourceNoteId: string; targetNoteId: string;
}

export interface PortableTaskProjection {
  schema: "stash.task.v1"; id: string; workspaceId: string; projectId: string; title: string;
  sourceNoteIds: string[]; createdAt: string; createdBy: PortableIdentity;
}

export type NoteTriageResult =
  | { kind: "organized"; note: NoteRecord; projections: [PortableNoteStateProjection] }
  | { kind: "archived"; note: NoteRecord; projections: [PortableNoteStateProjection] }
  | { kind: "linked"; link: PortableNoteLinkProjection; projections: [PortableNoteLinkProjection] }
  | { kind: "task_created"; task: PortableTaskProjection; projections: [PortableTaskProjection] };

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
  listInboxNotes(memberId: string, workspaceId: string): Promise<
    { status: "found"; notes: NoteRecord[] } | { status: "workspace_forbidden" }
  >;
  triageNote(memberId: string, workspaceId: string, noteId: string, change: NoteTriageResult): Promise<
    "updated" | "workspace_forbidden" | "project_forbidden" | "note_not_found" | "target_note_not_found"
  >;
}

export class InvalidNoteInput extends Error {}
export class InvalidNoteTriageInput extends Error {}

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

  async listInbox(memberId: string, workspaceId: string) {
    if (!isUuid(workspaceId)) throw new InvalidNoteTriageInput();
    return this.#repository.listInboxNotes(memberId, workspaceId);
  }

  async triage(memberId: string, workspaceId: string, noteId: string, value: unknown): Promise<
    { status: "updated"; result: NoteTriageResult } | { status: "workspace_forbidden" | "project_forbidden" | "note_not_found" | "target_note_not_found" }
  > {
    if (!isUuid(workspaceId) || !isUuid(noteId) || !isPlainObject(value) || typeof value.action !== "string") {
      throw new InvalidNoteTriageInput();
    }
    const createdBy = await this.#repository.findPortableMemberIdentity(memberId);
    if (!createdBy) throw new Error("member_identity_unavailable");
    const now = new Date().toISOString();
    let result: NoteTriageResult;
    if (value.action === "organize") {
      if (typeof value.projectId !== "string" || !isUuid(value.projectId)
        || value.tags !== undefined && (!Array.isArray(value.tags) || value.tags.length > 50
          || value.tags.some((tag) => typeof tag !== "string" || !tag.trim() || tag.trim().length > 100))) {
        throw new InvalidNoteTriageInput();
      }
      const existing = await this.#repository.listInboxNotes(memberId, workspaceId);
      const note = existing.status === "found" ? existing.notes.find(({ id }) => id === noteId) : undefined;
      if (!note) return { status: existing.status === "workspace_forbidden" ? existing.status : "note_not_found" };
      const organized = { ...note, projectId: value.projectId, tags: [...new Set((value.tags as string[] | undefined ?? note.tags).map((tag) => tag.trim()))] };
      result = { kind: "organized", note: organized, projections: [{ schema: "stash.note.v2", note: publicNote(organized), createdBy }] };
    } else if (value.action === "archive" && Object.keys(value).length === 1) {
      const existing = await this.#repository.listInboxNotes(memberId, workspaceId);
      const note = existing.status === "found" ? existing.notes.find(({ id }) => id === noteId) : undefined;
      if (!note) return { status: existing.status === "workspace_forbidden" ? existing.status : "note_not_found" };
      const archived = { ...note, archivedAt: now };
      result = { kind: "archived", note: archived, projections: [{ schema: "stash.note.v2", note: publicNote(archived), createdBy }] };
    } else if (value.action === "link" && typeof value.targetNoteId === "string" && isUuid(value.targetNoteId)
      && value.targetNoteId !== noteId && Object.keys(value).length === 2) {
      const link = { schema: "stash.note-link.v1" as const, id: randomUUID(), workspaceId, sourceNoteId: noteId, targetNoteId: value.targetNoteId };
      result = { kind: "linked", link, projections: [link] };
    } else if (value.action === "create_task" && typeof value.projectId === "string" && isUuid(value.projectId)
      && typeof value.title === "string" && value.title.trim().length > 0 && value.title.trim().length <= 500 && Object.keys(value).every((key) => ["action", "projectId", "title"].includes(key))) {
      const task = { schema: "stash.task.v1" as const, id: randomUUID(), workspaceId, projectId: value.projectId,
        title: value.title.trim(), sourceNoteIds: [noteId], createdAt: now, createdBy };
      result = { kind: "task_created", task, projections: [task] };
    } else throw new InvalidNoteTriageInput();
    const status = await this.#repository.triageNote(memberId, workspaceId, noteId, result);
    return status === "updated" ? { status, result } : { status };
  }
}

function publicNote(note: NoteRecord): Omit<NoteRecord, "createdByMemberId"> {
  const { createdByMemberId: _, ...visible } = note;
  return visible;
}
