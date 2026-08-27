import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";

import { startInstance } from "../tests/support/start-test-instance.js";
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
import { AccountRegistrationService, type RegistrationRecord } from "../src/account-registration.js";
import { PasswordAuthService, hashPassword, type AccountAuthenticationRecord, type SessionRecord } from "../src/password-auth.js";
import { PortableWorkspaceExportService } from "../src/portable-workspace-export.js";
import { LocalAttachmentStorage } from "../src/attachments.js";
import { createCapabilityRegistry } from "../src/capability-registry.js";
import { instanceSetupRoutes } from "../src/identity-access/instance-setup-routes.js";
import { InstanceSetupService } from "../src/identity-access/instance-setup.js";
import { EmptyCollectionImpactInspector, NoteTreeService, type NoteTreeRepository } from "../src/knowledge-authoring/note-tree.js";
import { noteTreeRoutes } from "../src/knowledge-authoring/note-tree-routes.js";
import { EmbeddedInstanceStore } from "../src/embedded-instance-store.js";
import { createAuthenticationSecretCodec } from "../src/authentication-secrets.js";
import { DiscussionService } from "../src/discussions.js";
import { json, type HttpRoute } from "../src/http-routing.js";
import { identityAccessCapability } from "../src/identity-access/index.js";
import { CollectionService, TutorialContributionService } from "../src/knowledge-authoring/collections.js";
import { collectionRoutes } from "../src/knowledge-authoring/collection-routes.js";
import { knowledgeAuthoringCapability } from "../src/knowledge-authoring/index.js";
import { workPlanningCapability } from "../src/work-planning/index.js";
import { ProjectlessTaskService } from "../src/work-planning/projectless-tasks.js";
import { canonicalTaskRoutes } from "../src/work-planning/canonical-task-routes.js";
import { CanonicalTaskService, type CanonicalTask } from "../src/work-planning/canonical-tasks.js";
import { NoteService } from "../src/notes.js";
import { NoteLinkService } from "../src/note-links.js";
import { RelationshipQueryService } from "../src/knowledge-authoring/relationship-query.js";
import { relationshipRoutes } from "../src/knowledge-authoring/relationship-routes.js";

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
    if (![browserMemberId, "browser-second-member", browserGuestId].includes(memberId)) return undefined;
    ensureRichNote(requestedNoteId);
    const snapshot = collaborations.get(requestedNoteId);
    return snapshot ? { ...snapshot, access: memberId === browserGuestId ? "read" as const : "edit" as const } : undefined;
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
let browserProjects = [{ id: projectId, workspaceId: browserWorkspaceId, name: "Stash", key: "STASH", createdByMemberId: browserMemberId }];
const browserGuestId = "10101010-1010-4010-8010-101010101010";
const browserDurableMemberId = "20202020-2020-4020-8020-202020202020";
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
  async listNoteHistory(memberId, requestedNoteId) {
    if (memberId === browserMemberId && requestedNoteId === noteId) return { status: "found" as const, access: "edit" as const, revisions: browserHistory };
    if (memberId === browserGuestId && requestedNoteId === secondNoteId) return { status: "found" as const, access: "read" as const,
      revisions: browserHistory.map((revision) => ({ ...revision, noteId: requestedNoteId })) };
    return { status: "not_found" as const };
  },
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
  ["browser-acceptance-guest-token", browserGuestId], ["browser-acceptance-durable-token", browserDurableMemberId], ["departed-member-token", departedMemberId]]);
