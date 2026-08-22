import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { PortableIdentity } from "./workspaces-projects.js";

export type AttachmentSource = "upload" | "paste";
export interface AttachmentRecord { id: string; workspaceId: string; filename: string; contentType: string; size: number; relativePath: string; storageKey: string; source: AttachmentSource; createdByMemberId: string; createdAt: string }
export interface PortableAttachmentProjection { schema: "stash.attachment.v1"; id: string; workspaceId: string; filename: string; contentType: string; size: number; relativePath: string; source: AttachmentSource; createdAt: string; createdBy: PortableIdentity }
export interface AttachmentRepository {
  findPortableMemberIdentity(memberId: string): Promise<PortableIdentity | undefined>;
  canCreateAttachment(memberId: string, workspaceId: string): Promise<boolean>;
  findAttachmentReceipt(memberId: string, workspaceId: string, operationKey: string): Promise<
    { digest: string; record: AttachmentRecord; projection: PortableAttachmentProjection } | undefined>;
  createAttachment(memberId: string, record: AttachmentRecord, projection: PortableAttachmentProjection,
    operation?: { key: string; digest: string }): Promise<{ status: "created" } | { status: "workspace_forbidden" } | { status: "conflict" }
      | { status: "duplicate"; digest: string; record: AttachmentRecord; projection: PortableAttachmentProjection }>;
  findAttachmentForMember(memberId: string, attachmentId: string): Promise<AttachmentRecord | undefined>;
}
export interface AttachmentStorage {
  put(key: string, content: Buffer): Promise<void>;
  get(key: string): Promise<Buffer>;
  getBounded?(key: string, maxBytes: number): Promise<Buffer>;
  delete(key: string): Promise<void>;
}
export class LocalAttachmentStorage implements AttachmentStorage {
  constructor(private readonly root: string) {}
  private path(key: string) { if (!/^[0-9a-f-]+\/[0-9a-f-]+$/i.test(key)) throw new Error("invalid_storage_key"); return join(this.root, ...key.split("/")); }
  async put(key: string, content: Buffer) { const target = this.path(key); await mkdir(dirname(target), { recursive: true }); const temporary = `${target}.${randomUUID()}.tmp`; try { const file = await open(temporary, "wx", 0o600); try { await file.writeFile(content); await file.sync(); } finally { await file.close(); } await rename(temporary, target); } catch (error) { await rm(temporary, { force: true }).catch(() => undefined); throw error; } }
  get(key: string) { return readFile(this.path(key)); }
  async getBounded(key: string, maxBytes: number): Promise<Buffer> {
    const file = await open(this.path(key), "r");
    try {
      const { size } = await file.stat();
      if (!Number.isSafeInteger(size) || size < 0 || size > maxBytes) throw new Error("attachment_size_limit");
      const content = Buffer.alloc(size); let offset = 0;
      while (offset < size) {
        const { bytesRead } = await file.read(content, offset, size - offset, offset);
        if (bytesRead === 0) throw new Error("attachment_truncated");
        offset += bytesRead;
      }
      const probe = Buffer.alloc(1); const { bytesRead } = await file.read(probe, 0, 1, size);
      if (bytesRead !== 0) throw new Error("attachment_size_changed");
      return content;
    } finally { await file.close(); }
  }
  async delete(key: string) { await rm(this.path(key), { force: true }); }
}
export class InvalidAttachment extends Error { constructor(readonly kind: "filename" | "content_type" | "size") { super(kind); } }
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const allowedTypes = /^(image\/(?:png|jpeg|gif|webp|heic|heif)|audio\/(?:mp4|m4a|mpeg|wav|x-wav|aac|3gpp|ogg)|application\/pdf|application\/octet-stream|text\/plain)$/;
const windowsDeviceName = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i;
export function encodePortableFilename(filename: string): string {
  return encodeURIComponent(filename).replace(/[!'()*]/g, (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`);
}
export function portableAttachmentHref(relativePath: string): string {
  return relativePath.replaceAll("%", "%25");
}
export class AttachmentService {
  constructor(private readonly repository: AttachmentRepository, private readonly storage: AttachmentStorage, private readonly limits = { maxBytes: 10 * 1024 * 1024 }) {}
  async create(memberId: string, workspaceId: string, input: { filename: string; contentType: string; source: AttachmentSource; content: Buffer }, operationKey?: string) {
    const encodedFilename = encodePortableFilename(input.filename);
    if (!uuid.test(workspaceId) || !input.filename || input.filename.length > 255 || Buffer.byteLength(encodedFilename) > 255 || input.filename !== input.filename.trim()
      || /[\/\\\u0000-\u001f\u007f]/.test(input.filename) || /[. ]$/.test(input.filename)
      || windowsDeviceName.test(input.filename) || input.filename === "." || input.filename === "..") throw new InvalidAttachment("filename");
    if (!allowedTypes.test(input.contentType)) throw new InvalidAttachment("content_type");
    if (!input.content.length || input.content.length > this.limits.maxBytes) throw new InvalidAttachment("size");
    if (operationKey !== undefined && !uuid.test(operationKey)) throw new InvalidAttachment("filename");
    if (!await this.repository.canCreateAttachment(memberId, workspaceId)) return { status: "workspace_forbidden" as const };
    const createdBy = await this.repository.findPortableMemberIdentity(memberId);
    if (!createdBy) throw new Error("member_identity_unavailable");
    const digest = operationKey ? createHash("sha256").update(JSON.stringify({ filename: input.filename, contentType: input.contentType,
      source: input.source })).update(input.content).digest("hex") : undefined;
    if (operationKey && digest) {
      const existing = await this.repository.findAttachmentReceipt(memberId, workspaceId, operationKey);
      if (existing) return existing.digest === digest
        ? { status: "duplicate" as const, record: existing.record, projection: existing.projection }
        : { status: "conflict" as const };
    }
    const id = randomUUID(); const storageKey = `${workspaceId}/${id}`; const relativePath = `./attachments/${id}/${encodedFilename}`;
    const record: AttachmentRecord = { id, workspaceId, filename: input.filename, contentType: input.contentType, size: input.content.length, relativePath, storageKey, source: input.source, createdByMemberId: memberId, createdAt: new Date().toISOString() };
    const projection: PortableAttachmentProjection = { schema: "stash.attachment.v1", id, workspaceId, filename: record.filename, contentType: record.contentType, size: record.size, relativePath, source: record.source, createdAt: record.createdAt, createdBy };
    await this.storage.put(storageKey, input.content);
    try {
      const result = await this.repository.createAttachment(memberId, record, projection,
        operationKey && digest ? { key: operationKey, digest } : undefined);
      if (result.status !== "created") await this.storage.delete(storageKey);
      if (result.status === "duplicate") return { status: "duplicate" as const, record: result.record, projection: result.projection };
      return result.status === "created" ? { status: "created" as const, record, projection } : result;
    }
    catch (error) { await this.storage.delete(storageKey).catch(() => undefined); throw error; }
  }
  async get(memberId: string, id: string) { if (!uuid.test(id)) return undefined; const record = await this.repository.findAttachmentForMember(memberId, id); return record ? { record, content: await this.storage.get(record.storageKey) } : undefined; }
}
