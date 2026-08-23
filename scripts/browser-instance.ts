import { fileURLToPath } from "node:url";

import { startInstance } from "../src/instance.js";
import { NoteCollaborationService, type CollaborationSnapshot } from "../src/note-collaboration.js";
import * as Y from "yjs";
import { collaborativeDocumentFromRichText } from "../src/postgres-database.js";

const noteId = "99999999-9999-4999-8999-999999999999";
const secondNoteId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const richNoteId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const seededDocument = collaborativeDocumentFromRichText({ type: "doc", blocks: [{ type: "paragraph", blockKey: "77777777-7777-4777-8777-777777777777",
  id: "66666666-6666-4666-8666-666666666666", content: [{ text: "Preserve this linked Block" }] }] });
const secondSeededDocument = collaborativeDocumentFromRichText({ type: "doc", blocks: [{ type: "paragraph",
  blockKey: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", content: [{ text: "Authoritative second Note" }] }] });
const richSeededDocument = collaborativeDocumentFromRichText({ type: "doc", blocks: [{ type: "paragraph",
  blockKey: "dddddddd-dddd-4ddd-8ddd-dddddddddddd", content: [{ text: "Rich structure seed" }] }] });
const collaborations = new Map<string, CollaborationSnapshot>([
  [noteId, { noteId, sequence: 0, update: Y.encodeStateAsUpdate(seededDocument), updatedAt: new Date(0).toISOString(), updatedByMemberId: "browser-member", access: "edit" }],
  [secondNoteId, { noteId: secondNoteId, sequence: 0, update: Y.encodeStateAsUpdate(secondSeededDocument), updatedAt: new Date(0).toISOString(), updatedByMemberId: "browser-member", access: "edit" }],
  [richNoteId, { noteId: richNoteId, sequence: 0, update: Y.encodeStateAsUpdate(richSeededDocument), updatedAt: new Date(0).toISOString(), updatedByMemberId: "browser-member", access: "edit" }],
]);
seededDocument.destroy();
secondSeededDocument.destroy();
richSeededDocument.destroy();
const collaborationRepository = {
  async loadNoteCollaboration(memberId: string, requestedNoteId: string) {
    if (!["browser-member", "browser-guest"].includes(memberId)) return undefined;
    const snapshot = collaborations.get(requestedNoteId);
    return snapshot ? { ...snapshot, access: memberId === "browser-member" ? "edit" as const : "read" as const } : undefined;
  },
  async appendNoteCollaboration(memberId: string, requestedNoteId: string, update: Uint8Array) {
    const collaboration = collaborations.get(requestedNoteId);
    if (memberId !== "browser-member" || !collaboration) return undefined;
    const document = new Y.Doc(); Y.applyUpdate(document, collaboration.update); Y.applyUpdate(document, update);
    const next = { noteId: requestedNoteId, sequence: collaboration.sequence + 1, update: Y.encodeStateAsUpdate(document),
      updatedAt: new Date().toISOString(), updatedByMemberId: memberId, access: "edit" as const };
    collaborations.set(requestedNoteId, next); return next;
  },
};

const instance = await startInstance({
  database: { async verifyConnection() {}, async close() {}, async resolveClientSessionPrincipal(accountId: string) {
    return ["browser-member", "browser-guest"].includes(accountId) ? { member: { id: accountId, name: accountId === "browser-member" ? "Browser Member" : "Browser Guest", email: `${accountId}@stash.test` },
      workspace: { id: "browser-workspace", name: "Acceptance Workspace" }, capabilities: [] } : undefined;
  } },
  host: "127.0.0.1",
  port: Number.parseInt(process.env.STASH_BROWSER_PORT ?? "4173", 10),
  instanceAdminToken: "browser-acceptance-admin-token",
  memberAccess: {
    async authenticateBearer(authorization) {
      if (authorization === "Bearer browser-acceptance-member-token") return { accountId: "browser-member", sessionId: "browser-session" };
      if (authorization === "Bearer browser-acceptance-guest-token") return { accountId: "browser-guest", sessionId: "browser-guest-session" };
      return undefined;
    },
  },
  notes: { async get(memberId: string, requestedNoteId: string) { if (!["browser-member", "browser-guest"].includes(memberId) || !collaborations.has(requestedNoteId)) return undefined;
    const second = requestedNoteId === secondNoteId; return {
    id: requestedNoteId, workspaceId: "88888888-8888-4888-8888-888888888888", content: second ? "Stale canonical second Note" : "Release collaboration plan", revision: 1,
    document: { type: "doc", blocks: [{ type: "paragraph", blockKey: second ? "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" : "77777777-7777-4777-8777-777777777777",
      ...(second ? {} : { id: "66666666-6666-4666-8666-666666666666" }), content: [{ text: second ? "Stale canonical second Note" : "Preserve this linked Block" }] }] },
    tags: [], createdByMemberId: memberId, createdAt: new Date(0).toISOString(),
  }; } } as any,
  noteCollaboration: new NoteCollaborationService(collaborationRepository),
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
