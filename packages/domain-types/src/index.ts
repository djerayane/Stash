export * from "./visualizations.js";
export * from "./collections.js";
import { normalizeCollection, normalizeViewBlock, type Collection, type ViewBlock } from "./collections.js";

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
export const directAuthorityConfirmation = "I authorize this agent to use Direct capabilities without Proposal review" as const;
export interface CreateAgentGrantRequest { readonly organizationId: string; readonly projectId?: string; readonly name: string; readonly scopes: AgentGrantScope[]; readonly expiresAt: string; readonly directAuthorityConfirmation?: typeof directAuthorityConfirmation }
export interface CreateAgentGrantResponse { readonly status: "created"; readonly grant: AgentGrant; readonly token: string }
export interface RevokeAgentGrantResponse { readonly grantId: string; readonly revoked: true }
export type AgentProposalStatus = "pending" | "applying" | "applied" | "rejected" | "conflict";
export interface AgentProposalConflict { readonly id: string; readonly fields: readonly string[]; readonly currentRevision: number }
export interface AgentProposal { readonly id: string; readonly grantId: string; readonly organizationId: string; readonly sponsoringMemberId: string;
  readonly agentName: string; readonly projectId?: string; readonly capability: AgentGrantCapability; readonly input: unknown;
  readonly baseRevision?: number; readonly createdAt: string; readonly status: AgentProposalStatus; readonly operationId?: string;
  readonly reviewedAt?: string; readonly reviewedByMemberId?: string; readonly result?: unknown; readonly conflict?: AgentProposalConflict }
export interface ReviewAgentProposalRequest { readonly operationId: string; readonly decision: "apply" | "reject" | "keep_current" | "apply_contribution"; readonly confirmed: true }
export interface ReviewAgentProposalResponse { readonly status: "applied" | "rejected" | "conflict" | "duplicate"; readonly proposal: AgentProposal }

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
  readonly object: { readonly kind: "Note" | "Task" | "Discussion" | "NoteLocation" | "NoteLink" | "Proposal" | "VisualizationBlock"; readonly id: string };
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
  | { kind: "canonical_task_edit"; taskId: string; baseRevision: number; changes: TaskPlanningUpdate }
);

export interface MobileNoteTreeNode {
  id: string; workspaceId: string; parentId?: string; title: string; position: string; childCount: number;
}
export interface MobileNoteReadModel {
  id: string; workspaceId: string; title: string; content: string; revision: number; document?: { type: "doc"; blocks: RichTextBlock[] };
}
export interface MobileCanonicalTask {
  schema: "stash.task.v1"; id: string; workspaceId: string; title: string; description: string; revision?: number;
  status: { id: string; name: string; category: string; position: number }; assigneeIds: string[];
  projectKeys: Array<{ projectId: string; key: string }>; sourceNoteIds: string[];
}
export interface MobileWorkspaceWorkflow {
  schema: "stash.workspace-workflow.v1"; workspaceId: string;
  statuses: Array<{ id: string; name: string; category: string; position: number }>;
}
export interface MobileSearchEntry {
  id: string; kind: "note" | "task" | "collection"; title: string; excerpt?: string;
}
export interface MobileWorkspaceSnapshot {
  schema: "stash.mobile-workspace.v1"; workspaceId: string; refreshedAt: string;
  noteTree: MobileNoteTreeNode[]; notes: MobileNoteReadModel[]; tasks: MobileCanonicalTask[];
  workflow: MobileWorkspaceWorkflow; collections: Collection[]; viewBlocks: ViewBlock[]; search: MobileSearchEntry[];
}

const mobileUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const mobileObject = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === "object" && !Array.isArray(value);
const mobileExact = (value: Record<string, unknown>, required: readonly string[], optional: readonly string[] = []) => {
  const allowed = new Set([...required, ...optional]); return required.every((key) => Object.hasOwn(value, key))
    && Object.keys(value).every((key) => allowed.has(key));
};
function invalidMobileSnapshot(): never { throw new Error("invalid_mobile_workspace_snapshot"); }
function mobileString(value: unknown, maximum = 20_000) {
  if (typeof value !== "string" || value.length > maximum) invalidMobileSnapshot(); return value;
}
function mobileIdentity(value: unknown) { if (typeof value !== "string" || !mobileUuid.test(value)) invalidMobileSnapshot(); return value.toLowerCase(); }

