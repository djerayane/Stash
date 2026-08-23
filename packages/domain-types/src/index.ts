export type EntityId = string;

export interface WorkspaceSummary {
  readonly id: EntityId;
  readonly name: string;
}

export interface ProjectSummary {
  readonly id: EntityId;
  readonly workspaceId: EntityId;
  readonly name: string;
}

export type RichTextMark = "bold" | "italic" | "code";
export interface RichTextSpan { text: string; marks?: RichTextMark[]; href?: string }
export type RichTextBlock =
  | { type: "paragraph" | "quote" | "bullet"; blockKey?: string; id?: string; content: RichTextSpan[] }
  | { type: "heading"; level: 1 | 2 | 3; blockKey?: string; id?: string; content: RichTextSpan[] }
  | { type: "check"; checked: boolean; blockKey?: string; id?: string; content: RichTextSpan[] }
  | { type: "code"; language?: string; blockKey?: string; id?: string; text: string };
export type NoteEditOperation =
  | { id: string; type: "replace_block"; blockKey: string; block: RichTextBlock }
  | { id: string; type: "insert_block"; blockKey: string; afterBlockKey: string | null; block: RichTextBlock }
  | { id: string; type: "delete_block"; blockKey: string };

export interface TaskPlanningUpdate {
  title?: string;
  assigneeIds?: string[];
  priority?: "none" | "low" | "medium" | "high" | "urgent";
  labelNames?: string[];
  linkedNoteIds?: string[];
  dependencies?: Array<{ taskId: string; type: "depends_on" | "required_by" }>;
  developmentLinks?: Array<{ provider: string; url: string; kind: "branch" | "commit" | "pull_request" }>;
  statusId?: string;
  dueDate?: string | null;
  estimate?: number | null;
}

export interface MobileCapturePairing {
  instanceUrl: string;
  memberToken: string;
  workspaceId: string;
  memberId?: string;
}

export interface MobileCaptureOptions {
  projects: { id: string; name: string }[];
  tags: string[];
  reminders: { id: string; label: string; offsetMinutes: number }[];
}

export interface MobileCapture {
  id: string;
  kind: "text" | "checklist" | "photo" | "file" | "voice";
  content: string;
  checklist?: { text: string; checked: boolean }[];
  projectId?: string;
  tags?: string[];
  reminder?: { at: string };
  createdAt: string;
  origin?: { instanceUrl: string; workspaceId: string; memberId?: string };
  attempts: number;
  nextRetryAt?: string;
  lastError?: string;
  source?: "app" | "share_sheet" | "widget";
  attachment?: {
    filename: string;
    contentType: string;
    base64: string;
    remote?: { id: string; portableLink: string };
  };
}

export interface MobileSyncMutationBase {
  id: string;
  origin: { instanceUrl: string; workspaceId: string; memberId: string };
  attempts: number;
  nextRetryAt?: string;
  lastError?: string;
}

export type MobileSyncMutation = MobileSyncMutationBase & (
  | { kind: "note_edit"; noteId: string; baseRevision: number; operations: NoteEditOperation[] }
  | { kind: "task_edit"; projectId: string; taskKey: string; baseRevision: number; changes: TaskPlanningUpdate }
);

export interface IncomingShareDelivery {
  id: string;
  payload: { value: string; shareType: string; mimeType?: string };
  status?: "retry_pending" | "quarantined";
  lastError?: string;
}

export type MobileSyncResult =
  | { status: "synced"; count: number }
  | { status: "offline" | "retry_pending"; count: number }
  | { status: "cancelled"; count: number }
  | { status: "attention_required"; count: number; error: string; retryPending?: boolean };
