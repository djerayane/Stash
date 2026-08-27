import { randomUUID } from "node:crypto";

export interface NoteTreeNode {
  id: string;
  workspaceId: string;
  parentId?: string;
  title: string;
  position: string;
  childCount: number;
}

export interface NoteTreeAccessChange {
  noteId: string;
  noteTitle: string;
  projectId: string;
  projectName: string;
  effect: "gained" | "lost";
}

export interface NoteBranchImpact {
  noteId: string;
  title: string;
  descendantCount: number;
  descendants: Array<{ noteId: string; title: string }>;
  collectionCount: number;
  collectionRelocationRequired: boolean;
  externalLinks: Array<{ noteId: string; title: string; direction: "incoming" | "outgoing" }>;
  projectAccessChanges: NoteTreeAccessChange[];
}

export interface NoteBranchRepositoryImpact extends Omit<NoteBranchImpact, "collectionCount" | "collectionRelocationRequired"> {
  affectedNoteIds: string[];
}

export interface RemovedNoteBranch {
  id: string;
  workspaceId: string;
  title: string;
  state: "archived" | "trashed";
  removedAt: string;
}

export interface NoteTreeImpactInspector {
  inspect(memberId: string, noteIds: readonly string[]): Promise<{
    collectionCount: number;
    collectionRelocationRequired?: boolean;
  }>;
}

/** Used by deployments that have no Collection impact provider registered. */
export class EmptyCollectionImpactInspector implements NoteTreeImpactInspector {
  async inspect(): Promise<{ collectionCount: number }> { return { collectionCount: 0 }; }
}

export interface NoteBreadcrumb {
  id: string;
  title: string;
}

export interface NoteContextLink {
  id: string;
  noteId: string;
  title: string;
  label: string;
  relationshipType?: string;
}

export interface NoteContext {
  noteId: string;
  workspaceId: string;
  state: "active";
  parent?: NoteBreadcrumb;
  revision: number;
  createdAt: string;
  historyCount: number;
  access: "edit" | "read";
  accessSource: "workspace" | "project";
  breadcrumbs: NoteBreadcrumb[];
  outgoingLinks: NoteContextLink[];
  backlinks: NoteContextLink[];
  projectIds: string[];
  projects: Array<{ id: string; name: string; key: string }>;
}

export interface NoteTreeRepository {
  createTreeNote(
    memberId: string,
    workspaceId: string,
    input: { id: string; title: string; parentId?: string; beforeId?: string },
  ): Promise<{ status: "created"; node: NoteTreeNode } | { status: "workspace_forbidden" | "parent_not_found" | "before_not_found" }>;
  listNoteTree(memberId: string, workspaceId: string): Promise<
    { status: "found"; nodes: NoteTreeNode[] } | { status: "workspace_forbidden" }
  >;
  moveNoteTreeBranch(
    memberId: string,
    noteId: string,
    destination: { parentId?: string; beforeId?: string },
  ): Promise<
    | { status: "moved"; movedIds: string[]; projectAccessChanges: NoteTreeAccessChange[] }
    | { status: "unchanged"; movedIds: string[]; projectAccessChanges: [] }
    | { status: "note_not_found" | "parent_not_found" | "before_not_found" | "cycle" }
  >;
  readNoteTreeContext(memberId: string, noteId: string): Promise<
    { status: "found"; context: NoteContext } | { status: "note_not_found" }
  >;
  createContextLink(memberId: string, sourceNoteId: string,
    link: { id: string; targetNoteId: string; label: string; relationshipType?: string }): Promise<
      { status: "created"; link: NoteContextLink } | { status: "source_not_found" | "target_not_found" | "already_linked" }
    >;
  previewNoteBranch(
    memberId: string,
    noteId: string,
    action: "archive" | "trash" | "move",
    destination?: { parentId?: string; beforeId?: string },
  ): Promise<{ status: "found"; impact: NoteBranchRepositoryImpact } | { status: "note_not_found" | "parent_not_found" | "before_not_found" | "cycle" }>;
  listRemovedNoteBranches(memberId: string, workspaceId: string): Promise<
    { status: "found"; branches: RemovedNoteBranch[] } | { status: "workspace_forbidden" }
  >;
  setNoteBranchState(memberId: string, noteId: string, state: "archived" | "trashed"): Promise<
    { status: "updated"; affectedIds: string[] }
    | { status: "note_not_found" | "collection_owner_requires_relocation" }
  >;
  restoreNoteBranch(memberId: string, noteId: string): Promise<
    { status: "restored"; restoredIds: string[]; parentRestored: boolean } | { status: "note_not_found" }
  >;
}

export class InvalidNoteTreeInput extends Error {}

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);

function optionalUuid(value: unknown): value is string | undefined {
  return value === undefined || typeof value === "string" && uuid.test(value);
}

