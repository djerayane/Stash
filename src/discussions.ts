import { randomUUID } from "node:crypto";

import type { PortableIdentity } from "./workspaces-projects.js";

export type DiscussionTarget =
  | { kind: "note"; noteId: string }
  | { kind: "task"; taskId: string }
  | { kind: "block"; noteId: string; blockId: string; state?: "attached" | "block_missing" | "ambiguous" };
export type DiscussionDraftTarget = Exclude<DiscussionTarget, { kind: "block" }>
  | { kind: "block"; noteId: string; blockKey: string };
export type PortableDiscussionTarget = Exclude<DiscussionTarget, { kind: "block" }>
  | { kind: "block"; noteId: string; blockId: string };

export interface DiscussionMessage {
  id: string;
  content: string;
  author: PortableIdentity;
  createdAt: string;
}

export interface DiscussionRecord {
  id: string;
  workspaceId: string;
  target: DiscussionTarget;
  messages: DiscussionMessage[];
  createdAt: string;
  resolvedAt?: string;
}
export type DiscussionDraft = Omit<DiscussionRecord, "target"> & { target: DiscussionDraftTarget };

export interface PortableDiscussionProjection {
  schema: "stash.discussion.v1";
  id: string;
  workspaceId: string;
  target: PortableDiscussionTarget;
  messages: DiscussionMessage[];
  createdAt: string;
  resolvedAt?: string;
}

export type CreateDiscussionOutcome =
  | { status: "created"; discussion: DiscussionRecord; projection: PortableDiscussionProjection }
  | { status: "target_not_found" | "ambiguous_block" | "forbidden" };
export type FindDiscussionOutcome = { status: "found"; discussion: DiscussionRecord } | { status: "not_found" };
export type AddDiscussionMessageOutcome =
  | { status: "updated"; discussion: DiscussionRecord; projection: PortableDiscussionProjection }
  | { status: "not_found" | "resolved" | "forbidden" };
export type ResolveDiscussionOutcome =
  | { status: "resolved"; discussion: DiscussionRecord; projection: PortableDiscussionProjection }
  | { status: "already_resolved"; discussion: DiscussionRecord }
  | { status: "not_found" | "forbidden" };

export interface DiscussionRepository {
  findPortableMemberIdentity(memberId: string): Promise<PortableIdentity | undefined>;
  createDiscussion(memberId: string, draft: DiscussionDraft): Promise<CreateDiscussionOutcome>;
  findDiscussion(memberId: string, discussionId: string): Promise<FindDiscussionOutcome>;
  listNoteDiscussions(memberId: string, noteId: string): Promise<{ status: "found"; discussions: DiscussionRecord[] } | { status: "not_found" }>;
  listTaskDiscussions(memberId: string, taskId: string): Promise<{ status: "found"; discussions: DiscussionRecord[] } | { status: "not_found" }>;
  addMessage(memberId: string, discussionId: string, message: DiscussionMessage): Promise<AddDiscussionMessageOutcome>;
  resolveDiscussion(memberId: string, discussionId: string, resolvedAt: string): Promise<ResolveDiscussionOutcome>;
}

export class InvalidDiscussionInput extends Error {}

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const plainObject = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);

function validContent(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0 && value.trim().length <= 20_000;
}

function parseTarget(value: unknown): DiscussionDraftTarget | undefined {
  if (!plainObject(value) || typeof value.kind !== "string") return undefined;
  if (value.kind === "note" && typeof value.noteId === "string" && uuid.test(value.noteId)
    && Object.keys(value).every((key) => key === "kind" || key === "noteId")) return { kind: "note", noteId: value.noteId };
  if (value.kind === "task" && typeof value.taskId === "string" && uuid.test(value.taskId)
    && Object.keys(value).every((key) => key === "kind" || key === "taskId")) return { kind: "task", taskId: value.taskId };
  if (value.kind === "block" && typeof value.noteId === "string" && uuid.test(value.noteId)
    && typeof value.blockKey === "string" && uuid.test(value.blockKey)
    && Object.keys(value).every((key) => ["kind", "noteId", "blockKey"].includes(key)))
    return { kind: "block", noteId: value.noteId, blockKey: value.blockKey };
  return undefined;
}

export class DiscussionService {
  constructor(private readonly repository: DiscussionRepository) {}

  async create(memberId: string, value: unknown): Promise<CreateDiscussionOutcome> {
    if (!plainObject(value) || !Object.keys(value).every((key) => key === "target" || key === "message")
      || Object.keys(value).length !== 2 || !validContent(value.message)) throw new InvalidDiscussionInput();
    const target = parseTarget(value.target);
    if (!target) throw new InvalidDiscussionInput();
    const author = await this.repository.findPortableMemberIdentity(memberId);
    if (!author) throw new Error("member_identity_unavailable");
    const createdAt = new Date().toISOString();
    return this.repository.createDiscussion(memberId, {
      id: randomUUID(), workspaceId: "", target, createdAt,
      messages: [{ id: randomUUID(), content: value.message.trim(), author, createdAt }],
    });
  }

  async get(memberId: string, discussionId: string): Promise<FindDiscussionOutcome> {
    if (!uuid.test(discussionId)) throw new InvalidDiscussionInput();
    return this.repository.findDiscussion(memberId, discussionId);
  }

  async listForNote(memberId: string, noteId: string) {
    if (!uuid.test(noteId)) throw new InvalidDiscussionInput();
    return this.repository.listNoteDiscussions(memberId, noteId);
  }

  async listForTask(memberId: string, taskId: string) {
    if (!uuid.test(taskId)) throw new InvalidDiscussionInput();
    return this.repository.listTaskDiscussions(memberId, taskId);
  }

  async reply(memberId: string, discussionId: string, value: unknown): Promise<AddDiscussionMessageOutcome> {
    if (!uuid.test(discussionId) || !plainObject(value) || Object.keys(value).length !== 1 || !validContent(value.content))
      throw new InvalidDiscussionInput();
    const author = await this.repository.findPortableMemberIdentity(memberId);
    if (!author) throw new Error("member_identity_unavailable");
    return this.repository.addMessage(memberId, discussionId, {
      id: randomUUID(), content: value.content.trim(), author, createdAt: new Date().toISOString(),
    });
  }

  async resolve(memberId: string, discussionId: string, value: unknown): Promise<ResolveDiscussionOutcome> {
    if (!uuid.test(discussionId) || !plainObject(value) || Object.keys(value).length !== 0) throw new InvalidDiscussionInput();
    return this.repository.resolveDiscussion(memberId, discussionId, new Date().toISOString());
  }
}
