import { randomUUID } from "node:crypto";
import { posix } from "node:path";

export interface NoteLocationRecord {
  noteId: string;
  workspaceId: string;
  path: string;
  aliases: string[];
  revision: number;
  parentId?: string;
  position?: string;
  archivedAt?: string;
  trashedAt?: string;
}

export interface NoteLinkRecord {
  id: string;
  workspaceId: string;
  sourceNoteId: string;
  targetNoteId?: string;
  label: string;
  relationshipType?: string;
  revision: number;
  targetPath?: string;
  candidateNoteIds?: string[];
}

export interface PortableNoteLocationProjection extends NoteLocationRecord { schema: "stash.note-location.v1" }
export interface PortableNoteLinkStateProjection extends NoteLinkRecord { schema: "stash.note-link.v2" }

export type NoteLinkResolution =
  | { link: NoteLinkRecord; state: "resolved"; target: NoteLocationRecord }
  | { link: NoteLinkRecord; state: "broken" }
  | { link: NoteLinkRecord; state: "ambiguous"; candidates: NoteLocationRecord[] };

export interface NoteLinkRepository {
  moveNote(memberId: string, noteId: string, expectedRevision: number, path: string, projection: PortableNoteLocationProjection): Promise<
    { status: "moved" | "unchanged"; location: NoteLocationRecord } | { status: "changed"; location: NoteLocationRecord }
    | { status: "not_found" } | { status: "path_conflict" }>;
  createNoteLink(memberId: string, link: NoteLinkRecord, projection: PortableNoteLinkStateProjection): Promise<
    { status: "created"; link: NoteLinkRecord } | { status: "source_not_found" | "target_not_found" | "already_linked" }>;
  createImportedNoteLink(memberId: string, link: NoteLinkRecord, projection: PortableNoteLinkStateProjection): Promise<
    { status: "created"; link: NoteLinkRecord } | { status: "source_not_found" | "candidate_not_found" }>;
  listNoteLinks(memberId: string, sourceNoteId: string): Promise<
    { status: "found"; source: NoteLocationRecord; links: NoteLinkResolution[] } | { status: "not_found" }>;
  repairNoteLink(memberId: string, sourceNoteId: string, linkId: string, targetNoteId: string, expectedRevision: number,
    projection: PortableNoteLinkStateProjection): Promise<
      { status: "repaired"; link: NoteLinkRecord } | { status: "changed"; link: NoteLinkRecord }
      | { status: "not_found" | "target_not_found" }>;
}

export class InvalidNoteLinkInput extends Error {}
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const plainObject = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);

function portablePath(value: unknown): string {
  if (typeof value !== "string" || value.length > 1_024 || value.startsWith("/") || value.includes("\\")
    || value.includes("//") || value !== value.trim() || !value.endsWith(".md")) throw new InvalidNoteLinkInput();
  const normalized = posix.normalize(value);
  if (normalized !== value || normalized === "." || normalized === ".." || normalized.startsWith("../")
    || value.split("/").some((part) => !part || part === "." || part === "..")) throw new InvalidNoteLinkInput();
  return value;
}

function label(value: unknown): string {
  if (typeof value !== "string" || !value.trim() || value.length > 200 || /[\r\n\[\]]/.test(value)) throw new InvalidNoteLinkInput();
  return value.trim();
}

function relationshipType(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !value.trim() || value.trim().length > 80 || /[\r\n]/.test(value)) throw new InvalidNoteLinkInput();
  return value.trim();
}

function relativeMarkdown(sourcePath: string, targetPath: string): string {
  const relative = posix.relative(posix.dirname(sourcePath), targetPath);
  const rooted = relative.startsWith(".") ? relative : `./${relative}`;
  return rooted.split("/").map((part) => encodeURIComponent(part)).join("/");
}

function present(resolution: NoteLinkResolution) {
  if (resolution.state === "broken") return { ...resolution.link, state: resolution.state };
  if (resolution.state === "ambiguous") return { ...resolution.link, state: resolution.state,
    candidates: resolution.candidates.map(({ noteId, path, revision }) => ({ noteId, path, revision })) };
  return { ...resolution.link, state: resolution.state, targetPath: resolution.target.path };
}