function title(value: unknown): string {
  if (typeof value !== "string" || !value.trim() || value.trim().length > 240 || /[\r\n]/.test(value)) throw new InvalidNoteTreeInput();
  return value.trim();
}

function linkLabel(value: unknown): string {
  if (value === undefined) return "Note";
  if (typeof value !== "string" || !value.trim() || value.length > 200 || /[\r\n\[\]]/.test(value)) throw new InvalidNoteTreeInput();
  return value.trim();
}

function relationshipType(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !value.trim() || value.trim().length > 80 || /[\r\n]/.test(value)) throw new InvalidNoteTreeInput();
  return value.trim();
}

function destination(value: unknown): { parentId?: string; beforeId?: string } {
  if (!object(value) || !optionalUuid(value.parentId) || !optionalUuid(value.beforeId)
    || !Object.keys(value).every((key) => key === "parentId" || key === "beforeId")) throw new InvalidNoteTreeInput();
  return { ...(value.parentId ? { parentId: value.parentId } : {}), ...(value.beforeId ? { beforeId: value.beforeId } : {}) };
}

export class NoteTreeService {
  constructor(private readonly repository: NoteTreeRepository, private readonly impactInspector: NoteTreeImpactInspector) {}

  async create(memberId: string, workspaceId: string, value: unknown) {
    if (!uuid.test(workspaceId) || !object(value) || !optionalUuid(value.parentId) || !optionalUuid(value.beforeId)
      || !Object.keys(value).every((key) => ["title", "parentId", "beforeId"].includes(key))) throw new InvalidNoteTreeInput();
    return this.repository.createTreeNote(memberId, workspaceId, {
      id: randomUUID(),
      title: title(value.title),
      ...(value.parentId ? { parentId: value.parentId } : {}),
      ...(value.beforeId ? { beforeId: value.beforeId } : {}),
    });
  }

  async list(memberId: string, workspaceId: string) {
    if (!uuid.test(workspaceId)) throw new InvalidNoteTreeInput();
    return this.repository.listNoteTree(memberId, workspaceId);
  }

  async moveNoteBranch(noteId: string, value: unknown, actorId: string) {
    if (!uuid.test(noteId)) throw new InvalidNoteTreeInput();
    return this.repository.moveNoteTreeBranch(actorId, noteId, destination(value));
  }

  async context(memberId: string, noteId: string) {
    if (!uuid.test(noteId)) throw new InvalidNoteTreeInput();
    return this.repository.readNoteTreeContext(memberId, noteId);
  }

  async createContextLink(memberId: string, noteId: string, value: unknown) {
    if (!uuid.test(noteId) || !object(value) || typeof value.targetNoteId !== "string" || !uuid.test(value.targetNoteId)
      || value.targetNoteId === noteId || !Object.keys(value).every((key) => ["targetNoteId", "label", "relationshipType"].includes(key)))
      throw new InvalidNoteTreeInput();
    const semanticType = relationshipType(value.relationshipType);
    return this.repository.createContextLink(memberId, noteId, { id: randomUUID(), targetNoteId: value.targetNoteId,
      label: linkLabel(value.label), ...(semanticType ? { relationshipType: semanticType } : {}) });
  }

  async preview(memberId: string, noteId: string, value: unknown) {
    if (!uuid.test(noteId) || !object(value) || !["archive", "trash", "move"].includes(String(value.action))
      || !Object.keys(value).every((key) => ["action", "parentId", "beforeId"].includes(key))) throw new InvalidNoteTreeInput();
    const action = value.action as "archive" | "trash" | "move";
    const target = action === "move" ? destination({ parentId: value.parentId, beforeId: value.beforeId }) : undefined;
    const result = await this.repository.previewNoteBranch(memberId, noteId, action, target);
    if (result.status !== "found") return result;
    const { affectedNoteIds, ...impact } = result.impact;
    const inspected = await this.impactInspector.inspect(memberId, affectedNoteIds);
    return { status: "found" as const, impact: { ...impact, collectionCount: inspected.collectionCount,
      collectionRelocationRequired: inspected.collectionRelocationRequired === true } };
  }

  async removed(memberId: string, workspaceId: string) {
    if (!uuid.test(workspaceId)) throw new InvalidNoteTreeInput();
    return this.repository.listRemovedNoteBranches(memberId, workspaceId);
  }

  async remove(memberId: string, noteId: string, state: "archived" | "trashed") {
    if (!uuid.test(noteId)) throw new InvalidNoteTreeInput();
    return this.repository.setNoteBranchState(memberId, noteId, state);
  }

  async restore(memberId: string, noteId: string) {
    if (!uuid.test(noteId)) throw new InvalidNoteTreeInput();
    return this.repository.restoreNoteBranch(memberId, noteId);
  }
}
