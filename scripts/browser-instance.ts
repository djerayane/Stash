import { fileURLToPath } from "node:url";

import { startInstance } from "../src/instance.js";
import { NoteCollaborationService, type CollaborationSnapshot } from "../src/note-collaboration.js";
import * as Y from "yjs";
import { collaborativeDocumentFromRichText } from "../src/postgres-database.js";

const noteId = "99999999-9999-4999-8999-999999999999";
const seededDocument = collaborativeDocumentFromRichText({ type: "doc", blocks: [{ type: "paragraph", blockKey: "77777777-7777-4777-8777-777777777777",
  id: "66666666-6666-4666-8666-666666666666", content: [{ text: "Preserve this linked Block" }] }] });
let collaboration: CollaborationSnapshot | undefined = { noteId, sequence: 0, update: Y.encodeStateAsUpdate(seededDocument),
  updatedAt: new Date(0).toISOString(), updatedByMemberId: "browser-member" };
seededDocument.destroy();
const collaborationRepository = {
  async loadNoteCollaboration(memberId: string, requestedNoteId: string) {
    if (memberId !== "browser-member" || requestedNoteId !== noteId) return undefined;
    return collaboration ?? { noteId, sequence: 0, update: Y.encodeStateAsUpdate(new Y.Doc()), updatedAt: new Date(0).toISOString(), updatedByMemberId: memberId };
  },
  async appendNoteCollaboration(memberId: string, requestedNoteId: string, update: Uint8Array) {
    if (memberId !== "browser-member" || requestedNoteId !== noteId) return undefined;
    const document = new Y.Doc(); if (collaboration) Y.applyUpdate(document, collaboration.update); Y.applyUpdate(document, update);
    return collaboration = { noteId, sequence: (collaboration?.sequence ?? 0) + 1, update: Y.encodeStateAsUpdate(document), updatedAt: new Date().toISOString(), updatedByMemberId: memberId };
  },
};

const instance = await startInstance({
  database: { async verifyConnection() {}, async close() {}, async resolveClientSessionPrincipal(accountId: string) {
    return accountId === "browser-member" ? { member: { id: accountId, name: "Browser Member", email: "member@stash.test" },
      workspace: { id: "browser-workspace", name: "Acceptance Workspace" }, capabilities: [] } : undefined;
  } },
  host: "127.0.0.1",
  port: Number.parseInt(process.env.STASH_BROWSER_PORT ?? "4173", 10),
  instanceAdminToken: "browser-acceptance-admin-token",
  memberAccess: {
    async authenticateBearer(authorization) {
      return authorization === "Bearer browser-acceptance-member-token"
        ? { accountId: "browser-member", sessionId: "browser-session" }
        : undefined;
    },
  },
  notes: { async get(memberId: string, requestedNoteId: string) { return memberId === "browser-member" && requestedNoteId === noteId ? {
    id: noteId, workspaceId: "88888888-8888-4888-8888-888888888888", content: "Release collaboration plan", revision: 1,
    document: { type: "doc", blocks: [{ type: "paragraph", blockKey: "77777777-7777-4777-8777-777777777777",
      id: "66666666-6666-4666-8666-666666666666", content: [{ text: "Preserve this linked Block" }] }] },
    tags: [], createdByMemberId: memberId, createdAt: new Date(0).toISOString(),
  } : undefined; } } as any,
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