const browserAccounts = new Map<string, AccountAuthenticationRecord>([[browserMemberId, {
  id: browserMemberId, name: "Browser Member", email: "member@stash.test",
  passwordHash: await hashPassword("correct horse battery staple"),
}]]);
const browserSessions = new Map<string, SessionRecord>();
const browserPersonalWorkspaces = new Map<string, { id: string; name: string }>();
const browserAuthRepository = {
  async findAccountByEmail(email: string) { return [...browserAccounts.values()].find((account) => account.email === email); },
  async findAccountById(id: string) { return browserAccounts.get(id); },
  async createSession(session: SessionRecord) { browserSessions.set(session.id, session); },
  async findSessionByTokenHash(tokenHash: string) { return [...browserSessions.values()].find((session) => session.tokenHash === tokenHash); },
  async listSessions(accountId: string) { return [...browserSessions.values()].filter((session) => session.accountId === accountId); },
  async deleteSession(accountId: string, sessionId: string) { return browserSessions.get(sessionId)?.accountId === accountId && browserSessions.delete(sessionId); },
  async changePasswordAndDeleteOtherSessions(accountId: string, sessionId: string, passwordHash: string) {
    const account = browserAccounts.get(accountId); if (account) browserAccounts.set(accountId, { ...account, passwordHash });
    for (const session of browserSessions.values()) if (session.accountId === accountId && session.id !== sessionId) browserSessions.delete(session.id);
  },
  async createAccountWithPersonalWorkspaceAndSession(record: RegistrationRecord) {
    if ([...browserAccounts.values()].some((account) => account.email === record.account.email)) return false;
    browserAccounts.set(record.account.id, record.account); browserPersonalWorkspaces.set(record.account.id, record.workspace);
    browserSessions.set(record.session.id, record.session); return true;
  },
};
const browserPasswordAuth = new PasswordAuthService(browserAuthRepository);
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
  async listCustomRoles() { return []; },
  async createCustomRole() { return "forbidden" as const; },
  async updateCustomRole() { return "forbidden" as const; },
  async assignCustomRole() { return "forbidden" as const; },
  async revokeCustomRole() { return "forbidden" as const; },
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

const browserMemberAccess = {
  async authenticateBearer(authorization?: string) {
    const token = authorization?.replace(/^Bearer /, "");
    const accountId = token ? activeTokens.get(token) : undefined;
    return accountId ? { accountId, sessionId: `session-${accountId}` } : browserPasswordAuth.authenticateBearer(authorization);
  },
};

const browserTreeDirectory = await mkdtemp(join(tmpdir(), "stash-browser-note-tree-"));
const browserTreeCodec = createAuthenticationSecretCodec(randomBytes(32).toString("base64"));
let browserTreeStore = await EmbeddedInstanceStore.open(browserTreeDirectory, browserTreeCodec);
await browserTreeStore.database.createFirstOrganizationOwner({ organizationId, organizationName: "Acceptance Organization",
  ownerId: browserMemberId, ownerName: "Browser Member", ownerEmail: "member@stash.test", passwordHash: "test-only", role: "Owner",
  workspaceId: browserWorkspaceId, workspaceName: "Acceptance Workspace" });
await browserTreeStore.upgradeDatabase.query("INSERT INTO stash_accounts(id,name,email,password_hash) VALUES($1,'Browser Guest','browser-guest@stash.test','test-only')", [browserGuestId]);
await browserTreeStore.upgradeDatabase.query("INSERT INTO stash_accounts(id,name,email,password_hash) VALUES($1,'Durable Browser Member','durable@stash.test','test-only')", [browserDurableMemberId]);
await browserTreeStore.upgradeDatabase.query("INSERT INTO stash_organization_memberships(organization_id,account_id,role) VALUES($1,$2,'Admin')",
  [organizationId, browserDurableMemberId]);
await browserTreeStore.upgradeDatabase.query(`INSERT INTO stash_projects(id,workspace_id,name,project_key,created_by_account_id)
  VALUES($1,$2,'Stash','STASH',$3)`, [projectId, browserWorkspaceId, browserMemberId]);
let activeNoteTreeRepository = browserTreeStore.database.noteTreeRepository();
let activeDurableDiscussionService = new DiscussionService(browserTreeStore.database);
const seededRoot = await activeNoteTreeRepository.createTreeNote(browserMemberId, browserWorkspaceId,
  { id: noteId, title: "Release collaboration plan" });
if (seededRoot.status !== "created") throw new Error("browser_note_tree_root_seed_failed");
const seededChild = await activeNoteTreeRepository.createTreeNote(browserMemberId, browserWorkspaceId,
  { id: secondNoteId, title: "Authoritative second Note", parentId: noteId });
