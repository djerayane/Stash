import { fileURLToPath } from "node:url";

import { startInstance } from "../src/instance.js";
import { NoteCollaborationService, type CollaborationSnapshot } from "../src/note-collaboration.js";
import * as Y from "yjs";
import { collaborativeDocumentFromRichText, richTextFromCollaborativeDocument } from "../src/postgres-database.js";
import { richTextToMarkdown } from "../src/rich-text.js";
import { TaskService, type TaskPlanningReadModel, type TaskPlanningUpdate } from "../src/tasks.js";
import { OrganizationRoleService, type BuiltInOrganizationRole } from "../src/organization-roles.js";
import { WorkspaceSearchService } from "../src/workspace-search.js";
import { WorkspaceProjectService } from "../src/workspaces-projects.js";
import { EmailRecoveryUnavailable } from "../src/account-recovery.js";
import { InvalidOidcRequest } from "../src/oidc-auth.js";
import { ActivityService, type ActivityRepository, type NoteHistoryRevision } from "../src/activity.js";
import { NotificationService, type NotificationRepository } from "../src/notifications.js";
import type { ActivityRecord, NotificationDelivery } from "@stash/domain-types";

const noteId = "99999999-9999-4999-8999-999999999999";
const secondNoteId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const richNoteId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const richNoteNamespace = "cccccccc-cccc-4ccc-8ccc-";
const emptyCodeNoteId = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
const markdownNoteId = "14141414-1414-4414-8414-141414141414";
const principalBoundaryNoteId = "12121212-1212-4212-8212-121212121212";
const browserWorkspaceId = "88888888-8888-4888-8888-888888888888";
let inboxNotes: any[] = [];
const seededDocument = collaborativeDocumentFromRichText({ type: "doc", blocks: [{ type: "paragraph", blockKey: "77777777-7777-4777-8777-777777777777",
  id: "66666666-6666-4666-8666-666666666666", content: [{ text: "Preserve this linked Block" }] }] });
