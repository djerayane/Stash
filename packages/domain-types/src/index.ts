export type EntityId = string;

export const agentGrantModes = ["direct", "propose", "deny"] as const;
export const agentGrantCapabilities = ["note.read", "note.write", "task.read", "task.write"] as const;
export type AgentGrantMode = (typeof agentGrantModes)[number];
export type AgentGrantCapability = (typeof agentGrantCapabilities)[number];
export interface AgentGrantScope { readonly capability: AgentGrantCapability; readonly mode: AgentGrantMode }
export interface AgentGrant {
  id: string; organizationId: string; sponsoringMemberId: string; name: string;
  projectId?: string; scopes: AgentGrantScope[]; expiresAt: string; createdAt: string; revokedAt?: string;
}
export interface AgentGrantOption { readonly organizationId: string; readonly organizationName: string; readonly projects: ReadonlyArray<{ id: string; name: string }> }
export interface CreateAgentGrantRequest { readonly organizationId: string; readonly projectId?: string; readonly name: string; readonly scopes: AgentGrantScope[]; readonly expiresAt: string }
export interface CreateAgentGrantResponse { readonly status: "created"; readonly grant: AgentGrant; readonly token: string }
export interface RevokeAgentGrantResponse { readonly grantId: string; readonly revoked: true }
export interface AgentProposal { readonly id: string; readonly grantId: string; readonly sponsoringMemberId: string; readonly capability: AgentGrantCapability; readonly input: unknown; readonly createdAt: string; readonly status: "pending" }

export interface WorkspaceSummary {
  readonly id: EntityId;
  readonly name: string;
}

export interface ProjectSummary {
  readonly id: EntityId;
  readonly workspaceId: EntityId;
  readonly name: string;
}

export interface PortableIdentity { readonly localAccountId: string; readonly displayName: string }
export type ActivityCause =
  | { readonly kind: "member"; readonly restorationOfRevision?: number; readonly automationId?: string; readonly signalId?: string }
  | { readonly kind: "automation"; readonly automationId: string; readonly signalId?: string }
  | { readonly kind: "signal"; readonly signalId: string }
  | { readonly kind: "agent"; readonly agentGrantId: string; readonly sponsoringMemberId: string; readonly agentName?: string }
  | { readonly kind: "migration"; readonly source: "existing_note" };
export interface ActivityRecord {
  readonly schema: "stash.activity.v1";
  readonly id: string;
  readonly workspaceId: string;
  readonly object: { readonly kind: "Note" | "Task" | "Discussion" | "NoteLocation" | "NoteLink"; readonly id: string };
  readonly action: string;
  readonly actor: PortableIdentity;
  readonly cause: ActivityCause;
  readonly occurredAt: string;
  readonly before: Record<string, unknown>;
  readonly after: Record<string, unknown>;
}
export type NotificationTrigger = "direct_mention" | "assignment" | "requested_review" | "automation_failure" | "followed_change";
export interface NotificationDelivery {
  schema: "stash.notification.v1";
  id: string;
  memberId: string;
  workspaceId: string;
  projectId?: string;
  trigger: NotificationTrigger;
  summary: string;
  activity: ActivityRecord;
  createdAt: string;
  delivery: "immediate" | "quiet_hours";
  readAt?: string;
  digestedAt?: string;
}

export type RichTextMark = "bold" | "italic" | "code";
export interface RichTextSpan { text: string; marks?: RichTextMark[]; href?: string }
export interface RichTextTableCell { header: boolean; content: RichTextSpan[] }
export interface RichTextListItem { blockKey?: string; id?: string; content: RichTextSpan[]; checked?: boolean; children?: RichTextList[] }
export interface RichTextList { type: "bullet" | "check"; items: RichTextListItem[] }
export interface RichTextCalloutParagraph { blockKey?: string; id?: string; content: RichTextSpan[] }
export type RichTextBlock =
  | { type: "paragraph" | "quote"; blockKey?: string; id?: string; content: RichTextSpan[] }
  | { type: "bullet"; blockKey?: string; id?: string; content: RichTextSpan[]; children?: RichTextList[] }
  | { type: "check"; blockKey?: string; id?: string; content: RichTextSpan[]; checked: boolean; children?: RichTextList[] }
  | { type: "heading"; level: 1 | 2 | 3; blockKey?: string; id?: string; content: RichTextSpan[] }
  | { type: "code"; language?: string; blockKey?: string; id?: string; text: string }
  | { type: "callout"; kind: "note" | "tip" | "warning"; blockKey?: string; id?: string; paragraphs: RichTextCalloutParagraph[] }
  | { type: "attachment"; href: string; label: string; blockKey?: string; id?: string }
  | { type: "image"; src: string; alt: string; title?: string; blockKey?: string; id?: string }
  | { type: "table"; rows: RichTextTableCell[][]; blockKey?: string; id?: string };
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

export type AutomationTrigger = "branch_created" | "pull_request_completed";
export interface AutomationRecipe {
  id: string;
  trigger: AutomationTrigger;
  targetStatus: { id: string; name: string };
  enabled: boolean;
}
export interface AutomationTransition {
  id: string;
  automationId: string;
  signalId: string;
  before: { id: string; name: string };
  after: { id: string; name: string };
  occurredAt: string;
  reversedAt?: string;
}
export interface AutomationState {
  recipes: AutomationRecipe[];
  transitions: AutomationTransition[];
  availableStatuses: Array<{ id: string; name: string }>;
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
