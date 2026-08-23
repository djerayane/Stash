import { createHash } from "node:crypto";

import type { PortableWorkspaceCanonicalState } from "./portable-workspace-export.js";

export interface ImportTransformation { kind: "transformed" | "skipped" | "ambiguous"; object: string; reason: string }
export interface IdentityStub { sourceAccountId: string; displayName: string }
export interface PortableWorkspaceImportReport {
  schema: "stash.portable-workspace-import-report.v1";
  importId: string;
  workspaceId: string;
  archiveSha256: string;
  transformations: ImportTransformation[];
  identityStubs: IdentityStub[];
}
export interface PortableWorkspaceImportBundle {
  state: PortableWorkspaceCanonicalState;
  attachmentContent: Map<string, Buffer>;
  identityStubs: IdentityStub[];
  archiveSha256: string;
}
export interface PortableWorkspaceImportRepository {
  importWorkspace(importId: string, bundle: PortableWorkspaceImportBundle): Promise<
    | { status: "imported"; report: PortableWorkspaceImportReport }
    | { status: "duplicate"; report: PortableWorkspaceImportReport }
    | { status: "forbidden" }
    | { status: "workspace_conflict" }
  >;
}

export class InvalidPortableWorkspaceImport extends Error {}
export class PortableWorkspaceImportTooLarge extends Error {}
export class UnsupportedPortableWorkspaceImport extends Error {}

interface Entry { path: string; content: Buffer }
interface Manifest { schema: string; workspace: unknown; files: Array<{ path: string; bytes: number; sha256: string }> }
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const digest = /^[0-9a-f]{64}$/;
function safePath(path: string): boolean {
  return path.length > 0 && !path.startsWith("/") && !path.includes("\\") && !path.includes("\0")
    && !path.split("/").some((part) => part === "" || part === "." || part === "..");
}
function object(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === "object" && !Array.isArray(value); }
function portableIdentity(value: unknown): boolean { return object(value) && typeof value.localAccountId === "string" && typeof value.displayName === "string"; }

function unzipStored(archive: Buffer, limits: { maxEntries: number; maxFileBytes: number }): Entry[] {
  if (archive.length < 22) throw new InvalidPortableWorkspaceImport("missing_zip_directory");
  let end = -1;
  for (let offset = archive.length - 22; offset >= Math.max(0, archive.length - 65_557); offset -= 1) {
    if (archive.readUInt32LE(offset) === 0x06054b50) { end = offset; break; }
  }
  if (end < 0) throw new InvalidPortableWorkspaceImport("missing_zip_directory");
  let entries = archive.readUInt16LE(end + 10); let directorySize = archive.readUInt32LE(end + 12);
  let directoryOffset = archive.readUInt32LE(end + 16); let directoryEnd = end;
  if (entries === 0xffff) {
    const locator = end - 20;
    if (locator < 0 || archive.readUInt32LE(locator) !== 0x07064b50) throw new InvalidPortableWorkspaceImport("invalid_zip64_locator");
    const zip64End = Number(archive.readBigUInt64LE(locator + 8));
    if (!Number.isSafeInteger(zip64End) || zip64End + 56 !== locator || archive.readUInt32LE(zip64End) !== 0x06064b50)
      throw new InvalidPortableWorkspaceImport("invalid_zip64_directory");
    entries = Number(archive.readBigUInt64LE(zip64End + 32));
    directorySize = Number(archive.readBigUInt64LE(zip64End + 40)); directoryOffset = Number(archive.readBigUInt64LE(zip64End + 48));
    if (![entries, directorySize, directoryOffset].every(Number.isSafeInteger)) throw new PortableWorkspaceImportTooLarge("zip64_limit");
    directoryEnd = zip64End;
  }
  if (entries > limits.maxEntries) throw new PortableWorkspaceImportTooLarge("too_many_entries");
  if (directoryOffset + directorySize !== directoryEnd) throw new InvalidPortableWorkspaceImport("invalid_zip_directory");
  const found: Entry[] = []; const paths = new Set<string>(); let cursor = directoryOffset;
  for (let index = 0; index < entries; index += 1) {
    if (cursor + 46 > directoryEnd || archive.readUInt32LE(cursor) !== 0x02014b50) throw new InvalidPortableWorkspaceImport("invalid_zip_entry");
    const flags = archive.readUInt16LE(cursor + 8); const method = archive.readUInt16LE(cursor + 10);
    const compressed = archive.readUInt32LE(cursor + 20); const size = archive.readUInt32LE(cursor + 24);
    const nameLength = archive.readUInt16LE(cursor + 28); const extraLength = archive.readUInt16LE(cursor + 30); const commentLength = archive.readUInt16LE(cursor + 32);
    const localOffset = archive.readUInt32LE(cursor + 42); const path = archive.subarray(cursor + 46, cursor + 46 + nameLength).toString("utf8");
    if ((flags & 1) || method !== 0 || compressed !== size) throw new UnsupportedPortableWorkspaceImport("only_unencrypted_stored_entries_are_supported");
    if (!safePath(path) || paths.has(path) || size > limits.maxFileBytes) throw new InvalidPortableWorkspaceImport("unsafe_zip_entry");
    if (localOffset + 30 > directoryOffset || archive.readUInt32LE(localOffset) !== 0x04034b50) throw new InvalidPortableWorkspaceImport("invalid_local_entry");
    const localNameLength = archive.readUInt16LE(localOffset + 26); const localExtraLength = archive.readUInt16LE(localOffset + 28);
    const localPath = archive.subarray(localOffset + 30, localOffset + 30 + localNameLength).toString("utf8");
    const contentOffset = localOffset + 30 + localNameLength + localExtraLength;
    if (localPath !== path || contentOffset + size > directoryOffset) throw new InvalidPortableWorkspaceImport("invalid_local_entry");
    paths.add(path); found.push({ path, content: archive.subarray(contentOffset, contentOffset + size) });
    cursor += 46 + nameLength + extraLength + commentLength;
  }
  if (cursor !== directoryEnd) throw new InvalidPortableWorkspaceImport("invalid_zip_directory");
  return found;
}

