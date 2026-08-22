import { createHash } from "node:crypto";

import type { PortableAttachmentProjection } from "./attachments.js";
import type { PortableNoteProjection, PortableTaskProjection } from "./notes.js";
import type { PortableWorkspaceProjection } from "./workspaces-projects.js";

export interface PortableExportAttachment {
  projection: PortableAttachmentProjection;
  content: Buffer;
}

/** A repository must produce this as one permission-filtered, consistent read. */
export interface PortableWorkspaceExportSnapshot {
  workspace: PortableWorkspaceProjection;
  notes: PortableNoteProjection[];
  tasks: PortableTaskProjection[];
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

function noteMarkdown(note: PortableNoteProjection): Buffer {
  const { content, ...properties } = note;
  // Notes live one directory below the archive root; make root-relative Attachment links remain valid.
  const portableContent = content.replaceAll("(<./attachments/", "(<../attachments/");
  return Buffer.from(`---\n${metadata(properties)}\n---\n\n${portableContent.trimEnd()}\n`);
}

function taskMarkdown(task: PortableTaskProjection): Buffer {
  const { title, ...properties } = task;
  return Buffer.from(`---\n${metadata(properties)}\n---\n\n# ${task.key} — ${title}\n`);
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

export class PortableWorkspaceExportService {
  constructor(private readonly repository: PortableWorkspaceExportRepository) {}

  async export(memberId: string, workspaceId: string): Promise<PortableWorkspaceExportOutcome> {
    if (!uuid.test(workspaceId)) throw new InvalidPortableWorkspaceExport();
    const result = await this.repository.readExportSnapshot(memberId, workspaceId);
    if (result.status !== "found") return result;
    const { snapshot } = result;
    if (snapshot.workspace.id !== workspaceId || snapshot.notes.some((note) => note.workspaceId !== workspaceId)
      || snapshot.tasks.some((task) => task.workspaceId !== workspaceId)
      || snapshot.attachments.some(({ projection, content }) => projection.workspaceId !== workspaceId || projection.size !== content.length)) {
      throw new Error("inconsistent_export_snapshot");
    }
    const files: ArchiveEntry[] = [
      { path: "README.md", content: Buffer.from("# Stash Portable Workspace Export\n\nFormat: `stash.portable-workspace-export.v1`\n\nNotes and Tasks are readable Markdown. `manifest.json` contains the Workspace identity, file checksums, and the schemas needed by importers. Attachment paths and bytes are preserved exactly.\n") },
      ...snapshot.attachments.map(({ projection, content }) => ({ path: attachmentPath(projection), content })),
      ...snapshot.notes.map((note) => ({ path: `notes/${note.id}.md`, content: noteMarkdown(note) })),
      ...snapshot.tasks.map((task) => ({ path: `tasks/${task.key}--${task.id}.md`, content: taskMarkdown(task) })),
    ].sort(comparePaths);
    const seen = new Set<string>();
    if (files.some(({ path }) => !isSafeArchivePath(path) || seen.has(path) || !seen.add(path))) throw new Error("invalid_export_path");
    const manifestFiles: ManifestEntry[] = files.map(({ path, content }) => ({ path, bytes: content.length, sha256: createHash("sha256").update(content).digest("hex") }));
    files.push({ path: "manifest.json", content: Buffer.from(stableJson({ schema: "stash.portable-workspace-export.v1", workspace: snapshot.workspace, files: manifestFiles })) });
    files.sort(comparePaths);
    return { status: "exported", archive: zip(files), filename: `stash-workspace-${workspaceId.slice(0, 8)}.zip` };
  }
}