export function normalizeMobileWorkspaceSnapshot(value: unknown): MobileWorkspaceSnapshot {
  if (!mobileObject(value) || !mobileExact(value, ["schema", "workspaceId", "refreshedAt", "noteTree", "notes", "tasks", "workflow", "collections", "viewBlocks", "search"])
    || value.schema !== "stash.mobile-workspace.v1" || !Array.isArray(value.noteTree) || !Array.isArray(value.notes)
    || !Array.isArray(value.tasks) || !Array.isArray(value.collections) || !Array.isArray(value.viewBlocks) || !Array.isArray(value.search)
    || typeof value.refreshedAt !== "string" || !Number.isFinite(Date.parse(value.refreshedAt))) invalidMobileSnapshot();
  const workspaceId = mobileIdentity(value.workspaceId);
  const noteTree = value.noteTree.map((entry): MobileNoteTreeNode => {
    if (!mobileObject(entry) || !mobileExact(entry, ["id", "workspaceId", "title", "position", "childCount"], ["parentId"])
      || mobileIdentity(entry.workspaceId) !== workspaceId || !Number.isInteger(entry.childCount) || Number(entry.childCount) < 0) invalidMobileSnapshot();
    return { id: mobileIdentity(entry.id), workspaceId, title: mobileString(entry.title, 240), position: mobileString(entry.position, 240),
      childCount: Number(entry.childCount), ...(entry.parentId === undefined ? {} : { parentId: mobileIdentity(entry.parentId) }) };
  });
  const notes = value.notes.map((entry): MobileNoteReadModel => {
    if (!mobileObject(entry) || !mobileExact(entry, ["id", "workspaceId", "title", "content", "revision"], ["document"])
      || mobileIdentity(entry.workspaceId) !== workspaceId || !Number.isInteger(entry.revision) || Number(entry.revision) < 1
      || entry.document !== undefined && (!mobileObject(entry.document) || entry.document.type !== "doc" || !Array.isArray(entry.document.blocks))) invalidMobileSnapshot();
    return { id: mobileIdentity(entry.id), workspaceId, title: mobileString(entry.title, 240), content: mobileString(entry.content), revision: Number(entry.revision),
      ...(entry.document === undefined ? {} : { document: structuredClone(entry.document) as NonNullable<MobileNoteReadModel["document"]> }) };
  });
  if (!mobileObject(value.workflow) || !mobileExact(value.workflow, ["schema", "workspaceId", "statuses"])
    || value.workflow.schema !== "stash.workspace-workflow.v1" || mobileIdentity(value.workflow.workspaceId) !== workspaceId || !Array.isArray(value.workflow.statuses)) invalidMobileSnapshot();
  const statuses = value.workflow.statuses.map((status) => {
    if (!mobileObject(status) || !mobileExact(status, ["id", "name", "category", "position"]) || !Number.isInteger(status.position)
      || Number(status.position) < 1 || !["unstarted", "started", "completed", "canceled"].includes(String(status.category))) invalidMobileSnapshot();
    return { id: mobileIdentity(status.id), name: mobileString(status.name, 120), category: String(status.category), position: Number(status.position) };
  });
  const tasks = value.tasks.map((task): MobileCanonicalTask => {
    if (!mobileObject(task) || !mobileExact(task, ["schema", "id", "workspaceId", "title", "description", "status", "assigneeIds", "projectKeys", "sourceNoteIds"], ["revision"])
      || task.schema !== "stash.task.v1" || mobileIdentity(task.workspaceId) !== workspaceId || task.revision !== undefined && (!Number.isInteger(task.revision) || Number(task.revision) < 1)
      || !mobileObject(task.status) || !mobileExact(task.status, ["id", "name", "category", "position"])
      || !Array.isArray(task.assigneeIds) || !Array.isArray(task.projectKeys) || !Array.isArray(task.sourceNoteIds)) invalidMobileSnapshot();
    const taskStatus = task.status as Record<string, unknown>;
    const status = statuses.find(({ id }) => id === mobileIdentity(taskStatus.id)); if (!status) invalidMobileSnapshot();
    const projectKeys = task.projectKeys.map((key) => { if (!mobileObject(key) || !mobileExact(key, ["projectId", "key"]) || typeof key.key !== "string" || !/^[A-Za-z][A-Za-z0-9-]{1,19}-[1-9][0-9]*$/.test(key.key)) invalidMobileSnapshot();
      return { projectId: mobileIdentity(key.projectId), key: key.key.toUpperCase() }; });
    return { schema: "stash.task.v1", id: mobileIdentity(task.id), workspaceId, title: mobileString(task.title, 500), description: mobileString(task.description), status,
      assigneeIds: task.assigneeIds.map(mobileIdentity), projectKeys, sourceNoteIds: task.sourceNoteIds.map(mobileIdentity),
      ...(task.revision === undefined ? {} : { revision: Number(task.revision) }) };
  });
  let collections: Collection[]; let viewBlocks: ViewBlock[];
  try { collections = value.collections.map(normalizeCollection); viewBlocks = value.viewBlocks.map(normalizeViewBlock); } catch { invalidMobileSnapshot(); }
  if (collections.some((entry) => entry.workspaceId !== workspaceId) || viewBlocks.some((entry) => entry.workspaceId !== workspaceId)) invalidMobileSnapshot();
  const search = value.search.map((entry): MobileSearchEntry => {
    if (!mobileObject(entry) || !mobileExact(entry, ["id", "kind", "title"], ["excerpt"]) || !["note", "task", "collection"].includes(String(entry.kind))) invalidMobileSnapshot();
    return { id: mobileIdentity(entry.id), kind: entry.kind as MobileSearchEntry["kind"], title: mobileString(entry.title, 500),
      ...(entry.excerpt === undefined ? {} : { excerpt: mobileString(entry.excerpt, 240) }) };
  });
  return { schema: "stash.mobile-workspace.v1", workspaceId, refreshedAt: new Date(value.refreshedAt).toISOString(), noteTree, notes, tasks,
    workflow: { schema: "stash.workspace-workflow.v1", workspaceId, statuses }, collections, viewBlocks, search };
}

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

export interface MemberLocalizationSettings { locale: string; timeZone: string; dateFormat: "short" | "medium" | "long"; weekStartsOn: "sunday" | "monday" | "saturday"; updatedAt?: string }
export interface OrganizationRepositoryConnection { id: string; repositoryUrl: string; projectIds: string[]; ownership: "organization" | "personal"; state: "active" | "degraded" }
export type OrganizationRoleSummary =
  | { name: "Owner" | "Admin" | "Member"; immutable: true; permissions: string[] }
  | { id: string; name: string; immutable: false; permissions: Array<"create_project">; memberIds: string[] };
export interface RecoveryCodeResponse { codes: string[] }
export interface OrganizationInvitationResponse { token: string }
export interface InstanceDiagnosticSettings { diagnosticSubmissions: boolean; crashReportSubmissions: boolean; updateChecks: boolean }
export interface InstanceDiagnosticsState { settings: InstanceDiagnosticSettings; pending: unknown[]; pendingCrashReports: Array<{ id?: string }>; updateCheckPayload?: unknown }