export class NoteLinkService {
  constructor(private readonly repository: NoteLinkRepository) {}

  async move(memberId: string, noteId: string, value: unknown) {
    if (!uuid.test(noteId) || !plainObject(value) || !Number.isSafeInteger(value.expectedRevision) || (value.expectedRevision as number) < 1
      || !Object.keys(value).every((key) => ["expectedRevision", "path"].includes(key)) || Object.keys(value).length !== 2)
      throw new InvalidNoteLinkInput();
    const path = portablePath(value.path);
    const projection: PortableNoteLocationProjection = { schema: "stash.note-location.v1", noteId, workspaceId: "", path,
      aliases: [], revision: (value.expectedRevision as number) + 1 };
    return this.repository.moveNote(memberId, noteId, value.expectedRevision as number, path, projection);
  }

  async create(memberId: string, sourceNoteId: string, value: unknown) {
    if (!uuid.test(sourceNoteId) || !plainObject(value) || typeof value.targetNoteId !== "string" || !uuid.test(value.targetNoteId)
      || value.targetNoteId === sourceNoteId || !Object.keys(value).every((key) => ["targetNoteId", "label", "relationshipType"].includes(key)))
      throw new InvalidNoteLinkInput();
    const semanticType = relationshipType(value.relationshipType);
    const record: NoteLinkRecord = { id: randomUUID(), workspaceId: "", sourceNoteId, targetNoteId: value.targetNoteId,
      label: value.label === undefined ? "Note" : label(value.label), ...(semanticType ? { relationshipType: semanticType } : {}), revision: 1 };
    return this.repository.createNoteLink(memberId, record, { schema: "stash.note-link.v2", ...record });
  }

  async importUnresolved(memberId: string, sourceNoteId: string, value: unknown) {
    if (!uuid.test(sourceNoteId) || !plainObject(value) || !Array.isArray(value.candidateNoteIds)
      || value.candidateNoteIds.length > 100 || value.candidateNoteIds.some((id) => typeof id !== "string" || !uuid.test(id))
      || new Set(value.candidateNoteIds).size !== value.candidateNoteIds.length
      || !Object.keys(value).every((key) => ["targetPath", "candidateNoteIds", "label"].includes(key))) throw new InvalidNoteLinkInput();
    const record: NoteLinkRecord = { id: randomUUID(), workspaceId: "", sourceNoteId,
      targetPath: portablePath(value.targetPath),
      candidateNoteIds: [...value.candidateNoteIds] as string[], label: value.label === undefined ? "Note" : label(value.label), revision: 1 };
    return this.repository.createImportedNoteLink(memberId, record, { schema: "stash.note-link.v2", ...record });
  }

  async list(memberId: string, sourceNoteId: string) {
    if (!uuid.test(sourceNoteId)) throw new InvalidNoteLinkInput();
    const result = await this.repository.listNoteLinks(memberId, sourceNoteId);
    if (result.status === "not_found") return result;
    return { status: "found" as const, links: result.links.map((entry) => {
      const item = present(entry);
      if (entry.state !== "resolved") return item;
      return { ...item, markdown: `[${entry.link.label}](${relativeMarkdown(result.source.path, entry.target.path)})` };
    }) };
  }

  async repair(memberId: string, sourceNoteId: string, linkId: string, value: unknown) {
    if (!uuid.test(sourceNoteId) || !uuid.test(linkId) || !plainObject(value) || typeof value.targetNoteId !== "string" || !uuid.test(value.targetNoteId)
      || !Number.isSafeInteger(value.expectedRevision) || (value.expectedRevision as number) < 1
      || !Object.keys(value).every((key) => ["targetNoteId", "expectedRevision"].includes(key)) || Object.keys(value).length !== 2)
      throw new InvalidNoteLinkInput();
    const projection: PortableNoteLinkStateProjection = { schema: "stash.note-link.v2", id: linkId, workspaceId: "", sourceNoteId,
      targetNoteId: value.targetNoteId, label: "", revision: (value.expectedRevision as number) + 1 };
    return this.repository.repairNoteLink(memberId, sourceNoteId, linkId, value.targetNoteId, value.expectedRevision as number, projection);
  }
}
