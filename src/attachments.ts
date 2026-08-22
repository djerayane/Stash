import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { PortableIdentity } from "./workspaces-projects.js";

export type AttachmentSource = "upload" | "paste";
export interface AttachmentRecord { id: string; workspaceId: string; filename: string; contentType: string; size: number; relativePath: string; storageKey: string; source: AttachmentSource; createdByMemberId: string; createdAt: string }
export interface PortableAttachmentProjection { schema: "stash.attachment.v1"; id: string; workspaceId: string; filename: string; contentType: string; size: number; relativePath: string; source: AttachmentSource; createdAt: string; createdBy: PortableIdentity }
export interface AttachmentRepository {
  findPortableMemberIdentity(memberId: string): Promise<PortableIdentity | undefined>;
  canCreateAttachment(memberId: string, workspaceId: string): Promise<boolean>;
  createAttachment(memberId: string, record: AttachmentRecord, projection: PortableAttachmentProjection): Promise<"created" | "workspace_forbidden">;
  findAttachmentForMember(memberId: string, attachmentId: string): Promise<AttachmentRecord | undefined>;
}
export interface AttachmentStorage {
  put(key: string, content: Buffer): Promise<void>;
  get(key: string): Promise<Buffer>;
  delete(key: string): Promise<void>;
}
export class LocalAttachmentStorage implements AttachmentStorage {
  constructor(private readonly root: string) {}
  private path(key: string) { if (!/^[0-9a-f-]+\/[0-9a-f-]+$/i.test(key)) throw new Error("invalid_storage_key"); return join(this.root, ...key.split("/")); }
  async put(key: string, content: Buffer) { const target = this.path(key); await mkdir(dirname(target), { recursive: true }); const temporary = `${target}.${randomUUID()}.tmp`; try { const file = await open(temporary, "wx", 0o600); try { await file.writeFile(content); await file.sync(); } finally { await file.close(); } await rename(temporary, target); } catch (error) { await rm(temporary, { force: true }).catch(() => undefined); throw error; } }
  get(key: string) { return readFile(this.path(key)); }
  async delete(key: string) { await rm(this.path(key), { force: true }); }
}
export class InvalidAttachment extends Error { constructor(readonly kind: "filename" | "content_type" | "size") { super(kind); } }
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const allowedTypes = /^(image\/(?:png|jpeg|gif|webp)|audio\/(?:mp4|m4a|mpeg|wav|x-wav)|application\/pdf|application\/octet-stream|text\/plain)$/;
const windowsDeviceName = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i;
export function encodePortableFilename(filename: string): string {
  return encodeURIComponent(filename).replace(/[!'()*]/g, (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`);
}
export function portableAttachmentHref(relativePath: string): string {
  return relativePath.replaceAll("%", "%25");
}
export class AttachmentService {
  constructor(private readonly repository: AttachmentRepository, private readonly storage: AttachmentStorage, private readonly limits = { maxBytes: 10 * 1024 * 1024 }) {}
  async create(memberId: string, workspaceId: string, input: { filename: string; contentType: string; source: AttachmentSource; content: Buffer }) {
    const encodedFilename = encodePortableFilename(input.filename);
    if (!uuid.test(workspaceId) || !input.filename || input.filename.length > 255 || Buffer.byteLength(encodedFilename) > 255 || input.filename !== input.filename.trim()
      || /[\/\\\u0000-\u001f\u007f]/.test(input.filename) || /[. ]$/.test(input.filename)
      || windowsDeviceName.test(input.filename) || input.filename === "." || input.filename === "..") throw new InvalidAttachment("filename");
    if (!allowedTypes.test(input.contentType)) throw new InvalidAttachment("content_type");
    if (!input.content.length || input.content.length > this.limits.maxBytes) throw new InvalidAttachment("size");
    if (!await this.repository.canCreateAttachment(memberId, workspaceId)) return { status: "workspace_forbidden" as const };
    const createdBy = await this.repository.findPortableMemberIdentity(memberId);
    if (!createdBy) throw new Error("member_identity_unavailable");
    const id = randomUUID(); const storageKey = `${workspaceId}/${id}`; const relativePath = `./attachments/${id}/${encodedFilename}`;
    const record: AttachmentRecord = { id, workspaceId, filename: input.filename, contentType: input.contentType, size: input.content.length, relativePath, storageKey, source: input.source, createdByMemberId: memberId, createdAt: new Date().toISOString() };
    const projection: PortableAttachmentProjection = { schema: "stash.attachment.v1", id, workspaceId, filename: record.filename, contentType: record.contentType, size: record.size, relativePath, source: record.source, createdAt: record.createdAt, createdBy };
    await this.storage.put(storageKey, input.content);
    try { const status = await this.repository.createAttachment(memberId, record, projection); if (status !== "created") await this.storage.delete(storageKey); return status === "created" ? { status, record, projection } : { status }; }
    catch (error) { await this.storage.delete(storageKey).catch(() => undefined); throw error; }
  }
  async get(memberId: string, id: string) { if (!uuid.test(id)) return undefined; const record = await this.repository.findAttachmentForMember(memberId, id); return record ? { record, content: await this.storage.get(record.storageKey) } : undefined; }
}
