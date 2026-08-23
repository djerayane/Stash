import { fileURLToPath } from "node:url";

import { startInstance } from "../src/instance.js";
import { NoteCollaborationService, type CollaborationSnapshot } from "../src/note-collaboration.js";
import * as Y from "yjs";
import { collaborativeDocumentFromRichText, richTextFromCollaborativeDocument } from "../src/postgres-database.js";
import { richTextToMarkdown } from "../src/rich-text.js";
import { TaskService, type TaskPlanningReadModel, type TaskPlanningUpdate } from "../src/tasks.js";
import { OrganizationRoleService, type BuiltInOrganizationRole } from "../src/organization-roles.js";

const noteId = "99999999-9999-4999-8999-999999999999";
const secondNoteId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const richNoteId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const emptyCodeNoteId = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
const principalBoundaryNoteId = "12121212-1212-4212-8212-121212121212";
const seededDocument = collaborativeDocumentFromRichText({ type: "doc", blocks: [{ type: "paragraph", blockKey: "77777777-7777-4777-8777-777777777777",
  id: "66666666-6666-4666-8666-666666666666", content: [{ text: "Preserve this linked Block" }] }] });
const secondSeededDocument = collaborativeDocumentFromRichText({ type: "doc", blocks: [{ type: "paragraph",
  blockKey: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", content: [{ text: "Authoritative second Note" }] }] });
const richSeededDocument = collaborativeDocumentFromRichText({ type: "doc", blocks: [{ type: "paragraph",
  blockKey: "dddddddd-dddd-4ddd-8ddd-dddddddddddd", content: [{ text: "Rich structure seed" }] }] });
const emptyCodeSeededDocument = collaborativeDocumentFromRichText({ type: "doc", blocks: [{ type: "paragraph",
  blockKey: "ffffffff-ffff-4fff-8fff-ffffffffffff", content: [{ text: "Clear this content" }] }] });
const principalBoundaryDocument = collaborativeDocumentFromRichText({ type: "doc", blocks: [{ type: "paragraph",
  blockKey: "13131313-1313-4313-8313-131313131313", content: [{ text: "Principal boundary seed" }] }] });
const collaborations = new Map<string, CollaborationSnapshot>([
  [noteId, { noteId, sequence: 0, update: Y.encodeStateAsUpdate(seededDocument), updatedAt: new Date(0).toISOString(), updatedByMemberId: "browser-member", access: "edit" }],
  [secondNoteId, { noteId: secondNoteId, sequence: 0, update: Y.encodeStateAsUpdate(secondSeededDocument), updatedAt: new Date(0).toISOString(), updatedByMemberId: "browser-member", access: "edit" }],
  [richNoteId, { noteId: richNoteId, sequence: 0, update: Y.encodeStateAsUpdate(richSeededDocument), updatedAt: new Date(0).toISOString(), updatedByMemberId: "browser-member", access: "edit" }],
  [emptyCodeNoteId, { noteId: emptyCodeNoteId, sequence: 0, update: Y.encodeStateAsUpdate(emptyCodeSeededDocument), updatedAt: new Date(0).toISOString(), updatedByMemberId: "browser-member", access: "edit" }],
  [principalBoundaryNoteId, { noteId: principalBoundaryNoteId, sequence: 0, update: Y.encodeStateAsUpdate(principalBoundaryDocument), updatedAt: new Date(0).toISOString(), updatedByMemberId: "browser-member", access: "edit" }],
]);
seededDocument.destroy();
secondSeededDocument.destroy();
richSeededDocument.destroy();
emptyCodeSeededDocument.destroy();
principalBoundaryDocument.destroy();
const collaborationRepository = {
  async loadNoteCollaboration(memberId: string, requestedNoteId: string) {
    if (![browserMemberId, "browser-second-member", "browser-guest"].includes(memberId)) return undefined;
    const snapshot = collaborations.get(requestedNoteId);
    return snapshot ? { ...snapshot, access: memberId === "browser-guest" ? "read" as const : "edit" as const } : undefined;
  },
  async appendNoteCollaboration(memberId: string, requestedNoteId: string, update: Uint8Array) {
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
    const { formerAssigneeIds: _previousFormerAssignees, ...currentTask } = task;
    task = { ...currentTask, assigneeIds, ...(!reassigned && formerAssigneeIds.length ? { formerAssigneeIds } : {}), revision: task.revision + 1 };
    return { status: "updated" as const, task };
  },
};

const instance = await startInstance({
  database: { async verifyConnection() {}, async close() {}, async resolveClientSessionPrincipal(accountId: string) {
    if (![browserMemberId, "browser-second-member", "browser-guest"].includes(accountId)) return undefined;
    return { member: { id: accountId,
      name: accountId === browserMemberId ? "Browser Member" : accountId === "browser-second-member" ? "Second Browser Member" : "Browser Guest",
      email: accountId === browserMemberId ? "member@stash.test" : `${accountId}@stash.test` },
      workspace: { id: "browser-workspace", name: "Acceptance Workspace" }, capabilities: [], ...(accountId === browserMemberId ? {
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
  memberAccess: {
    async authenticateBearer(authorization) {
      const token = authorization?.replace(/^Bearer /, "");
      const accountId = token ? activeTokens.get(token) : undefined;
      return accountId ? { accountId, sessionId: `session-${accountId}` } : undefined;
    },
  },
  notes: { async get(memberId: string, requestedNoteId: string) { if (![browserMemberId, "browser-second-member", "browser-guest"].includes(memberId) || !collaborations.has(requestedNoteId)) return undefined;
    if (requestedNoteId === richNoteId) { const current = new Y.Doc(); Y.applyUpdate(current, collaborations.get(requestedNoteId)!.update);
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
  tasks: new TaskService(taskRepository, { async findPortableMemberIdentity() { return undefined; } }),
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
