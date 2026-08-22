import { createHash } from "node:crypto";

import type { AttachmentStorage, PortableAttachmentProjection } from "./attachments.js";
import type { PortableNoteProjection, PortableTaskProjection } from "./notes.js";
import type { PortableWorkspaceProjection } from "./workspaces-projects.js";
import type { Board } from "./boards.js";

export interface PortableExportAttachment {
  projection: PortableAttachmentProjection;
  storageKey?: string;
  content?: Buffer;
}

/** A repository must produce this as one permission-filtered, consistent read. */
export interface PortableWorkspaceExportSnapshot {
  workspace: PortableWorkspaceProjection;
  notes: PortableNoteProjection[];
  tasks: PortableTaskProjection[];
  boards: Board[];
  attachments: PortableExportAttachment[];
}

export interface PortableWorkspaceExportRepository {
  readExportSnapshot(memberId: string, workspaceId: string): Promise<
    | { status: "found"; snapshot: PortableWorkspaceExportSnapshot }
    | { status: "workspace_forbidden" | "workspace_not_found" }
  >;
}

export type PortableWorkspaceExportOutcome =
  | { status: "exported"; archive: Buffer; filename: string }
  | { status: "workspace_forbidden" }
  | { status: "workspace_not_found" };

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export class InvalidPortableWorkspaceExport extends Error {}
export class PortableWorkspaceExportTooLarge extends Error {}

function stable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stable);
  if (value !== null && typeof value === "object") return Object.fromEntries(Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right)).map(([key, child]) => [key, stable(child)]));
  return value;
}

function stableJson(value: unknown): string { return `${JSON.stringify(stable(value), null, 2)}\n`; }
function metadata(properties: Record<string, unknown>): string {
  return Object.entries(properties).map(([key, value]) => `${key}: ${typeof value === "string" ? JSON.stringify(value) : JSON.stringify(stable(value))}`).join("\n");
}

function noteMarkdown(note: PortableNoteProjection): string {
  const { content, ...properties } = note;
  // Notes live one directory below the archive root; make root-relative Attachment links remain valid.
  const portableContent = content.replaceAll("(<./attachments/", "(<../attachments/");
  return `---\n${metadata(properties)}\n---\n\n${portableContent.trimEnd()}\n`;
}

function taskMarkdown(task: PortableTaskProjection): string {
  return `---\n${metadata(task as unknown as Record<string, unknown>)}\n---\n\n# ${task.key} — ${task.title}\n`;
}

interface ArchiveEntry { path: string; content: Buffer }
interface ManifestEntry { path: string; bytes: number; sha256: string }
function comparePaths(left: ArchiveEntry, right: ArchiveEntry): number { return left.path < right.path ? -1 : left.path > right.path ? 1 : 0; }

const crcTable = Array.from({ length: 256 }, (_, value) => {
  let current = value;
  for (let bit = 0; bit < 8; bit += 1) current = (current & 1) ? 0xedb88320 ^ (current >>> 1) : current >>> 1;
  return current >>> 0;
});
function crc32(content: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of content) crc = crcTable[(crc ^ byte) & 0xff]! ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

/** Produces a ZIP with stored entries and fixed timestamps so identical snapshots are byte-identical. */
function zip(entries: ArchiveEntry[]): Buffer {
  const locals: Buffer[] = []; const centrals: Buffer[] = []; let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.path); const checksum = crc32(entry.content);
    const local = Buffer.alloc(30 + name.length); local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6); local.writeUInt16LE(0, 8); local.writeUInt16LE(0, 10); local.writeUInt16LE(0x0021, 12);
    local.writeUInt32LE(checksum, 14); local.writeUInt32LE(entry.content.length, 18); local.writeUInt32LE(entry.content.length, 22);
    local.writeUInt16LE(name.length, 26); name.copy(local, 30); locals.push(local, entry.content);
    const central = Buffer.alloc(46 + name.length); central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8); central.writeUInt16LE(0, 10); central.writeUInt16LE(0, 12); central.writeUInt16LE(0x0021, 14);
    central.writeUInt32LE(checksum, 16); central.writeUInt32LE(entry.content.length, 20); central.writeUInt32LE(entry.content.length, 24);
    central.writeUInt16LE(name.length, 28); central.writeUInt32LE(offset, 42); name.copy(central, 46); centrals.push(central);
    offset += local.length + entry.content.length;
  }
  const directory = Buffer.concat(centrals); const end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50, 0);
  if (entries.length > 0xffff) {
    const zip64EndOffset = offset + directory.length; const zip64End = Buffer.alloc(56); zip64End.writeUInt32LE(0x06064b50, 0);
    zip64End.writeBigUInt64LE(44n, 4); zip64End.writeUInt16LE(45, 12); zip64End.writeUInt16LE(45, 14);
    zip64End.writeBigUInt64LE(BigInt(entries.length), 24); zip64End.writeBigUInt64LE(BigInt(entries.length), 32);
    zip64End.writeBigUInt64LE(BigInt(directory.length), 40); zip64End.writeBigUInt64LE(BigInt(offset), 48);
    const locator = Buffer.alloc(20); locator.writeUInt32LE(0x07064b50, 0); locator.writeBigUInt64LE(BigInt(zip64EndOffset), 8); locator.writeUInt32LE(1, 16);
    end.writeUInt16LE(0xffff, 8); end.writeUInt16LE(0xffff, 10); end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(offset, 16);
    return Buffer.concat([...locals, directory, zip64End, locator, end]);
  }
  end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10); end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}