if (seededChild.status !== "created") throw new Error("browser_note_tree_child_seed_failed");
await browserTreeStore.upgradeDatabase.query("UPDATE stash_notes SET project_id=$2 WHERE id=$1", [noteId, projectId]);
await browserTreeStore.upgradeDatabase.query("INSERT INTO stash_project_guests(project_id,account_id) VALUES($1,$2)", [projectId, browserGuestId]);
const browserNoteLinks = new NoteLinkService(browserTreeStore.database);
for (let index = 1; index <= 25; index += 1) {
  const suffix = String(index).padStart(2, "0");
  const unresolvedBrowserLink = await browserNoteLinks.importUnresolved(browserMemberId, noteId,
    { targetPath: `notes/missing-browser-${suffix}.md`, candidateNoteIds: [secondNoteId], label: `Missing browser evidence ${suffix}` });
  if (unresolvedBrowserLink.status !== "created") throw new Error("browser_unresolved_link_seed_failed");
}

const browserNoteTreeRepository = new Proxy({} as NoteTreeRepository, {
  get(_target, property) {
    const method = activeNoteTreeRepository[property as keyof NoteTreeRepository];
    if (property === "listNoteTree") return async (memberId: string, workspaceId: string) => memberId === browserMemberId && workspaceId === browserWorkspaceId
      ? { status: "found" as const, nodes: [
        { id: noteId, workspaceId, title: "Release collaboration plan", position: "1", childCount: 1 },
        { id: secondNoteId, workspaceId, parentId: noteId, title: "Authoritative second Note", position: "1", childCount: 0 },
      ] } : activeNoteTreeRepository.listNoteTree(memberId, workspaceId);
    if (property === "readNoteTreeContext") return async (memberId: string, requestedNoteId: string) => {
      if (memberId !== browserMemberId) return activeNoteTreeRepository.readNoteTreeContext(memberId, requestedNoteId);
      if (![noteId, secondNoteId].includes(requestedNoteId)) return { status: "note_not_found" as const };
      const child = requestedNoteId === secondNoteId;
      const breadcrumbs = child ? [{ id: noteId, title: "Release collaboration plan" }, { id: secondNoteId, title: "Authoritative second Note" }]
        : [{ id: noteId, title: "Release collaboration plan" }];
      return { status: "found" as const, context: { noteId: requestedNoteId, workspaceId: browserWorkspaceId, state: "active" as const,
        ...(child ? { parent: breadcrumbs[0] } : {}), revision: 1, createdAt: new Date(0).toISOString(), historyCount: 1,
        access: "edit" as const, accessSource: "workspace" as const, breadcrumbs, outgoingLinks: [], backlinks: [],
        projectIds: [projectId], projects: [{ id: projectId, name: "Stash", key: "STASH" }] } };
    };
    return typeof method === "function" ? method.bind(activeNoteTreeRepository) : method;
  },
});

const browserWorkspaceWorkflow = { schema: "stash.workspace-workflow.v1" as const, workspaceId: browserWorkspaceId, statuses: [
  { id: "41414141-4141-4141-8141-414141414141", name: "Ready", category: "unstarted" as const, position: 1 },
  { id: "42424242-4242-4242-8242-424242424242", name: "In progress", category: "started" as const, position: 2 },
  { id: "43434343-4343-4343-8343-434343434343", name: "Done", category: "completed" as const, position: 3 },
] };
let browserCanonicalTasks: CanonicalTask[] = [{ schema: "stash.task.v1", id: task.id, workspaceId: browserWorkspaceId,
  title: task.title, description: "", revision:1,status: browserWorkspaceWorkflow.statuses[0]!, assigneeIds: [browserMemberId],
  projectAssociations: [projectId], projectKeys: [{ projectId, key: task.key }], keyAliases: [], sourceNoteIds: [], sourceBlocks: [],
  createdBy: task.createdBy, createdAt: task.createdAt }];