function parseState(content: Buffer): PortableWorkspaceCanonicalState {
  let value: unknown; try { value = JSON.parse(content.toString("utf8")); } catch { throw new InvalidPortableWorkspaceImport("invalid_canonical_state"); }
  if (!object(value) || !object(value.workspace) || value.workspace.schema !== "stash.workspace.v1"
    || !uuid.test(String(value.workspace.id)) || !Array.isArray(value.notes) || !Array.isArray(value.tasks)
    || !Array.isArray(value.boards) || !Array.isArray(value.attachments) || !Array.isArray(value.noteLocations)
    || !Array.isArray(value.noteLinks) || !Array.isArray(value.activities) || !Array.isArray(value.noteHistory)) {
    throw new InvalidPortableWorkspaceImport("invalid_canonical_state");
  }
  if (!Array.isArray(value.durableObjects)) throw new InvalidPortableWorkspaceImport("invalid_canonical_state");
  const workspaceId = String(value.workspace.id);
  if (!portableIdentity(value.workspace.createdBy) || !object(value.workspace.owner)
    || value.workspace.owner.type === "personal" && !portableIdentity(value.workspace.owner.identity)) {
    throw new InvalidPortableWorkspaceImport("invalid_canonical_state");
  }
  const typedArrays: Array<[unknown[], string, boolean]> = [
    [value.notes, "stash.note.v1", true], [value.tasks, "stash.task.v1", true],
    [value.boards, "stash.board.v1", false], [value.attachments, "stash.attachment.v1", true],
    [value.noteLocations, "stash.note-location.v1", true],
  ];
  for (const [items, schema, hasWorkspace] of typedArrays) {
    if (items.some((item) => !object(item) || item.schema !== schema || typeof item.id !== "string" && typeof item.noteId !== "string"
      || hasWorkspace && item.workspaceId !== workspaceId)) throw new InvalidPortableWorkspaceImport("invalid_canonical_state");
  }
  if (value.noteLinks.some((item) => !object(item) || !["stash.note-link.v1", "stash.note-link.v2"].includes(String(item.schema))
    || item.workspaceId !== workspaceId)
    || value.activities.some((item) => !object(item) || item.schema !== "stash.activity.v1" || item.workspaceId !== workspaceId)
    || value.noteHistory.some((item) => !object(item) || item.workspaceId !== workspaceId)
    || value.durableObjects.some((item) => !object(item) || typeof item.kind !== "string" || typeof item.id !== "string"
      || typeof item.schema !== "string" || !("payload" in item))) throw new InvalidPortableWorkspaceImport("invalid_canonical_state");
  for (const attachment of value.attachments) {
    if (!object(attachment) || typeof attachment.relativePath !== "string" || typeof attachment.size !== "number"
      || !Number.isSafeInteger(attachment.size) || attachment.size < 0) throw new InvalidPortableWorkspaceImport("invalid_canonical_state");
  }
  if ([...value.notes, ...value.tasks, ...value.attachments].some((item) => !object(item) || !portableIdentity(item.createdBy))
    || value.activities.some((item) => !object(item) || !portableIdentity(item.actor))
    || value.noteHistory.some((item) => !object(item) || !portableIdentity(item.actor))) throw new InvalidPortableWorkspaceImport("invalid_canonical_state");
  return value as unknown as PortableWorkspaceCanonicalState;
}
function identities(state: PortableWorkspaceCanonicalState): IdentityStub[] {
  const values = new Map<string, string>();
  const add = (value: unknown) => { if (object(value) && typeof value.localAccountId === "string" && typeof value.displayName === "string") values.set(value.localAccountId, value.displayName); };
  add(state.workspace.createdBy); if (state.workspace.owner.type === "personal") add(state.workspace.owner.identity);
  for (const item of [...state.notes, ...state.tasks, ...state.attachments]) add(item.createdBy);
  for (const item of state.activities) add(item.actor);
  for (const item of state.noteHistory) add(item.actor);
  return [...values].sort(([left], [right]) => left.localeCompare(right)).map(([sourceAccountId, displayName]) => ({ sourceAccountId, displayName }));
}