function attachmentPath(projection: PortableAttachmentProjection): string {
  const path = projection.relativePath.replace(/^\.\//, "");
  const expected = `attachments/${projection.id}/`;
  if (!path.startsWith(expected) || path.includes("\\") || path.split("/").includes("..")) throw new Error("invalid_attachment_path");
  return path;
}
function isSafeArchivePath(path: string): boolean {
  return path.length > 0 && !path.startsWith("/") && !path.includes("\\") && !path.includes("\0")
    && !path.split("/").some((part) => part === "" || part === "." || part === "..");
}
function zipSize(entries: Array<{ path: string; bytes: number }>): number {
  const endBytes = entries.length > 0xffff ? 98 : 22;
  return endBytes + entries.reduce((total, entry) => total + entry.bytes + 76 + 2 * Buffer.byteLength(entry.path), 0);
}

export class PortableWorkspaceExportService {
  constructor(private readonly repository: PortableWorkspaceExportRepository, private readonly storage?: AttachmentStorage,
    private readonly limits = { maxArchiveBytes: 256 * 1024 * 1024 }) {}

  async export(memberId: string, workspaceId: string): Promise<PortableWorkspaceExportOutcome> {
    if (!uuid.test(workspaceId)) throw new InvalidPortableWorkspaceExport();
    const result = await this.repository.readExportSnapshot(memberId, workspaceId);
    if (result.status !== "found") return result;
    const { snapshot } = result;
    if (snapshot.workspace.id !== workspaceId || snapshot.notes.some((note) => note.workspaceId !== workspaceId)
      || snapshot.tasks.some((task) => task.workspaceId !== workspaceId)
      || snapshot.attachments.some(({ projection }) => projection.workspaceId !== workspaceId)) {
      throw new Error("inconsistent_export_snapshot");
    }
    const readme = "# Stash Portable Workspace Export\n\nFormat: `stash.portable-workspace-export.v1`\n\nNotes and Tasks are readable Markdown. Board view configurations are deterministic JSON in `boards/`. `manifest.json` contains the Workspace identity, file checksums, and the schemas needed by importers. Attachment paths and bytes are preserved exactly.\n";
    const noteTexts = snapshot.notes.map((note) => ({ path: `notes/${note.id}.md`, text: noteMarkdown(note) }));
    const taskTexts = snapshot.tasks.map((task) => ({ path: `tasks/${task.key}--${task.id}.md`, text: taskMarkdown(task) }));
    const boardTexts = snapshot.boards.map((board) => ({ path: `boards/${board.id}.json`, text: stableJson(board) }));
    const planned = [
      { path: "README.md", bytes: Buffer.byteLength(readme) },
      ...snapshot.attachments.map(({ projection }) => ({ path: attachmentPath(projection), bytes: projection.size })),
      ...noteTexts.map(({ path, text }) => ({ path, bytes: Buffer.byteLength(text) })),
      ...taskTexts.map(({ path, text }) => ({ path, bytes: Buffer.byteLength(text) })),
      ...boardTexts.map(({ path, text }) => ({ path, bytes: Buffer.byteLength(text) })),
    ].sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0);
    const seen = new Set<string>();
    if (planned.some(({ path, bytes }) => !isSafeArchivePath(path) || !Number.isSafeInteger(bytes) || bytes < 0 || seen.has(path) || !seen.add(path)))
      throw new Error("invalid_export_path");
    const placeholderFiles: ManifestEntry[] = planned.map(({ path, bytes }) => ({ path, bytes, sha256: "0".repeat(64) }));
    const manifestBytes = Buffer.byteLength(stableJson({ schema: "stash.portable-workspace-export.v1", workspace: snapshot.workspace, files: placeholderFiles }));
    if (zipSize([...planned, { path: "manifest.json", bytes: manifestBytes }]) > this.limits.maxArchiveBytes)
      throw new PortableWorkspaceExportTooLarge();
    const attachments: Array<{ projection: PortableAttachmentProjection; content: Buffer }> = [];
    for (const attachment of snapshot.attachments) {
      const content = attachment.content ?? (attachment.storageKey && this.storage?.getBounded
        ? await this.storage.getBounded(attachment.storageKey, attachment.projection.size) : undefined);
      if (!content || attachment.projection.size !== content.length) throw new Error("inconsistent_attachment_content");
      attachments.push({ projection: attachment.projection, content });
    }
    const files: ArchiveEntry[] = [
      { path: "README.md", content: Buffer.from(readme) },
      ...attachments.map(({ projection, content }) => ({ path: attachmentPath(projection), content })),
      ...noteTexts.map(({ path, text }) => ({ path, content: Buffer.from(text) })),
      ...taskTexts.map(({ path, text }) => ({ path, content: Buffer.from(text) })),
      ...boardTexts.map(({ path, text }) => ({ path, content: Buffer.from(text) })),
    ].sort(comparePaths);
    const manifestFiles: ManifestEntry[] = files.map(({ path, content }) => ({ path, bytes: content.length, sha256: createHash("sha256").update(content).digest("hex") }));
    files.push({ path: "manifest.json", content: Buffer.from(stableJson({ schema: "stash.portable-workspace-export.v1", workspace: snapshot.workspace, files: manifestFiles })) });
    files.sort(comparePaths);
    const archive = zip(files);
    if (archive.length > this.limits.maxArchiveBytes) throw new Error("archive_size_preflight_mismatch");
    return { status: "exported", archive, filename: `stash-workspace-${workspaceId.slice(0, 8)}.zip` };
  }
}
