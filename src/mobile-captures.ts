import { createHash, randomUUID } from "node:crypto";
import { normalizeExplicitOffsetTimestamp } from "./explicit-offset-timestamp.js";
import type { NoteRecord, PortableNoteProjection } from "./notes.js";
import { isUuid, type MobileCaptureOptions } from "./mobile-capture-client.js";

export interface MobileCaptureRepository {
  findPortableMemberIdentity(memberId: string): Promise<PortableNoteProjection["createdBy"] | undefined>;
  createMobileCapture(memberId: string, clientCaptureId: string, payloadDigest: string, note: NoteRecord, projection: PortableNoteProjection): Promise<
    { status: "created" | "duplicate"; noteId: string } | { status: "workspace_forbidden" | "project_forbidden" | "conflict" }
  >;
  listMobileCaptureOptions(memberId: string, workspaceId: string): Promise<
    { status: "found"; projects: { id: string; name: string }[]; tags: string[] } | { status: "workspace_forbidden" }
  >;
}

export class InvalidMobileCapture extends Error {}

export class MobileCaptureService {
  constructor(readonly repository: MobileCaptureRepository) {}

  async capture(memberId: string, workspaceId: string, value: unknown) {
    if (!isObject(value) || value.protocol !== "stash.mobile-capture.v1" || typeof value.id !== "string" || !isUuid(value.id)
      || !isUuid(workspaceId) || (value.kind !== "text" && value.kind !== "checklist")
      || typeof value.content !== "string" || !value.content.trim() || typeof value.createdAt !== "string"
      || !normalizeExplicitOffsetTimestamp(value.createdAt) || !validStructure(value)) throw new InvalidMobileCapture();
    if (value.kind === "checklist") {
      if (!Array.isArray(value.checklist) || !value.checklist.length || value.checklist.some((item) =>
        !isObject(item) || typeof item.text !== "string" || !item.text.trim() || typeof item.checked !== "boolean")) throw new InvalidMobileCapture();
    }
    const normalizedContent = value.content.trim();
    const checklist = value.kind === "checklist" ? (value.checklist as { text: string; checked: boolean }[]).map((item) => ({
      text: item.text.trim(), checked: item.checked,
    })) : undefined;
    const content = checklist
      ? `${normalizedContent}\n\n${checklist.map((item) => `- [${item.checked ? "x" : " "}] ${item.text}`).join("\n")}`
      : normalizedContent;
    const tags = [...new Set(((value.tags ?? []) as string[]).map((tag) => tag.trim()))].sort();
    const reminderAt = value.reminder ? normalizeExplicitOffsetTimestamp(value.reminder.at)! : undefined;
    const payloadDigest = createHash("sha256").update(JSON.stringify({
      kind: value.kind,
      content: normalizedContent,
      ...(checklist ? { checklist } : {}),
      projectId: value.projectId ?? null,
      tags,
      reminder: reminderAt ? { at: reminderAt } : null,
    })).digest("hex");
    const createdBy = await this.repository.findPortableMemberIdentity(memberId);
    if (!createdBy) throw new Error("member_identity_unavailable");
    const note: NoteRecord = {
      id: randomUUID(), workspaceId, content,
      tags,
      createdByMemberId: memberId, createdAt: normalizeExplicitOffsetTimestamp(value.createdAt)!,
      ...(value.projectId ? { projectId: value.projectId } : {}),
      ...(reminderAt ? { reminder: { at: reminderAt } } : {}),
    };
    const projection: PortableNoteProjection = {
      schema: "stash.note.v1", id: note.id, workspaceId, content, tags: note.tags, createdAt: note.createdAt, createdBy,
      ...(note.projectId ? { projectId: note.projectId } : {}), ...(note.reminder ? { reminder: note.reminder } : {}),
    };
    return this.repository.createMobileCapture(memberId, value.id, payloadDigest, note, projection);
  }

  async options(memberId: string, workspaceId: string): Promise<
    { status: "found"; options: MobileCaptureOptions } | { status: "workspace_forbidden" }
  > {
    if (!isUuid(workspaceId)) throw new InvalidMobileCapture();
    const result = await this.repository.listMobileCaptureOptions(memberId, workspaceId);
    return result.status === "found" ? { status: "found", options: {
      projects: result.projects,
      tags: result.tags,
      reminders: [
        { id: "hour", label: "In one hour", offsetMinutes: 60 },
        { id: "tomorrow", label: "Tomorrow", offsetMinutes: 1_440 },
        { id: "week", label: "In one week", offsetMinutes: 10_080 },
      ],
    } } : result;
  }
}

function isObject(value: unknown): value is Record<string, any> { return value !== null && typeof value === "object" && !Array.isArray(value); }
function validStructure(value: Record<string, any>) {
  if (value.projectId !== undefined && (typeof value.projectId !== "string" || !isUuid(value.projectId))) return false;
  if (value.tags !== undefined && (!Array.isArray(value.tags) || value.tags.some((tag: unknown) => typeof tag !== "string" || !tag.trim()))) return false;
  if (value.reminder !== undefined && (!isObject(value.reminder) || typeof value.reminder.at !== "string" || !normalizeExplicitOffsetTimestamp(value.reminder.at))) return false;
  return Object.keys(value).every((key) => ["protocol", "id", "kind", "content", "checklist", "projectId", "tags", "reminder", "createdAt"].includes(key));
}