export class PortableWorkspaceImportService {
  constructor(private readonly repository: PortableWorkspaceImportRepository,
    private readonly limits = { maxArchiveBytes: 256 * 1024 * 1024, maxEntries: 100_000, maxFileBytes: 256 * 1024 * 1024 }) {}

  async import(importId: string, archive: Buffer) {
    if (!uuid.test(importId)) throw new InvalidPortableWorkspaceImport("invalid_import_id");
    if (archive.length > this.limits.maxArchiveBytes) throw new PortableWorkspaceImportTooLarge("archive_too_large");
    const entries = unzipStored(archive, this.limits); const files = new Map(entries.map((entry) => [entry.path, entry.content]));
    const manifestContent = files.get("manifest.json"); if (!manifestContent) throw new InvalidPortableWorkspaceImport("missing_manifest");
    let manifest: Manifest; try { manifest = JSON.parse(manifestContent.toString("utf8")) as Manifest; } catch { throw new InvalidPortableWorkspaceImport("invalid_manifest"); }
    if (!object(manifest) || manifest.schema !== "stash.portable-workspace-export.v1" || !Array.isArray(manifest.files)) throw new UnsupportedPortableWorkspaceImport("unsupported_schema");
    const declared = new Set<string>();
    for (const entry of manifest.files) {
      if (!object(entry) || typeof entry.path !== "string" || !safePath(entry.path) || entry.path === "manifest.json"
        || !Number.isSafeInteger(entry.bytes) || entry.bytes < 0 || typeof entry.sha256 !== "string" || !digest.test(entry.sha256)
        || declared.has(entry.path)) throw new InvalidPortableWorkspaceImport("invalid_manifest_entry");
      const content = files.get(entry.path); if (!content || content.length !== entry.bytes
        || createHash("sha256").update(content).digest("hex") !== entry.sha256) throw new InvalidPortableWorkspaceImport("checksum_mismatch");
      declared.add(entry.path);
    }
    if (files.size !== declared.size + 1 || [...files].some(([path]) => path !== "manifest.json" && !declared.has(path))) throw new InvalidPortableWorkspaceImport("undeclared_archive_entry");
    const canonical = files.get("objects/workspace.json"); if (!canonical) throw new UnsupportedPortableWorkspaceImport("canonical_state_missing");
    const state = parseState(canonical);
    if (!object(manifest.workspace) || manifest.workspace.id !== state.workspace.id) throw new InvalidPortableWorkspaceImport("workspace_identity_mismatch");
    const attachmentContent = new Map<string, Buffer>();
    for (const attachment of state.attachments) {
      const path = attachment.relativePath.replace(/^\.\//, ""); const content = files.get(path);
      if (!content || content.length !== attachment.size) throw new InvalidPortableWorkspaceImport("attachment_missing");
      attachmentContent.set(attachment.id, content);
    }
    const bundle = { state, attachmentContent, identityStubs: identities(state), archiveSha256: createHash("sha256").update(archive).digest("hex") };
    return this.repository.importWorkspace(importId, bundle);
  }
}