const browserCanonicalTaskService = new CanonicalTaskService({
  async listTasks(memberId, workspaceId) { return memberId === browserMemberId && workspaceId === browserWorkspaceId
    ? { status: "found" as const, tasks: browserCanonicalTasks, workflow: browserWorkspaceWorkflow } : { status: "workspace_not_found" as const }; },
  async workspaceWorkflow(memberId, workspaceId) { return memberId === browserMemberId && workspaceId === browserWorkspaceId
    ? { status: "found" as const, workflow: browserWorkspaceWorkflow } : { status: "workspace_not_found" as const }; },
  async createTask(memberId, workspaceId, input) { if (memberId !== browserMemberId || workspaceId !== browserWorkspaceId) return { status: "workspace_not_found" as const };
    const created: CanonicalTask = { schema: "stash.task.v1", id: crypto.randomUUID(), workspaceId, title: input.title, description: input.description,revision:1,
      status: browserWorkspaceWorkflow.statuses[0]!, assigneeIds: [], projectAssociations: [], projectKeys: [], keyAliases: [], sourceNoteIds: [], sourceBlocks: [],
      ...(input.parentTaskId ? { parentTaskId: input.parentTaskId } : {}), createdBy: task.createdBy, createdAt: new Date().toISOString() };
    browserCanonicalTasks = [...browserCanonicalTasks, created]; return { status: "created" as const, task: created }; },
  async updateTask(_memberId, taskId, input) { const found = browserCanonicalTasks.find((item) => item.id === taskId); if (!found) return { status: "task_not_found" as const };
    const status = input.statusId ? browserWorkspaceWorkflow.statuses.find((item) => item.id === input.statusId) : found.status;
    if (!status) return { status: "invalid_reference" as const }; const updated = { ...found, ...input, status,revision:found.revision+1 };
    browserCanonicalTasks = browserCanonicalTasks.map((item) => item.id === taskId ? updated : item); return { status: "updated" as const, task: updated }; },
  async associateTask() { return { status: "task_not_found" as const }; }, async setTaskParent() { return { status: "task_not_found" as const }; },
  async resolveTaskKey() { return { status: "task_not_found" as const }; },
  async configureWorkflow() { return { status: "workspace_not_found" as const }; },
  async setProjectParent() { return { status: "project_not_found" as const }; },
  async listProjectTasks() { return { status: "project_not_found" as const }; },
});

const reopenNoteTreeRoute: HttpRoute = {
  matches(request, url) { return request.method === "POST" && url.pathname === "/api/test/note-tree/reopen"; },
  async handle(request, response) {
    const member = await browserMemberAccess.authenticateBearer(request.headers.authorization);
    if (member?.accountId !== browserDurableMemberId) { json(response, 401, { error: "unauthorized" }); return true; }
    await browserTreeStore.close();
    browserTreeStore = await EmbeddedInstanceStore.open(browserTreeDirectory, browserTreeCodec);
    activeNoteTreeRepository = browserTreeStore.database.noteTreeRepository();
    activeDurableDiscussionService = new DiscussionService(browserTreeStore.database);
    json(response, 200, { status: "reopened" });
    return true;
  },
};

