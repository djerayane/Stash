import { createHash, randomUUID } from "node:crypto";
import { normalizeExplicitOffsetTimestamp } from "./explicit-offset-timestamp.js";
import type { PortableIdentity } from "./workspaces-projects.js";
import { isRichTextDocument, paragraphDocument, type RichTextBlock, type RichTextDocument } from "./rich-text.js";
import type { TaskSourceBlockReference } from "./tasks.js";

export interface NoteReminder {
  at: string;
}

export interface NoteRecord {
  id: string;
  workspaceId: string;
  content: string;
  document: RichTextDocument;
  revision: number;
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
  key: string; status: { id: string; name: string; category: "unstarted" | "started" | "completed" };
  keyAliases?: Array<{ projectId: string; key: string }>;
  sourceNoteIds: string[]; createdAt: string; createdBy: PortableIdentity;
  sourceBlocks?: TaskSourceBlockReference[];
  assigneeIds?: string[];
  priority?: "none" | "low" | "medium" | "high" | "urgent";
  labelNames?: string[];
  dueDate?: string;
  estimate?: number;
  linkedNoteIds?: string[];
  dependencies?: Array<{ taskId: string; type: "depends_on" | "required_by" }>;
  developmentLinks?: Array<{ provider: string; url: string; kind: "branch" | "commit" | "pull_request" }>;
}

export type TaskCreation = Omit<PortableTaskProjection, "schema" | "key" | "status">;

export type NoteTriageResult =
  | { kind: "organized"; note: NoteRecord; projections: [PortableNoteStateProjection] }
  | { kind: "archived"; note: NoteRecord; projections: [PortableNoteStateProjection] }
  | { kind: "linked"; link: PortableNoteLinkProjection; projections: [PortableNoteLinkProjection] }
  | { kind: "task_created"; task: PortableTaskProjection; projections: [PortableTaskProjection] };

export type NoteTriageChange = Exclude<NoteTriageResult, { kind: "task_created" }>
  | { kind: "task_created"; task: TaskCreation; projections: [] };

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

export type NoteEditOperation =
  | { id: string; type: "replace_block"; blockKey: string; block: RichTextBlock }
  | { id: string; type: "insert_block"; blockKey: string; afterBlockKey: string | null; block: RichTextBlock }
  | { id: string; type: "delete_block"; blockKey: string };
export interface NoteEditBatch { baseRevision: number; operations: NoteEditOperation[] }
export interface NoteEditConflict {
  id: string;
  noteId: string;
  baseRevision: number;
  preservedDocument: RichTextDocument;
  preservedMarkdown: string;
  operations: NoteEditOperation[];
  kind: "concurrent_edit" | "invalid_operation_id";
  currentRevision: number;
  createdBy: { displayName: string; attribution: "recorded" };
  createdAt: string;
  resolvedAt?: string;
  resolution?: NoteConflictResolution;
}
export type NoteConflictResolution = "keep_current" | "apply_contribution";
function canonicalJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalJson);
  if (value !== null && typeof value === "object") return Object.fromEntries(Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right)).map(([key, nested]) => [key, canonicalJson(nested)]));
  return value;
}
export function noteOperationDigest(operation: NoteEditOperation): string {
  const canonical = operation.type === "delete_block" ? { type: operation.type, blockKey: operation.blockKey }
    : operation.type === "insert_block" ? { type: operation.type, blockKey: operation.blockKey, afterBlockKey: operation.afterBlockKey, block: operation.block }
      : { type: operation.type, blockKey: operation.blockKey, block: operation.block };
  return createHash("sha256").update(JSON.stringify(canonicalJson(canonical))).digest("hex");
}
export type NoteEditOutcome = { status: "updated" | "duplicate"; note: NoteRecord; projection: PortableNoteProjection }
  | { status: "conflict_preserved"; conflictId?: string }
  | { status: "not_found" | "invalid_reference" };
export type NoteConflictResolutionOutcome = { status: "resolved"; note: NoteRecord; projection: PortableNoteProjection }
  | { status: "conflict_changed"; conflict: NoteEditConflict }
  | { status: "not_found" | "conflict_not_found" | "already_resolved" | "invalid_reference" | "invalid_operation_identity" };

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
  triageNote(memberId: string, workspaceId: string, noteId: string, change: NoteTriageChange): Promise<
    { status: "updated"; result: NoteTriageResult }
    | { status: "workspace_forbidden" | "project_forbidden" | "note_not_found" | "target_note_not_found" }
  >;
  findNoteForMember(memberId: string, noteId: string): Promise<NoteRecord | undefined>;
  applyNoteOperations(memberId: string, noteId: string, batch: NoteEditBatch): Promise<NoteEditOutcome>;
  listNoteEditConflicts(memberId: string, noteId: string): Promise<
    { status: "found"; conflicts: NoteEditConflict[] } | { status: "not_found" }
  >;
  resolveNoteEditConflict(memberId: string, noteId: string, conflictId: string, resolution: NoteConflictResolution, expectedRevision: number): Promise<NoteConflictResolutionOutcome>;
}

