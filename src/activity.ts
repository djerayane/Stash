import type { RichTextDocument } from "./rich-text.js";
import type { PortableIdentity } from "./workspaces-projects.js";
import type { ActivityCause, ActivityRecord } from "@stash/domain-types";
export type { ActivityCause, ActivityRecord } from "@stash/domain-types";

export interface NoteHistoryRevision {
  noteId: string;
  workspaceId: string;
  revision: number;
  content: string;
  document: RichTextDocument;
  recordedAt: string;
  actor: PortableIdentity;
  cause: ActivityCause;
}

export type RestoreNoteOutcome =
  | { status: "restored" | "duplicate"; note: { revision: number; content: string; document: RichTextDocument }; activity: ActivityRecord }
  | { status: "not_found" | "revision_not_found" | "idempotency_conflict" }
  | { status: "revision_conflict"; currentRevision: number };

export interface ActivityRepository {
  listWorkspaceActivity(memberId: string, workspaceId: string): Promise<
    { status: "found"; activities: ActivityRecord[] } | { status: "forbidden" }
  >;
  listNoteHistory(memberId: string, noteId: string): Promise<
    { status: "found"; revisions: NoteHistoryRevision[] } | { status: "not_found" }
  >;
  restoreNote(memberId: string, noteId: string, targetRevision: number, expectedRevision: number,
    idempotencyKey: string): Promise<RestoreNoteOutcome>;
}

export class InvalidActivityInput extends Error {}
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const plainObject = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);

export class ActivityService {
  constructor(private readonly repository: ActivityRepository) {}

  async listWorkspace(memberId: string, workspaceId: string) {
    if (!uuid.test(workspaceId)) throw new InvalidActivityInput();
    return this.repository.listWorkspaceActivity(memberId, workspaceId);
  }

  async listNoteHistory(memberId: string, noteId: string) {
    if (!uuid.test(noteId)) throw new InvalidActivityInput();
    return this.repository.listNoteHistory(memberId, noteId);
  }

  async restoreNote(memberId: string, noteId: string, targetRevisionValue: string, value: unknown) {
    const targetRevision = Number(targetRevisionValue);
    if (!uuid.test(noteId) || !Number.isSafeInteger(targetRevision) || targetRevision < 1 || !plainObject(value)
      || !Number.isSafeInteger(value.expectedRevision) || (value.expectedRevision as number) < 1
      || typeof value.idempotencyKey !== "string" || !uuid.test(value.idempotencyKey)
      || Object.keys(value).length !== 2
      || !Object.keys(value).every((key) => key === "expectedRevision" || key === "idempotencyKey")) {
      throw new InvalidActivityInput();
    }
    return this.repository.restoreNote(memberId, noteId, targetRevision, value.expectedRevision as number, value.idempotencyKey);
  }
}