const instance = await startInstance({
  database: { async verifyConnection() {}, async close() {}, async resolveClientSessionPrincipal(accountId: string) {
    const registered = browserAccounts.get(accountId); const personalWorkspace = browserPersonalWorkspaces.get(accountId);
    if (registered && personalWorkspace) return { member: { id: registered.id, name: registered.name, email: registered.email }, workspace: personalWorkspace, capabilities: [] };
    if (![browserMemberId, "browser-second-member", browserGuestId, browserDurableMemberId].includes(accountId)) return undefined;
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
  capabilities: createCapabilityRegistry([{ name: "identity-access", routes: () => [instanceSetupRoutes(new InstanceSetupService({
    async setupComplete() { return true; }, async createFirstPersonalInstance() { return false; },
  }, { boundHost: "127.0.0.1", output() {} }))] }, { name: "knowledge-authoring", routes: () => [
    noteTreeRoutes(new NoteTreeService(browserNoteTreeRepository, new EmptyCollectionImpactInspector()), browserMemberAccess),
    collectionRoutes(new CollectionService(browserTreeStore.database.collectionRepository()), browserMemberAccess),
    relationshipRoutes(new RelationshipQueryService(browserTreeStore.database.relationshipQueryRepository()), browserMemberAccess),
    reopenNoteTreeRoute,
  ] }, { name: "work-planning", routes: () => [canonicalTaskRoutes(browserCanonicalTaskService, browserMemberAccess)] }]),
  passwordAuth: browserPasswordAuth,
  accountRegistration: new AccountRegistrationService(browserAuthRepository),
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
  memberAccess: browserMemberAccess,
  noteLinks: browserNoteLinks,
  workspaceProjects: new WorkspaceProjectService({ async findPortableMemberIdentity() { return { localAccountId: browserMemberId, displayName: "Browser Member" }; }, async canCreateProject(memberId, workspaceId) { return memberId === browserMemberId && workspaceId === browserWorkspaceId; }, async createWorkspace() { return { status: "organization_forbidden" }; }, async createProject(memberId, record) { if (memberId !== browserMemberId || record.workspaceId !== browserWorkspaceId) return "workspace_forbidden"; browserProjects = [...browserProjects, record]; return "created"; }, async listAccessibleWorkspaces() { return [{ id: browserWorkspaceId, name: "Acceptance Workspace", ownerType: "organization" as const, projects: browserProjects }, { id: "77777777-7777-4777-8777-777777777777", name: "Shared Workspace", ownerType: "organization" as const, projects: [{ id: "66666666-6666-4666-8666-666666666665", workspaceId: "77777777-7777-4777-8777-777777777777", createdByMemberId: browserMemberId, name: "Shared roadmap", key: "SHARED" }] }]; } }),
  notes: { async listInbox(memberId: string, workspaceId: string) { return memberId === browserMemberId && workspaceId === browserWorkspaceId ? { status: "found", notes: inboxNotes } : { status: "workspace_forbidden" }; },
    async listNotes(memberId: string, workspaceId: string) { return memberId === browserMemberId && workspaceId === browserWorkspaceId ? { status: "found", notes: [{ id: secondNoteId, workspaceId, content: "Authoritative second Note", createdAt: new Date(0).toISOString() }, { id: noteId, workspaceId, content: "Release collaboration plan", tags: ["decision"], createdAt: new Date(0).toISOString() }] } : { status: "workspace_forbidden" }; },
    async listTemplates() { return { status: "found", templates: [{ id: "abababab-abab-4bab-8bab-abababababa5", name: "Decision", description: "Record context and outcome." }] }; },
    async listDecisions() { return { status: "found", notes: [{ id: noteId, workspaceId: browserWorkspaceId, content: "Release collaboration plan", createdAt: new Date(0).toISOString() }] }; },
    async capture(memberId: string, workspaceId: string, value: { content?: string }) { const note = { id: "abababab-abab-4bab-8bab-abababababab", workspaceId, content: value.content ?? "", document: { type: "doc", blocks: [] }, revision: 1, tags: [], createdByMemberId: memberId, createdAt: new Date().toISOString() }; inboxNotes = [note]; return { status: "created", note, projection: { schema: "stash.note.v2" } }; },
    async triage(memberId: string, workspaceId: string, requestedNoteId: string, value: { action?: string }) { const note = inboxNotes.find(({ id }) => id === requestedNoteId); if (memberId !== browserMemberId || workspaceId !== browserWorkspaceId) return { status: "workspace_forbidden" }; if (!note) return { status: "note_not_found" }; if (value.action === "archive") { inboxNotes = []; return { status: "updated", result: { kind: "archived", note: { ...note, archivedAt: new Date().toISOString() }, projections: [{ schema: "stash.note-state.v1" }] } }; } return { status: "project_forbidden" }; },
    async get(memberId: string, requestedNoteId: string) { if (![browserMemberId, "browser-second-member", browserGuestId].includes(memberId)) return undefined;
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
  discussions: { async listForNote(memberId: string, requestedNoteId: string) {
    if ([browserDurableMemberId, browserGuestId].includes(memberId)) return activeDurableDiscussionService.listForNote(memberId, requestedNoteId);
    return { status: "found", access: "edit", discussions: browserDiscussions };
  }, async listForBlock(memberId: string, requestedNoteId: string, requestedBlockKey: string) {
    if ([browserDurableMemberId, browserGuestId].includes(memberId)) return activeDurableDiscussionService.listForBlock(memberId, requestedNoteId, requestedBlockKey);
    return requestedBlockKey === "77777777-7777-4777-8777-777777777777" ? { status: "found", access: "edit", discussions: [browserBlockDiscussions[0]] } : { status: "not_found" };
  }, async listForTask(memberId: string, requestedTaskId: string) {
    if ([browserDurableMemberId, browserGuestId].includes(memberId)) return activeDurableDiscussionService.listForTask(memberId, requestedTaskId);
    return { status: "found", access: "edit", discussions: browserDiscussions };
  }, async create(memberId: string, value: any) {
    if ([browserDurableMemberId, browserGuestId].includes(memberId)) return activeDurableDiscussionService.create(memberId, value);
    const discussion = { id: crypto.randomUUID(), workspaceId: browserWorkspaceId, target: value.target, createdAt: new Date().toISOString(), messages: [{ id: crypto.randomUUID(), content: value.message, author: { displayName: "Browser Member" }, createdAt: new Date().toISOString() }] }; browserDiscussions = [...browserDiscussions, discussion]; return { status: "created", discussion, projection: {} };
  }, async get(memberId: string, discussionId: string) {
    if ([browserDurableMemberId, browserGuestId].includes(memberId)) return activeDurableDiscussionService.get(memberId, discussionId);
    const discussion = [...browserDiscussions, ...browserBlockDiscussions].find((item) => item.id === discussionId);
    return discussion ? { status: "found", discussion } : { status: "not_found" };
  }, async reply(memberId: string, id: string, value: any) {
    if ([browserDurableMemberId, browserGuestId].includes(memberId)) return activeDurableDiscussionService.reply(memberId, id, value);
    const discussion = [...browserDiscussions, ...browserBlockDiscussions].find((item) => item.id === id); discussion.messages.push({ id: crypto.randomUUID(), content: value.content, author: { displayName: "Browser Member" }, createdAt: new Date().toISOString() }); return { status: "updated", discussion, projection: {} };
  }, async resolve(memberId: string, id: string, value: any) {
    if ([browserDurableMemberId, browserGuestId].includes(memberId)) return activeDurableDiscussionService.resolve(memberId, id, value);
    const discussion = [...browserDiscussions, ...browserBlockDiscussions].find((item) => item.id === id); discussion.resolvedAt = new Date().toISOString(); return { status: "resolved", discussion, projection: {} };
  }, async createWork(memberId: string, id: string, value: any) {
    if ([browserDurableMemberId, browserGuestId].includes(memberId)) return activeDurableDiscussionService.createWork(memberId, id, value);
    return { status: "created", work: { kind: "note" }, activity: {}, projections: [] };
  } } as any,
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
  portableWorkspaceExports: new PortableWorkspaceExportService({ async readExportSnapshot(memberId, workspaceId) {
    if (memberId !== browserMemberId || workspaceId !== browserWorkspaceId) return { status: "workspace_forbidden" as const };
    const actor = { localAccountId: browserMemberId, displayName: "Browser Member" };
    return { status: "found" as const, snapshot: {
      workspace: { schema: "stash.workspace.v1" as const, id: browserWorkspaceId, name: "Acceptance Workspace", owner: { type: "personal" as const, identity: actor }, createdBy: actor },
      notes: [], tasks: [], boards: [], attachments: [], noteLocations: [], noteLinks: [], activities: [], noteHistory: [],
    } };
  } }),
  webClientRoot: fileURLToPath(new URL("../apps/web/dist", import.meta.url)),
});

console.log(`Browser acceptance Instance listening on ${instance.url}`);

const firstRunDirectory = await mkdtemp(join(tmpdir(), "stash-browser-first-run-"));
const firstRunCodec = createAuthenticationSecretCodec(randomBytes(32).toString("base64"));
let firstRunStore = await EmbeddedInstanceStore.open(firstRunDirectory, firstRunCodec);
let firstRunInstance: Awaited<ReturnType<typeof startInstance>>;
async function startFirstRunInstance() {
  const database = firstRunStore.database;
  const auth = new PasswordAuthService(database);
  const notes = new NoteService(database.knowledgeAuthoringRepositories());
  const tasks = new TaskService(database, database);
  const projects = new WorkspaceProjectService(database);
  const attachments = new LocalAttachmentStorage(firstRunStore.paths.attachments);
  return startInstance({ database, host: "0.0.0.0", port: Number.parseInt(process.env.STASH_BROWSER_FIRST_RUN_PORT ?? "4174", 10),
    instanceAdminToken: "first-run-admin",
    capabilities: createCapabilityRegistry([
      identityAccessCapability({ passwordAuth: auth, instanceSetup: new InstanceSetupService(database.instanceSetupRepository(),
        { boundHost: "0.0.0.0", code: "STASH-ONE", output() {} }) }),
      knowledgeAuthoringCapability({ notes, noteTree: new NoteTreeService(database.noteTreeRepository(), database.tutorialContributionRepository()),
        starterTutorials: new TutorialContributionService(database.tutorialContributionRepository()),
        collections: new CollectionService(database.collectionRepository()), noteLinks: new NoteLinkService(database),
        discussions: new DiscussionService(database), searches: new WorkspaceSearchService(database),
        portableWorkspaceExports: new PortableWorkspaceExportService(database, attachments), memberAccess: auth }),
      workPlanningCapability({ tasks, workspaceProjects: projects, memberAccess: auth,
        projectlessTasks: new ProjectlessTaskService(database.projectlessTaskRepository()),
        canonicalTasks: new CanonicalTaskService(database.canonicalTaskRepository()) }),
    ]), webClientRoot: fileURLToPath(new URL("../apps/web/dist", import.meta.url)) });
}
firstRunInstance = await startFirstRunInstance();
const restartSupervisor = createServer(async (request, response) => {
  if (request.method !== "POST" || request.url !== "/restart") { response.writeHead(404).end(); return; }
  await firstRunInstance.close();
  await firstRunStore.close();
  firstRunStore = await EmbeddedInstanceStore.open(firstRunDirectory, firstRunCodec);
  firstRunInstance = await startFirstRunInstance();
  json(response, 200, { status: "restarted" });
});
await new Promise<void>((resolve) => restartSupervisor.listen(4176, "127.0.0.1", resolve));
console.log(`Fresh browser setup Instance listening on ${firstRunInstance.url}`);

const roleDirectory = await mkdtemp(join(tmpdir(), "stash-browser-role-"));
const roleCodec = createAuthenticationSecretCodec(randomBytes(32).toString("base64"));
const roleStore = await EmbeddedInstanceStore.open(roleDirectory, roleCodec);
const roleOrganizationId = "91919191-9191-4191-8191-919191919191";
const roleOwnerId = "92929292-9292-4292-8292-929292929292";
const roleMemberId = "93939393-9393-4393-8393-939393939393";
const roleWorkspaceId = "94949494-9494-4494-8494-949494949494";
await roleStore.database.createFirstOrganizationOwner({ organizationId: roleOrganizationId, organizationName: "Browser Organization",
  ownerId: roleOwnerId, ownerName: "Role Owner", ownerEmail: "role-owner@stash.test",
  passwordHash: await hashPassword("owner correct horse battery"), role: "Owner", workspaceId: roleWorkspaceId, workspaceName: "Organization Workspace" });
await roleStore.upgradeDatabase.query("INSERT INTO stash_accounts(id,name,email,password_hash) VALUES($1,$2,$3,$4)",
  [roleMemberId, "Role Member", "role-member@stash.test", roleCodec.encrypt(await hashPassword("member correct horse battery"))]);
await roleStore.upgradeDatabase.query("INSERT INTO stash_organization_memberships(organization_id,account_id,role) VALUES($1,$2,'Member')",
  [roleOrganizationId, roleMemberId]);
const roleAuth = new PasswordAuthService(roleStore.database);
const roleTasks = new TaskService(roleStore.database, roleStore.database);
const roleProjects = new WorkspaceProjectService(roleStore.database);
const roleService = new OrganizationRoleService(roleStore.database);
const completedRoleSetup = new InstanceSetupService(roleStore.database.instanceSetupRepository(), { boundHost: "127.0.0.1", output() {} });
const roleInstance = await startInstance({ database: roleStore.database, host: "127.0.0.1", port: Number.parseInt(process.env.STASH_BROWSER_ROLE_PORT ?? "4175", 10),
  instanceAdminToken: "role-admin", passwordAuth: roleAuth, memberAccess: roleAuth, organizationRoles: roleService,
  workspaceProjects: roleProjects, tasks: roleTasks,
  capabilities: createCapabilityRegistry([identityAccessCapability({ passwordAuth: roleAuth, instanceSetup: completedRoleSetup }),
    workPlanningCapability({ tasks: roleTasks, workspaceProjects: roleProjects, memberAccess: roleAuth })]),
  webClientRoot: fileURLToPath(new URL("../apps/web/dist", import.meta.url)) });
console.log(`Custom Role browser Instance listening on ${roleInstance.url}`);

let closing = false;
async function close() {
  if (closing) return;
  closing = true;
  await instance.close();
  await firstRunInstance.close();
  await new Promise<void>((resolve, reject) => restartSupervisor.close((error) => error ? reject(error) : resolve()));
  await firstRunStore.close();
  await roleInstance.close();
  await roleStore.close();
  await browserTreeStore.close();
  process.exit(0);
}

process.once("SIGINT", () => void close());
process.once("SIGTERM", () => void close());