export class InvalidNoteInput extends Error {}
export class InvalidNoteEdit extends Error {}
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

  async get(memberId: string, noteId: string): Promise<NoteRecord | undefined> {
    if (!isUuid(noteId)) throw new InvalidNoteEdit();
    return this.#repository.findNoteForMember(memberId, noteId);
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
      document: paragraphDocument(value.content, randomUUID()),
      revision: 1,
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
    const variant = triageVariants[value.action];
    if (!variant) throw new InvalidNoteTriageInput();
    const prepared = await variant.prepare({ repository: this.#repository, memberId, workspaceId, noteId, actor: createdBy }, value);
    if ("status" in prepared) return prepared;
    const change = prepared.change;
    return this.#repository.triageNote(memberId, workspaceId, noteId, change);
  }

  async edit(memberId: string, noteId: string, value: unknown): Promise<NoteEditOutcome> {
    if (!isUuid(noteId) || !isPlainObject(value) || !Number.isSafeInteger(value.baseRevision)
      || (value.baseRevision as number) < 1 || !Array.isArray(value.operations) || value.operations.length < 1
      || !Object.keys(value).every((key) => ["baseRevision", "operations"].includes(key))) throw new InvalidNoteEdit();
    const operations: NoteEditOperation[] = [];
    for (const operation of value.operations) {
      if (!isPlainObject(operation) || typeof operation.id !== "string" || !isUuid(operation.id)
        || typeof operation.blockKey !== "string" || !isUuid(operation.blockKey)) throw new InvalidNoteEdit();
      if (operation.type === "delete_block") {
        if (!Object.keys(operation).every((key) => ["id", "type", "blockKey"].includes(key))) throw new InvalidNoteEdit();
      } else if ((operation.type === "replace_block" || operation.type === "insert_block")
        && isRichTextDocument({ type: "doc", blocks: [operation.block] })
        && (operation.block as RichTextBlock).blockKey === operation.blockKey) {
        if (operation.type === "insert_block" && (operation.afterBlockKey !== null
          && (typeof operation.afterBlockKey !== "string" || !isUuid(operation.afterBlockKey)))) throw new InvalidNoteEdit();
        const allowed = operation.type === "insert_block" ? ["id", "type", "blockKey", "afterBlockKey", "block"] : ["id", "type", "blockKey", "block"];
        if (!Object.keys(operation).every((key) => allowed.includes(key))) throw new InvalidNoteEdit();
      } else throw new InvalidNoteEdit();
      operations.push(operation as unknown as NoteEditOperation);
    }
    if (new Set(operations.map(({ id }) => id)).size !== operations.length) throw new InvalidNoteEdit();
    return this.#repository.applyNoteOperations(memberId, noteId, { baseRevision: value.baseRevision as number, operations });
  }

  async listConflicts(memberId: string, noteId: string) {
    if (!isUuid(noteId)) throw new InvalidNoteEdit();
    return this.#repository.listNoteEditConflicts(memberId, noteId);
  }

  async resolveConflict(memberId: string, noteId: string, conflictId: string, value: unknown): Promise<NoteConflictResolutionOutcome> {
    if (!isUuid(noteId) || !isUuid(conflictId) || !isPlainObject(value)
      || (value.resolution !== "keep_current" && value.resolution !== "apply_contribution")
      || !Number.isSafeInteger(value.expectedRevision) || (value.expectedRevision as number) < 1
      || !Object.keys(value).every((key) => ["resolution", "expectedRevision"].includes(key)) || Object.keys(value).length !== 2) throw new InvalidNoteEdit();
    return this.#repository.resolveNoteEditConflict(memberId, noteId, conflictId, value.resolution, value.expectedRevision as number);
  }
}

type PrepareFailure = { status: "workspace_forbidden" | "note_not_found" };
interface TriageContext { repository: NoteRepository; memberId: string; workspaceId: string; noteId: string; actor: PortableIdentity }
interface TriageVariant {
  resultKind: NoteTriageResult["kind"];
  prepare(context: TriageContext, value: Record<string, unknown>): Promise<{ change: NoteTriageChange } | PrepareFailure>;
  present(result: NoteTriageResult): object;
}

async function findInboxNote(context: TriageContext): Promise<{ note: NoteRecord } | PrepareFailure> {
  const inbox = await context.repository.listInboxNotes(context.memberId, context.workspaceId);
  if (inbox.status === "workspace_forbidden") return inbox;
  const note = inbox.notes.find(({ id }) => id === context.noteId);
  return note ? { note } : { status: "note_not_found" };
}

async function noteStateChange(context: TriageContext, transform: (note: NoteRecord) => NoteRecord) {
  const found = await findInboxNote(context);
  if ("status" in found) return found;
  const note = transform(found.note);
  const creator = await context.repository.findPortableMemberIdentity(note.createdByMemberId);
  if (!creator) throw new Error("member_identity_unavailable");
  return { note, projection: { schema: "stash.note.v2" as const, note: publicNote(note), createdBy: creator } };
}

const notePresenter = (result: NoteTriageResult): object => {
  if (result.kind !== "organized" && result.kind !== "archived") throw new Error("triage_variant_mismatch");
  return { result: result.kind, note: publicNote(result.note) };
};

const triageVariants: Record<string, TriageVariant> = {
  organize: {
    resultKind: "organized",
    async prepare(context, value) {
      if (typeof value.projectId !== "string" || !isUuid(value.projectId)
        || value.tags !== undefined && (!Array.isArray(value.tags) || value.tags.length > 50
          || value.tags.some((tag) => typeof tag !== "string" || !tag.trim() || tag.trim().length > 100))) throw new InvalidNoteTriageInput();
      const changed = await noteStateChange(context, (note) => ({ ...note, projectId: value.projectId as string,
        tags: [...new Set(((value.tags as string[] | undefined) ?? note.tags).map((tag) => tag.trim()))] }));
      return "status" in changed ? changed : { change: { kind: "organized", note: changed.note, projections: [changed.projection] } };
    },
    present: notePresenter,
  },
  archive: {
    resultKind: "archived",
    async prepare(context, value) {
      if (Object.keys(value).length !== 1) throw new InvalidNoteTriageInput();
      const changed = await noteStateChange(context, (note) => ({ ...note, archivedAt: new Date().toISOString() }));
      return "status" in changed ? changed : { change: { kind: "archived", note: changed.note, projections: [changed.projection] } };
    },
    present: notePresenter,
  },
  link: {
    resultKind: "linked",
    async prepare(context, value) {
      if (typeof value.targetNoteId !== "string" || !isUuid(value.targetNoteId)
        || value.targetNoteId === context.noteId || Object.keys(value).length !== 2) throw new InvalidNoteTriageInput();
      const link = { schema: "stash.note-link.v1" as const, id: randomUUID(), workspaceId: context.workspaceId,
        sourceNoteId: context.noteId, targetNoteId: value.targetNoteId };
      return { change: { kind: "linked", link, projections: [link] } };
    },
    present(result) {
      if (result.kind !== "linked") throw new Error("triage_variant_mismatch");
      return { result: result.kind, link: result.link };
    },
  },
  create_task: {
    resultKind: "task_created",
    async prepare(context, value) {
      if (typeof value.projectId !== "string" || !isUuid(value.projectId) || typeof value.title !== "string"
        || !value.title.trim() || value.title.trim().length > 500
        || !Object.keys(value).every((key) => ["action", "projectId", "title"].includes(key))) throw new InvalidNoteTriageInput();
      return { change: { kind: "task_created", task: { id: randomUUID(), workspaceId: context.workspaceId,
        projectId: value.projectId, title: value.title.trim(), sourceNoteIds: [context.noteId],
        createdAt: new Date().toISOString(), createdBy: context.actor }, projections: [] } };
    },
    present(result) {
      if (result.kind !== "task_created") throw new Error("triage_variant_mismatch");
      return { result: result.kind, task: result.task };
    },
  },
};

export function presentNoteTriageResult(result: NoteTriageResult): object {
  const variant = Object.values(triageVariants).find(({ resultKind }) => resultKind === result.kind);
  if (!variant) throw new Error("unknown_triage_variant");
  return variant.present(result);
}

function publicNote(note: NoteRecord): Omit<NoteRecord, "createdByMemberId"> {
  const { createdByMemberId: _, ...visible } = note;
  return visible;
}
