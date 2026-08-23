import { createHash } from "node:crypto";
import { randomUUID } from "node:crypto";

import { encodePortableFilename, type AttachmentStorage } from "./attachments.js";
import type { PortableWorkspaceCanonicalState } from "./portable-workspace-export.js";
import { isRichTextDocument } from "./rich-text.js";

export interface ImportTransformation { kind: "transformed" | "skipped" | "ambiguous"; object: string; reason: string }
export interface IdentityStub { sourceAccountId: string; displayName: string }
export interface PortableWorkspaceImportReport {
  schema: "stash.portable-workspace-import-report.v1";
  importId: string;
  workspaceId: string;
  archiveSha256: string;
  transformations: ImportTransformation[];
  transformed: ImportTransformation[];
  skipped: ImportTransformation[];
  ambiguous: ImportTransformation[];
  identityStubs: IdentityStub[];
}
export interface PortableWorkspaceImportBundle {
  state: PortableWorkspaceCanonicalState;
  attachmentContent: Map<string, Buffer>;
  identityStubs: IdentityStub[];
  archiveSha256: string;
  destinationOwnerAccountId: string;
  attachmentStorageKeys: Map<string, string>;
}
export interface PortableWorkspaceImportRepository {
  findWorkspaceImport(importId: string): Promise<{ archiveSha256: string; report: PortableWorkspaceImportReport } | undefined>;
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
function portableIdentity(value: unknown): value is { localAccountId: string; displayName: string } { return object(value) && typeof value.localAccountId === "string" && typeof value.displayName === "string"; }
const timestamp = (value: unknown) => typeof value === "string" && Number.isFinite(Date.parse(value));
const unique = (values: string[]) => new Set(values).size === values.length;
function ids(items: unknown[], key = "id"): string[] {
  return items.map((item) => object(item) && typeof item[key] === "string" ? item[key] : "");
}
const onlyKeys = (value: Record<string, unknown>, allowed: string[]) => Object.keys(value).every((key) => allowed.includes(key));

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
  if (!onlyKeys(value, ["workspace","notes","tasks","boards","attachments","noteLocations","noteLinks","activities","noteHistory","durableObjects"])
    || !onlyKeys(value.workspace,["schema","id","name","owner","createdBy"]) || typeof value.workspace.name !== "string" || !value.workspace.name.trim())
    throw new InvalidPortableWorkspaceImport("invalid_canonical_state");
  if (!Array.isArray(value.durableObjects)) throw new InvalidPortableWorkspaceImport("invalid_canonical_state");
  const workspaceId = String(value.workspace.id);
  if (!portableIdentity(value.workspace.createdBy) || !object(value.workspace.owner)
    || value.workspace.owner.type === "personal" && !portableIdentity(value.workspace.owner.identity)
    || value.workspace.owner.type === "organization" && (!object(value.workspace.owner.identity)
      || !uuid.test(String(value.workspace.owner.identity.localOrganizationId)) || typeof value.workspace.owner.identity.displayName !== "string")
    || !["personal","organization"].includes(String(value.workspace.owner.type))) {
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
  const allIdentityIds: string[] = [];
  const collectIdentity = (identity: unknown) => { if (portableIdentity(identity)) allIdentityIds.push(String(identity.localAccountId)); };
  collectIdentity(value.workspace.createdBy); if (value.workspace.owner.type === "personal") collectIdentity(value.workspace.owner.identity);
  for (const item of [...value.notes, ...value.tasks, ...value.attachments]) if (object(item)) collectIdentity(item.createdBy);
  for (const item of [...value.activities, ...value.noteHistory]) if (object(item)) collectIdentity(item.actor);
  const collectNestedIdentities = (child: unknown): void => { if (portableIdentity(child)) collectIdentity(child);
    if (Array.isArray(child)) for (const item of child) collectNestedIdentities(item);
    else if (object(child)) for (const item of Object.values(child)) collectNestedIdentities(item); };
  collectNestedIdentities(value.durableObjects);
  if (allIdentityIds.some((id) => !uuid.test(id))) throw new InvalidPortableWorkspaceImport("invalid_identity");
  const noteIds = ids(value.notes); const taskIds = ids(value.tasks); const boardIds = ids(value.boards);
  const attachmentIds = ids(value.attachments); const locationIds = ids(value.noteLocations, "noteId"); const linkIds = ids(value.noteLinks);
  const durableIds = value.durableObjects.map((item) => object(item) ? `${String(item.kind)}:${String(item.id)}` : "");
  if (![noteIds, taskIds, boardIds, attachmentIds, locationIds, linkIds, durableIds].every(unique)
    || !unique([...noteIds, ...taskIds, ...boardIds, ...attachmentIds, ...linkIds])
    || [...noteIds,...taskIds,...boardIds,...attachmentIds,...locationIds,...linkIds,
      ...value.durableObjects.map((item) => object(item) ? String(item.id) : "")].some((id) => !uuid.test(id)))
    throw new InvalidPortableWorkspaceImport("duplicate_identity");
  const notes = new Set(noteIds); const tasks = new Set(taskIds);
  const projectObjects = value.durableObjects.filter((item) => object(item) && item.kind === "Project");
  const projects = new Set(projectObjects.map((item) => object(item) ? String(item.id) : ""));
  if (locationIds.length !== noteIds.length || locationIds.some((id) => !notes.has(id))) throw new InvalidPortableWorkspaceImport("invalid_note_locations");
  if (value.noteLocations.some((location) => !object(location) || typeof location.path !== "string" || !Array.isArray(location.aliases)
    || location.aliases.some((alias) => typeof alias !== "string" || !safePath(alias)) || !Number.isInteger(location.revision) || Number(location.revision) < 1))
    throw new InvalidPortableWorkspaceImport("invalid_note_locations");
  for (const note of value.notes) if (!object(note) || typeof note.content !== "string" || !note.content.length
    || !Array.isArray(note.tags) || !note.tags.every((tag) => typeof tag === "string") || !timestamp(note.createdAt)
    || note.projectId !== undefined && !projects.has(String(note.projectId))) throw new InvalidPortableWorkspaceImport("invalid_note");
  for (const task of value.tasks) if (!object(task) || !projects.has(String(task.projectId)) || typeof task.title !== "string" || !task.title
    || typeof task.key !== "string" || !object(task.status) || !uuid.test(String(task.status.id)) || !timestamp(task.createdAt)
    || !Array.isArray(task.sourceNoteIds) || task.sourceNoteIds.some((id) => !notes.has(String(id)))
    || task.linkedNoteIds !== undefined && (!Array.isArray(task.linkedNoteIds) || task.linkedNoteIds.some((id) => !notes.has(String(id))))
    || task.dependencies !== undefined && (!Array.isArray(task.dependencies) || task.dependencies.some((edge) => !object(edge) || !tasks.has(String(edge.taskId))))
    || task.sourceBlocks !== undefined && (!Array.isArray(task.sourceBlocks) || task.sourceBlocks.some((source) => !object(source)
      || !notes.has(String(source.noteId)) || !uuid.test(String(source.blockId))))
    || task.keyAliases !== undefined && (!Array.isArray(task.keyAliases) || task.keyAliases.some((alias) => !object(alias)
      || !projects.has(String(alias.projectId)) || typeof alias.key !== "string")))
    throw new InvalidPortableWorkspaceImport("invalid_task");
  for (const board of value.boards) if (!object(board) || !projects.has(String(board.projectId)) || typeof board.name !== "string"
    || !["status", "priority"].includes(String(board.groupBy)) || !timestamp(board.createdAt)) throw new InvalidPortableWorkspaceImport("invalid_board");
  for (const link of value.noteLinks) if (!object(link) || !notes.has(String(link.sourceNoteId))
    || link.targetNoteId !== undefined && link.targetNoteId !== null && !notes.has(String(link.targetNoteId))
    || !Number.isInteger(link.revision ?? 1) || Number(link.revision ?? 1) < 1) throw new InvalidPortableWorkspaceImport("invalid_note_link");
  const allowedDurable = new Map([["Project", "stash.project.v1"], ["Workflow", "stash.workflow.v1"],
    ["GuestProjectAccess", "stash.guest-project-access.v1"], ["RepositoryConnection", "stash.repository-connection.v1"],
    ["Discussion", "stash.discussion.v1"], ["DiscussionWorkLink", "stash.discussion-work-link.v1"]]);
  for (const item of value.durableObjects) {
    if (!object(item) || allowedDurable.get(String(item.kind)) !== item.schema || !object(item.payload) || item.payload.schema !== item.schema
      || item.payload.id !== undefined && item.payload.id !== item.id) throw new InvalidPortableWorkspaceImport("unsupported_durable_object");
    const payload = item.payload;
    if (item.kind === "Project" && (payload.workspaceId !== workspaceId || payload.id !== item.id || typeof payload.name !== "string"
      || typeof payload.key !== "string" || !portableIdentity(payload.createdBy))) throw new InvalidPortableWorkspaceImport("invalid_project");
    if (item.kind === "Workflow" && (!projects.has(String(payload.projectId)) || !Array.isArray(payload.statuses)
      || payload.statuses.some((status) => !object(status) || !uuid.test(String(status.id)) || typeof status.name !== "string"
        || !["unstarted", "started", "completed"].includes(String(status.category)) || !Number.isInteger(status.position) || typeof status.archived !== "boolean")))
      throw new InvalidPortableWorkspaceImport("invalid_workflow");
    if (item.kind === "Discussion" && (payload.workspaceId !== workspaceId || !object(payload.target)
      || payload.target.kind === "task" && !tasks.has(String(payload.target.taskId))
      || ["note", "block"].includes(String(payload.target.kind)) && !notes.has(String(payload.target.noteId))
      || !Array.isArray(payload.messages) || payload.messages.some((message) => !object(message) || !uuid.test(String(message.id))
        || typeof message.content !== "string" || !message.content || !portableIdentity(message.author) || !timestamp(message.createdAt))))
      throw new InvalidPortableWorkspaceImport("invalid_discussion");
    if (item.kind === "DiscussionWorkLink" && (payload.workspaceId !== workspaceId || !object(payload.work)
      || payload.work.kind === "note" && !notes.has(String(payload.work.id)) || payload.work.kind === "task" && !tasks.has(String(payload.work.id))))
      throw new InvalidPortableWorkspaceImport("invalid_discussion_link");
    if (item.kind === "GuestProjectAccess" && (!Array.isArray(payload.projects) || payload.projects.some((project) => !object(project)
      || project.workspaceId !== workspaceId || !projects.has(String(project.projectId))))) throw new InvalidPortableWorkspaceImport("invalid_permission");
    if (item.kind === "RepositoryConnection" && (!Array.isArray(payload.projectIds) || payload.projectIds.some((id) => !projects.has(String(id)))))
      throw new InvalidPortableWorkspaceImport("invalid_repository_connection");
  }
  const workflowStatuses = new Set(value.durableObjects.filter((item) => object(item) && item.kind === "Workflow" && object(item.payload))
    .flatMap((item) => object(item) && object(item.payload) && Array.isArray(item.payload.statuses) ? ids(item.payload.statuses) : []));
  if (value.tasks.some((task) => object(task) && object(task.status) && !workflowStatuses.has(String(task.status.id)))) throw new InvalidPortableWorkspaceImport("dangling_task_status");
  const domainIds = new Set([...noteIds,...taskIds,...linkIds,...value.durableObjects.map((item) => object(item) ? String(item.id) : "")]);
  if (value.activities.some((activity) => !object(activity) || !object(activity.object) || !domainIds.has(String(activity.object.id))
    || typeof activity.action !== "string" || !timestamp(activity.occurredAt) || !object(activity.before) || !object(activity.after)))
    throw new InvalidPortableWorkspaceImport("invalid_activity");
  const revisions = new Set<string>();
  if (value.noteHistory.some((history) => !object(history) || !notes.has(String(history.noteId)) || !Number.isInteger(history.revision)
    || Number(history.revision) < 1 || typeof history.content !== "string" || !history.content.length || !isRichTextDocument(history.document)
    || !timestamp(history.recordedAt) || revisions.has(`${String(history.noteId)}:${String(history.revision)}`)
    || !revisions.add(`${String(history.noteId)}:${String(history.revision)}`))) throw new InvalidPortableWorkspaceImport("invalid_note_history");
  if (value.noteLinks.some((item) => !object(item) || !["stash.note-link.v1", "stash.note-link.v2"].includes(String(item.schema))
    || item.workspaceId !== workspaceId)
    || value.activities.some((item) => !object(item) || item.schema !== "stash.activity.v1" || item.workspaceId !== workspaceId)
    || value.noteHistory.some((item) => !object(item) || item.workspaceId !== workspaceId)
    || value.durableObjects.some((item) => !object(item) || typeof item.kind !== "string" || typeof item.id !== "string"
      || typeof item.schema !== "string" || !("payload" in item))) throw new InvalidPortableWorkspaceImport("invalid_canonical_state");
  for (const attachment of value.attachments) {
    if (!object(attachment) || typeof attachment.relativePath !== "string" || typeof attachment.size !== "number"
      || !Number.isSafeInteger(attachment.size) || attachment.size < 1 || typeof attachment.contentType !== "string"
      || !["upload","paste"].includes(String(attachment.source)) || !timestamp(attachment.createdAt)) throw new InvalidPortableWorkspaceImport("invalid_canonical_state");
    const expected = `./attachments/${String(attachment.id)}/${encodePortableFilename(String(attachment.filename))}`;
    if (!uuid.test(String(attachment.id)) || typeof attachment.filename !== "string" || attachment.relativePath !== expected)
      throw new InvalidPortableWorkspaceImport("invalid_attachment_path");
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
  const nested = (value: unknown): void => { add(value); if (Array.isArray(value)) for (const item of value) nested(item);
    else if (object(value)) for (const item of Object.values(value)) nested(item); };
  nested(state.durableObjects);
  return [...values].sort(([left], [right]) => left.localeCompare(right)).map(([sourceAccountId, displayName]) => ({ sourceAccountId, displayName }));
}

export class PortableWorkspaceImportService {
  constructor(private readonly repository: PortableWorkspaceImportRepository,
    private readonly storage?: AttachmentStorage,
    private readonly limits = { maxArchiveBytes: 256 * 1024 * 1024, maxEntries: 100_000, maxFileBytes: 256 * 1024 * 1024 }) {}

  async import(importId: string, destinationOwnerAccountId: string, archive: Buffer) {
    if (!uuid.test(importId) || !uuid.test(destinationOwnerAccountId)) throw new InvalidPortableWorkspaceImport("invalid_import_id");
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
    const canonicalPaths = new Set<string>();
    const requireCanonicalFile = (path: string) => { if (!safePath(path) || canonicalPaths.has(path) || !files.has(path))
      throw new InvalidPortableWorkspaceImport("canonical_file_binding"); canonicalPaths.add(path); };
    for (const location of state.noteLocations) requireCanonicalFile(location.path);
    for (const task of state.tasks) requireCanonicalFile(`tasks/${task.key}--${task.id}.md`);
    for (const board of state.boards) requireCanonicalFile(`boards/${board.id}.json`);
    for (const attachment of state.attachments) {
      const path = attachment.relativePath.replace(/^\.\//, ""); const content = files.get(path);
      if (!content || content.length !== attachment.size) throw new InvalidPortableWorkspaceImport("attachment_missing");
      requireCanonicalFile(path);
      attachmentContent.set(attachment.id, content);
    }
    const archiveSha256 = createHash("sha256").update(archive).digest("hex");
    const existing = await this.repository.findWorkspaceImport(importId);
    if (existing) return existing.archiveSha256 === archiveSha256
      ? { status: "duplicate" as const, report: existing.report } : { status: "workspace_conflict" as const };
    if (attachmentContent.size && !this.storage) throw new Error("attachment_storage_unavailable");
    const attachmentStorageKeys = new Map<string, string>();
    try {
      for (const [attachmentId, content] of attachmentContent) {
        const key = `${randomUUID()}/${attachmentId}`; await this.storage!.put(key, content); attachmentStorageKeys.set(attachmentId, key);
      }
      const result = await this.repository.importWorkspace(importId, { state, attachmentContent, identityStubs: identities(state),
        archiveSha256, destinationOwnerAccountId, attachmentStorageKeys });
      if (result.status !== "imported") for (const key of attachmentStorageKeys.values()) await this.storage!.delete(key).catch(() => undefined);
      return result;
    } catch (error) {
      for (const key of attachmentStorageKeys.values()) await this.storage!.delete(key).catch(() => undefined);
      throw error;
    }
  }
}