const secondSeededDocument = collaborativeDocumentFromRichText({ type: "doc", blocks: [{ type: "paragraph",
  blockKey: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", content: [{ text: "Authoritative second Note" }] }] });
const richSeededDocument = collaborativeDocumentFromRichText({ type: "doc", blocks: [{ type: "paragraph",
  blockKey: "dddddddd-dddd-4ddd-8ddd-dddddddddddd", content: [{ text: "Rich structure seed" }] }] });
const emptyCodeSeededDocument = collaborativeDocumentFromRichText({ type: "doc", blocks: [{ type: "paragraph",
  blockKey: "ffffffff-ffff-4fff-8fff-ffffffffffff", content: [{ text: "Clear this content" }] }] });
const markdownSeededDocument = collaborativeDocumentFromRichText({ type: "doc", blocks: [{ type: "paragraph",
  blockKey: "15151515-1515-4515-8515-151515151515", content: [{ text: "Technical source seed" }] }] });
const principalBoundaryDocument = collaborativeDocumentFromRichText({ type: "doc", blocks: [{ type: "paragraph",
  blockKey: "13131313-1313-4313-8313-131313131313", content: [{ text: "Principal boundary seed" }] }] });
const collaborations = new Map<string, CollaborationSnapshot>([
  [noteId, { noteId, sequence: 0, update: Y.encodeStateAsUpdate(seededDocument), updatedAt: new Date(0).toISOString(), updatedByMemberId: "browser-member", access: "edit" }],
  [secondNoteId, { noteId: secondNoteId, sequence: 0, update: Y.encodeStateAsUpdate(secondSeededDocument), updatedAt: new Date(0).toISOString(), updatedByMemberId: "browser-member", access: "edit" }],
  [richNoteId, { noteId: richNoteId, sequence: 0, update: Y.encodeStateAsUpdate(richSeededDocument), updatedAt: new Date(0).toISOString(), updatedByMemberId: "browser-member", access: "edit" }],
  [emptyCodeNoteId, { noteId: emptyCodeNoteId, sequence: 0, update: Y.encodeStateAsUpdate(emptyCodeSeededDocument), updatedAt: new Date(0).toISOString(), updatedByMemberId: "browser-member", access: "edit" }],
  [markdownNoteId, { noteId: markdownNoteId, sequence: 0, update: Y.encodeStateAsUpdate(markdownSeededDocument), updatedAt: new Date(0).toISOString(), updatedByMemberId: "browser-member", access: "edit" }],
  [principalBoundaryNoteId, { noteId: principalBoundaryNoteId, sequence: 0, update: Y.encodeStateAsUpdate(principalBoundaryDocument), updatedAt: new Date(0).toISOString(), updatedByMemberId: "browser-member", access: "edit" }],
]);
const richSeedUpdate = collaborations.get(richNoteId)!.update;
function ensureRichNote(requestedNoteId: string): void {
  if (!requestedNoteId.startsWith(richNoteNamespace) || collaborations.has(requestedNoteId)) return;
  collaborations.set(requestedNoteId, { noteId: requestedNoteId, sequence: 0, update: richSeedUpdate.slice(),
    updatedAt: new Date(0).toISOString(), updatedByMemberId: "browser-member", access: "edit" });
}
seededDocument.destroy();
secondSeededDocument.destroy();
richSeededDocument.destroy();
emptyCodeSeededDocument.destroy();
markdownSeededDocument.destroy();
principalBoundaryDocument.destroy();
const collaborationRepository = {
  async loadNoteCollaboration(memberId: string, requestedNoteId: string) {
    if (![browserMemberId, "browser-second-member", "browser-guest"].includes(memberId)) return undefined;
    ensureRichNote(requestedNoteId);
    const snapshot = collaborations.get(requestedNoteId);
    return snapshot ? { ...snapshot, access: memberId === "browser-guest" ? "read" as const : "edit" as const } : undefined;
  },
  async appendNoteCollaboration(memberId: string, requestedNoteId: string, update: Uint8Array) {
    ensureRichNote(requestedNoteId);
    const collaboration = collaborations.get(requestedNoteId);
    if (![browserMemberId, "browser-second-member"].includes(memberId) || !collaboration) return undefined;
    const document = new Y.Doc(); Y.applyUpdate(document, collaboration.update); Y.applyUpdate(document, update);
    const next = { noteId: requestedNoteId, sequence: collaboration.sequence + 1, update: Y.encodeStateAsUpdate(document),
      updatedAt: new Date().toISOString(), updatedByMemberId: memberId, access: "edit" as const };
    collaborations.set(requestedNoteId, next); return next;
  },
};

const projectId = "22222222-2222-4222-8222-222222222222";
const browserMemberId = "11111111-1111-4111-8111-111111111111";
const browserBoardId = "abababab-abab-4bab-8bab-abababababa1";
let browserBoardStatus = "Ready";
let browserDiscussions: any[] = [{ id: "abababab-abab-4bab-8bab-abababababa2", workspaceId: browserWorkspaceId, target: { kind: "note", noteId }, createdAt: new Date(0).toISOString(), messages: [{ id: "abababab-abab-4bab-8bab-abababababa3", content: "Keep this release context", author: { localAccountId: browserMemberId, displayName: "Browser Member" }, createdAt: new Date(0).toISOString() }] }, { id: "cdcdcdcd-cdcd-4dcd-8dcd-cdcdcdcdcdc1", workspaceId: browserWorkspaceId, target: { kind: "note", noteId }, createdAt: new Date(0).toISOString(), messages: [{ id: "cdcdcdcd-cdcd-4dcd-8dcd-cdcdcdcdcdc2", content: "Unrelated migration thread", author: { localAccountId: browserMemberId, displayName: "Browser Member" }, createdAt: new Date(0).toISOString() }] }];
const browserBlockDiscussions: any[] = [{ id: "dededede-dede-4ede-8ede-dededededed1", workspaceId: browserWorkspaceId, target: { kind: "block", noteId, blockId: "66666666-6666-4666-8666-666666666666", state: "attached" }, createdAt: new Date(0).toISOString(), messages: [{ id: "dededede-dede-4ede-8ede-dededededed2", content: "Exact Block thread", author: { localAccountId: browserMemberId, displayName: "Browser Member" }, createdAt: new Date(0).toISOString() }] }, { id: "efefefef-efef-4fef-8fef-efefefefefe1", workspaceId: browserWorkspaceId, target: { kind: "block", noteId, blockId: "efefefef-efef-4fef-8fef-efefefefefe2", state: "attached" }, createdAt: new Date(0).toISOString(), messages: [{ id: "efefefef-efef-4fef-8fef-efefefefefe3", content: "Unrelated Block thread", author: { localAccountId: browserMemberId, displayName: "Browser Member" }, createdAt: new Date(0).toISOString() }] }];
const browserActivity: ActivityRecord = { schema: "stash.activity.v1", id: "abababab-abab-4bab-8bab-abababababa6", workspaceId: browserWorkspaceId,
  object: { kind: "Note", id: noteId }, action: "note_updated", actor: { localAccountId: browserMemberId, displayName: "Browser Member" },
  cause: { kind: "member" }, occurredAt: new Date(0).toISOString(), before: { title: "Draft release plan" }, after: { title: "Release plan" } };
let browserNotifications: NotificationDelivery[] = [{ schema: "stash.notification.v1", id: "abababab-abab-4bab-8bab-abababababa4", memberId: browserMemberId,
  workspaceId: browserWorkspaceId, projectId, trigger: "followed_change", summary: "Release plan updated", activity: browserActivity,
  createdAt: new Date(0).toISOString(), delivery: "immediate" }];
let browserHistory: NoteHistoryRevision[] = [1, 2].map((revision) => ({ noteId, workspaceId: browserWorkspaceId, revision,
  content: revision === 1 ? "Original release plan" : "Release collaboration plan", document: { type: "doc", blocks: [] }, recordedAt: new Date(revision * 1000).toISOString(),
  actor: browserActivity.actor, cause: { kind: "member", ...(revision === 2 ? { restorationOfRevision: 1 } : {}) } }));
const browserActivityRepository: ActivityRepository = {
  async listWorkspaceActivity(memberId, workspaceId) { return memberId === browserMemberId && workspaceId === browserWorkspaceId ? { status: "found", activities: [browserActivity] } : { status: "forbidden" }; },
  async listNoteHistory(memberId, requestedNoteId) { return memberId === browserMemberId && requestedNoteId === noteId ? { status: "found", revisions: browserHistory } : { status: "not_found" }; },
  async restoreNote(memberId, requestedNoteId, targetRevision, expectedRevision) { if (memberId !== browserMemberId || requestedNoteId !== noteId) return { status: "not_found" }; const target = browserHistory.find(({ revision }) => revision === targetRevision); if (!target) return { status: "revision_not_found" }; if (expectedRevision !== browserHistory.at(-1)?.revision) return { status: "revision_conflict", currentRevision: browserHistory.at(-1)!.revision }; const revision = expectedRevision + 1; browserHistory = [...browserHistory, { ...target, revision, recordedAt: new Date().toISOString(), cause: { kind: "member", restorationOfRevision: targetRevision } }]; return { status: "restored", note: { revision, content: target.content, document: target.document }, activity: { ...browserActivity, id: crypto.randomUUID(), action: "note_restored", cause: { kind: "member", restorationOfRevision: targetRevision } } }; },
};
const browserNotificationRepository: NotificationRepository = {
  async saveNotification(delivery) { browserNotifications = [...browserNotifications, delivery]; return delivery; }, async listNotifications(memberId) { return browserNotifications.filter((item) => item.memberId === memberId); },
  async markNotificationRead(memberId, id, readAt) { const item = browserNotifications.find((entry) => entry.memberId === memberId && entry.id === id); if (!item) return undefined; const read = { ...item, readAt }; browserNotifications = browserNotifications.map((entry) => entry.id === id ? read : entry); return read; },
  async getNotificationPreferences() { return undefined; }, async saveNotificationPreferences() { return undefined; }, async claimDigestNotifications() { return []; },
};
const organizationId = "44444444-4444-4444-8444-444444444444";
const otherOrganizationId = "33333333-3333-4333-8333-333333333333";
const departedMemberId = "55555555-5555-4555-8555-555555555555";
const activeTokens = new Map([["browser-acceptance-member-token", browserMemberId], ["browser-acceptance-second-member-token", "browser-second-member"],
  ["browser-acceptance-guest-token", "browser-guest"], ["departed-member-token", departedMemberId]]);
let task: TaskPlanningReadModel = {
  schema: "stash.task.v1", id: "32323232-3232-4232-8232-323232323232", workspaceId: "browser-workspace", projectId,
  key: "STASH-32", title: "Restore release ownership", status: { id: "ready", name: "Ready", category: "unstarted" },
  assigneeIds: [departedMemberId], priority: "high", labelNames: [], linkedNoteIds: [],
  dependencies: [], developmentLinks: [], sourceNoteIds: [], createdAt: "2026-08-23T00:00:00.000Z",
  createdBy: { localAccountId: "browser-member", displayName: "Browser Member" }, revision: 1, dependencyWarnings: [],
};
let browserTaskLinked = false;
const memberships = new Map<string, BuiltInOrganizationRole>([[browserMemberId, "Admin"], [departedMemberId, "Member"]]);
const pendingImportedIdentities = new Map([["77777777-7777-4777-8777-777777777777", { importId: "66666666-6666-4666-8666-666666666666", workspaceId: "browser-workspace", workspaceName: "Imported Atlas", sourceAccountId: "77777777-7777-4777-8777-777777777777", displayName: "Grace Hopper" }]]);
const organizationRoleRepository = {
  async organizationRole(requestedOrganizationId: string, accountId: string) {
    return requestedOrganizationId === organizationId ? memberships.get(accountId) : undefined;
  },
  async assignBuiltInRole() { return "forbidden" as const; },
  async removeOrganizationMember(requestedOrganizationId: string, actorId: string, accountId: string) {
    if (requestedOrganizationId !== organizationId || !["Owner", "Admin"].includes(memberships.get(actorId)!)) return "forbidden" as const;
    if (!memberships.has(accountId)) return "member_not_found" as const;
    if (memberships.get(actorId) === "Admin" && memberships.get(accountId) === "Owner") return "forbidden" as const;
    memberships.delete(accountId);
    activeTokens.delete("departed-member-token");
    task = { ...task, formerAssigneeIds: (task.assigneeIds ?? []).includes(accountId) ? [accountId] : [], revision: task.revision + 1 };
    return { status: "removed" as const, departure: { memberId: accountId, affectedTaskIds: [task.id],
      revokedSessions: 1, revokedCredentials: 1, revokedAgentGrants: 1, degradedRepositoryConnectionIds: [] } };
  },
};
const taskRepository = {
  async createTaskFromBlock(memberId: string, requestedNoteId: string, requestedBlockKey: string, draft: { projectId: string; title: string }) { if (memberId !== browserMemberId || requestedNoteId !== noteId || requestedBlockKey !== "77777777-7777-4777-8777-777777777777" || draft.projectId !== projectId) return { status: "block_not_found" as const }; task = { ...task, title: draft.title }; browserTaskLinked = true; return { status: "created" as const, task, sourceBlock: { noteId, blockId: "66666666-6666-4666-8666-666666666666" } }; },
  async listLinkedTasks(memberId: string, requestedNoteId: string) { return memberId === browserMemberId && requestedNoteId === noteId ? { status: "found" as const, tasks: browserTaskLinked ? [{ id: task.id, key: task.key, title: task.title, projectId, status: task.status, sourceBlock: { noteId, blockId: "66666666-6666-4666-8666-666666666666" }, relationshipState: "linked" as const }] : [] } : { status: "note_not_found" as const }; },
  async listTaskSourceBlocks(memberId: string, requestedTaskId: string) { return memberId === browserMemberId && requestedTaskId === task.id ? { status: "found" as const, sourceBlocks: browserTaskLinked ? [{ noteId, blockId: "66666666-6666-4666-8666-666666666666", state: "linked" as const }] : [] } : { status: "task_not_found" as const }; },
  async findTaskByKey(memberId: string, requestedProjectId: string, taskKey: string) {
    return memberId === browserMemberId && requestedProjectId === projectId && taskKey === task.key
      ? { status: "found" as const, task } : { status: "not_found" as const };
  },
  async updateTaskByKey(memberId: string, requestedProjectId: string, taskKey: string, update: TaskPlanningUpdate) {
    if (memberId !== browserMemberId || requestedProjectId !== projectId || taskKey !== task.key) return { status: "not_found" as const };
    const { assigneeIds: requestedAssigneeIds } = update;
    const assigneeIds = requestedAssigneeIds ?? task.assigneeIds ?? [];
    const formerAssigneeIds = task.formerAssigneeIds ?? [];
    const reassigned = requestedAssigneeIds !== undefined
      && formerAssigneeIds.every((id) => !assigneeIds.includes(id))
      && assigneeIds.some((id) => !formerAssigneeIds.includes(id));
    const { formerAssigneeIds: _previousFormerAssignees, dueDate: _previousDueDate, estimate: _previousEstimate, ...currentTask } = task;
    const { dueDate, estimate, statusId: _statusId, ...portableUpdate } = update;
    task = { ...currentTask, ...portableUpdate, assigneeIds,
      ...(dueDate !== null && dueDate !== undefined ? { dueDate } : {}),
      ...(estimate !== null && estimate !== undefined ? { estimate } : {}),
      ...(!reassigned && formerAssigneeIds.length ? { formerAssigneeIds } : {}), revision: task.revision + 1 };
    return { status: "updated" as const, task };
  },
};

const instance = await startInstance({
  database: { async verifyConnection() {}, async close() {}, async resolveClientSessionPrincipal(accountId: string) {
    if (![browserMemberId, "browser-second-member", "browser-guest"].includes(accountId)) return undefined;
    return { member: { id: accountId,
      name: accountId === browserMemberId ? "Browser Member" : accountId === "browser-second-member" ? "Second Browser Member" : "Browser Guest",
      email: accountId === browserMemberId ? "member@stash.test" : `${accountId}@stash.test` },
      workspace: { id: browserWorkspaceId, name: "Acceptance Workspace" }, capabilities: [], ...(accountId === browserMemberId ? {
      activeOrganizationId: organizationId, organizationAdministrations: [
      { organizationId: otherOrganizationId, organizationName: "Other Organization", members: [
        { id: browserMemberId, name: "Browser Member", email: "member@stash.test", role: "Admin" as const },
      ] }, { organizationId, organizationName: "Acceptance Organization", members: [
        { id: browserMemberId, name: "Browser Member", email: "member@stash.test", role: "Admin" as const },
        ...(memberships.has(departedMemberId)
          ? [{ id: departedMemberId, name: "Departing Member", email: "departing@stash.test", role: "Member" as const }]
          : []),
      ] }] } : {}) };
  } },
  host: "127.0.0.1",
  port: Number.parseInt(process.env.STASH_BROWSER_PORT ?? "4173", 10),
  instanceAdminToken: "browser-acceptance-admin-token",
  passwordAuth: { authenticateBearer: async (authorization: string | undefined) => { const accountId = activeTokens.get(authorization?.replace(/^Bearer /, "") || ""); return accountId ? { accountId, sessionId: `session-${accountId}` } : undefined; }, signIn: async () => { throw new Error("invalid_credentials"); } } as any,
  accountRecovery: { async authenticationOptions() { return { challenge: "cHJvb2Y", rpId: "127.0.0.1", userVerification: "required", allowCredentials: [] }; }, async signInWithPasskey() { return { token: "browser-acceptance-member-token" }; }, async signInWithRecoveryCode() { return { token: "browser-acceptance-member-token" }; }, async requestEmailRecovery() { throw new EmailRecoveryUnavailable(); }, async signInWithEmailRecovery() { return { token: "browser-acceptance-member-token" }; } } as any,
  oidcAuth: {
    async begin() { throw new InvalidOidcRequest(); },
    async complete(_organizationId: string, code: string | null, state: string | null) {
      if (code !== "browser-code" || state !== "browser-state") throw new InvalidOidcRequest();
      return { token: "browser-acceptance-member-token", member: { email: "member@example.test" } };
    },
  } as any,
  oidcCallbackOrigin: "http://127.0.0.1:4173",
  allowInsecureOidcCallbackOriginForTest: true,
  memberAccess: {
    async authenticateBearer(authorization) {
      const token = authorization?.replace(/^Bearer /, "");
      const accountId = token ? activeTokens.get(token) : undefined;
      return accountId ? { accountId, sessionId: `session-${accountId}` } : undefined;
    },
  },
  workspaceProjects: new WorkspaceProjectService({ async findPortableMemberIdentity() { return { localAccountId: browserMemberId, displayName: "Browser Member" }; }, async createWorkspace() { return { status: "organization_forbidden" }; }, async createProject() { return "workspace_forbidden"; }, async listAccessibleWorkspaces() { return [{ id: browserWorkspaceId, name: "Acceptance Workspace", projects: [{ id: projectId, name: "Stash", key: "STASH" }] }, { id: "77777777-7777-4777-8777-777777777777", name: "Shared Workspace", projects: [{ id: "66666666-6666-4666-8666-666666666665", name: "Shared roadmap", key: "SHARED" }] }]; } }),
  notes: { async listInbox(memberId: string, workspaceId: string) { return memberId === browserMemberId && workspaceId === browserWorkspaceId ? { status: "found", notes: inboxNotes } : { status: "workspace_forbidden" }; },
    async listNotes(memberId: string, workspaceId: string) { return memberId === browserMemberId && workspaceId === browserWorkspaceId ? { status: "found", notes: [{ id: secondNoteId, workspaceId, content: "Authoritative second Note", createdAt: new Date(0).toISOString() }, { id: noteId, workspaceId, content: "Release collaboration plan", tags: ["decision"], createdAt: new Date(0).toISOString() }] } : { status: "workspace_forbidden" }; },
    async listTemplates() { return { status: "found", templates: [{ id: "abababab-abab-4bab-8bab-abababababa5", name: "Decision", description: "Record context and outcome." }] }; },
    async listDecisions() { return { status: "found", notes: [{ id: noteId, workspaceId: browserWorkspaceId, content: "Release collaboration plan", createdAt: new Date(0).toISOString() }] }; },
    async capture(memberId: string, workspaceId: string, value: { content?: string }) { const note = { id: "abababab-abab-4bab-8bab-abababababab", workspaceId, content: value.content ?? "", document: { type: "doc", blocks: [] }, revision: 1, tags: [], createdByMemberId: memberId, createdAt: new Date().toISOString() }; inboxNotes = [note]; return { status: "created", note, projection: { schema: "stash.note.v2" } }; },
    async triage(memberId: string, workspaceId: string, requestedNoteId: string, value: { action?: string }) { const note = inboxNotes.find(({ id }) => id === requestedNoteId); if (memberId !== browserMemberId || workspaceId !== browserWorkspaceId) return { status: "workspace_forbidden" }; if (!note) return { status: "note_not_found" }; if (value.action === "archive") { inboxNotes = []; return { status: "updated", result: { kind: "archived", note: { ...note, archivedAt: new Date().toISOString() }, projections: [{ schema: "stash.note-state.v1" }] } }; } return { status: "project_forbidden" }; },
    async get(memberId: string, requestedNoteId: string) { if (![browserMemberId, "browser-second-member", "browser-guest"].includes(memberId)) return undefined;
    ensureRichNote(requestedNoteId);
    if (!collaborations.has(requestedNoteId)) return undefined;
    if (requestedNoteId.startsWith(richNoteNamespace)) { const current = new Y.Doc(); Y.applyUpdate(current, collaborations.get(requestedNoteId)!.update);
      const document = richTextFromCollaborativeDocument(current); current.destroy(); return {
        id: requestedNoteId, workspaceId: "88888888-8888-4888-8888-888888888888", content: richTextToMarkdown(document), revision: collaborations.get(requestedNoteId)!.sequence + 1,
        document, tags: [], createdByMemberId: memberId, createdAt: new Date(0).toISOString(),
      }; }
    const second = requestedNoteId === secondNoteId; const emptyCode = requestedNoteId === emptyCodeNoteId; return {
    id: requestedNoteId, workspaceId: "88888888-8888-4888-8888-888888888888", content: second ? "Stale canonical second Note" : emptyCode ? "Clear this content" : "Release collaboration plan", revision: 1,
    document: { type: "doc", blocks: [{ type: "paragraph", blockKey: second ? "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" : emptyCode ? "ffffffff-ffff-4fff-8fff-ffffffffffff" : "77777777-7777-4777-8777-777777777777",
      ...(!second && !emptyCode ? { id: "66666666-6666-4666-8666-666666666666" } : {}), content: [{ text: second ? "Stale canonical second Note" : emptyCode ? "Clear this content" : "Preserve this linked Block" }] }] },
    tags: [], createdByMemberId: memberId, createdAt: new Date(0).toISOString(),
  }; } } as any,
  noteCollaboration: new NoteCollaborationService(collaborationRepository),
  organizationRoles: new OrganizationRoleService(organizationRoleRepository),
  importedIdentityAdministration: {
    async listPendingImportedIdentities(memberId: string) { return memberId === browserMemberId ? [...pendingImportedIdentities.values()] : []; },
    async mapImportedIdentityAsMember(memberId: string, input: { sourceAccountId: string; localAccountId: string }) {
      if (memberId !== browserMemberId || !memberships.has(input.localAccountId)) return { status: "forbidden" as const };
      if (!pendingImportedIdentities.has(input.sourceAccountId)) return { status: "not_found" as const };
      pendingImportedIdentities.delete(input.sourceAccountId); return { status: "mapped" as const };
    },
  },
  tasks: new TaskService(taskRepository, { async findPortableMemberIdentity(memberId: string) { return memberId === browserMemberId ? { localAccountId: memberId, displayName: "Browser Member" } : undefined; } }),
  boards: { async list() { return { status: "found", boards: [{ id: browserBoardId, name: "Delivery" }] }; }, async read() { return { status: "found", board: { id: browserBoardId, name: "Delivery" }, columns: [{ id: "ready", name: "Ready", archived: false, tasks: [{ id: task.id, key: task.key, title: task.title }] }, { id: "done", name: "Done", archived: false, tasks: [] }] }; }, async move(_memberId: string, _projectId: string, _boardId: string, _taskKey: string, value: { statusId: string }) { browserBoardStatus = value.statusId; return { status: "moved", task: { ...task, status: { id: value.statusId, name: value.statusId === "done" ? "Done" : "Ready" } } }; } } as any,
  discussions: { async listForNote() { return { status: "found", discussions: browserDiscussions }; }, async listForBlock(_memberId: string, _noteId: string, requestedBlockKey: string) { return requestedBlockKey === "77777777-7777-4777-8777-777777777777" ? { status: "found", discussions: [browserBlockDiscussions[0]] } : { status: "not_found" }; }, async listForTask() { return { status: "found", discussions: browserDiscussions }; }, async create(_memberId: string, value: any) { const discussion = { id: crypto.randomUUID(), workspaceId: browserWorkspaceId, target: value.target, createdAt: new Date().toISOString(), messages: [{ id: crypto.randomUUID(), content: value.message, author: { displayName: "Browser Member" }, createdAt: new Date().toISOString() }] }; browserDiscussions = [...browserDiscussions, discussion]; return { status: "created", discussion, projection: {} }; }, async reply(_memberId: string, id: string, value: any) { const discussion = [...browserDiscussions, ...browserBlockDiscussions].find((item) => item.id === id); discussion.messages.push({ id: crypto.randomUUID(), content: value.content, author: { displayName: "Browser Member" }, createdAt: new Date().toISOString() }); return { status: "updated", discussion, projection: {} }; }, async resolve(_memberId: string, id: string) { const discussion = [...browserDiscussions, ...browserBlockDiscussions].find((item) => item.id === id); discussion.resolvedAt = new Date().toISOString(); return { status: "resolved", discussion, projection: {} }; }, async createWork() { return { status: "created", work: { kind: "note" }, activity: {}, projections: [] }; } } as any,
  activities: new ActivityService(browserActivityRepository),
  notifications: new NotificationService(browserNotificationRepository),
  searches: new WorkspaceSearchService({ async searchWorkspace(memberId, workspaceId, query) {
    if (memberId !== browserMemberId || workspaceId !== browserWorkspaceId) return { status: "forbidden" };
    const results = query.q === "discussion"
      ? [{ id: browserDiscussions[0].id, kind: "discussion" as const, title: "Keep this release context", href: `/app/notes/${noteId}/discussions` }]
      : query.q === "task"
        ? [{ id: task.id, kind: "task" as const, title: `${task.key} · ${task.title}`, excerpt: "Canonical Task planning result", href: `/app/projects/${projectId}/tasks/${task.key}`, projectId, author: "Browser Member", assignee: "Browser Member", status: task.status.name, occurredAt: "2026-08-22T10:00:00.000Z" }]
        : [{ id: noteId, kind: "note" as const, title: "Release collaboration plan", excerpt: `Matched ${query.q}`, href: `/app/notes/${noteId}`, author: "Browser Member", status: "active", occurredAt: "2026-08-21T10:00:00.000Z" }];
    return { status: "found", results, total: results.length,
      facets: { kinds: [{ value: results[0]!.kind, count: results.length }],
        projects: results[0] && "projectId" in results[0] ? [{ value: results[0].projectId!, count: results.length }] : [],
        statuses: results[0] && "status" in results[0] ? [{ value: results[0].status!, count: results.length }] : [] } };
  } }),
  webClientRoot: fileURLToPath(new URL("../apps/web/dist", import.meta.url)),
});

console.log(`Browser acceptance Instance listening on ${instance.url}`);

let closing = false;
async function close() {
  if (closing) return;
  closing = true;
  await instance.close();
  process.exit(0);
}

process.once("SIGINT", () => void close());
process.once("SIGTERM", () => void close());
