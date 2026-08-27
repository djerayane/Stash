import type { PostgresQueryable } from "../instance-operations/storage/postgres-kernel.js";
import { normalizeCollection, normalizeViewBlock, normalizeViewDefinition, type Collection as CanonicalCollection,
  type CollectionProperty as CanonicalProperty, type CollectionRecord as CanonicalRecord, type CollectionPropertyValue,
  type ViewBlock as CanonicalViewBlock, type ViewDefinition } from "@stash/domain-types";
import type { CollectionImpact } from "@stash/domain-types";

export type CollectionViewResult =
  | { status: "found"; view: CanonicalViewBlock; source: { kind: "collection"; collection: CanonicalCollection } }
  | { status: "found"; view: CanonicalViewBlock; source: { kind: "tasks"; records: readonly unknown[]; statuses: readonly unknown[] } }
  | { status: "view_not_found" | "source_unavailable" };

export interface CollectionRepository {
  create(memberId: string, collection: CanonicalCollection): Promise<
    { status: "created"; collection: CanonicalCollection }
    | { status: "note_not_found" | "workspace_mismatch" | "collection_conflict" }>;
  readCollection(memberId: string, collectionId: string): Promise<
    { status: "found"; collection: CanonicalCollection } | { status: "collection_not_found" }>;
  renameCollection(memberId: string, collectionId: string, title: string): Promise<{ status: "updated" } | { status: "collection_not_found" }>;
  renameCollectionProperty(memberId: string, collectionId: string, propertyId: string, name: string): Promise<
    { status: "updated" } | { status: "collection_not_found" | "property_not_found" }>;
  createCollectionProperty(memberId: string, collectionId: string, property: CanonicalProperty): Promise<
    { status: "created"; property: CanonicalProperty } | { status: "collection_not_found" | "property_conflict" }>;
  moveCollectionRecord(memberId: string, collectionId: string, recordId: string, beforeId?: string): Promise<
    { status: "moved" } | { status: "collection_not_found" | "record_not_found" | "before_not_found" }>;
  createCollectionRecord(memberId: string, collectionId: string, record: CanonicalRecord): Promise<
    { status: "created"; record: CanonicalRecord } | { status: "collection_not_found" | "record_conflict" }>;
  updateCollectionRecord(memberId: string, collectionId: string, record: CanonicalRecord): Promise<
    { status: "updated"; record: CanonicalRecord } | { status: "collection_not_found" | "record_not_found" }>;
  createCanonicalViewBlock(memberId: string, view: CanonicalViewBlock): Promise<
    { status: "created"; view: CanonicalViewBlock } | { status: "note_not_found" | "workspace_mismatch" | "source_unavailable" | "view_conflict" }>;
  readCanonicalViewBlock(memberId: string, viewId: string): Promise<CollectionViewResult>;
  updateCanonicalViewBlock(memberId: string, viewId: string, definition: ViewDefinition): Promise<
    { status: "updated" } | { status: "view_not_found" | "source_unavailable" }>;
  listCollectionsForNote(memberId: string, noteId: string): Promise<
    { status: "found"; workspaceId: string; collections: readonly CanonicalCollection[]; availableCollections: readonly CanonicalCollection[];
      views: readonly CanonicalViewBlock[] } | { status: "note_not_found" }>;
  previewCollectionRemoval(memberId: string, noteId: string): Promise<{ status: "found"; impact: CollectionImpact } | { status: "note_not_found" }>;
  relocateCollections(memberId: string, noteId: string, destinationNoteId: string, collectionIds: readonly string[]): Promise<
    { status: "relocated"; collectionIds: readonly string[] } | { status: "note_not_found" | "destination_not_found" | "collection_not_found" }>;
  deleteCollections(memberId: string, noteId: string, collectionIds: readonly string[], impactToken: string): Promise<
    { status: "deleted"; collectionIds: readonly string[] } | { status: "note_not_found" | "collection_not_found" | "impact_changed" }>;
}

export class InvalidCollectionInput extends Error {}

export class CollectionService {
  constructor(private readonly repository: CollectionRepository) {}

  create(memberId: string, ownerNoteId: string, value: unknown) {
    let collection: CanonicalCollection;
    try { collection = normalizeCollection(value); } catch { throw new InvalidCollectionInput(); }
    if (!uuid.test(ownerNoteId) || collection.ownerNoteId !== ownerNoteId) throw new InvalidCollectionInput();
    return this.repository.create(memberId, collection);
  }

  read(memberId: string, collectionId: string) {
    if (!uuid.test(collectionId)) throw new InvalidCollectionInput();
    return this.repository.readCollection(memberId, collectionId);
  }

  rename(memberId: string, collectionId: string, value: unknown) {
    if (!uuid.test(collectionId) || !value || typeof value !== "object" || Array.isArray(value)) throw new InvalidCollectionInput();
    const input = value as Record<string, unknown>; const keys = Object.keys(input);
    if (keys.length === 1 && keys[0] === "title" && text(input.title, 120))
      return this.repository.renameCollection(memberId, collectionId, String(input.title).trim());
    if (keys.length === 2 && keys.includes("propertyId") && keys.includes("name") && uuid.test(String(input.propertyId)) && text(input.name, 120))
      return this.repository.renameCollectionProperty(memberId, collectionId, String(input.propertyId), String(input.name).trim());
    throw new InvalidCollectionInput();
  }

  async createProperty(memberId: string, collectionId: string, value: unknown) {
    if (!uuid.test(collectionId)) throw new InvalidCollectionInput();
    const current = await this.repository.readCollection(memberId, collectionId);
    if (current.status !== "found") return current;
    let normalized: CanonicalCollection;
    try { normalized = normalizeCollection({ ...current.collection, properties: [...current.collection.properties, value] }); }
    catch { throw new InvalidCollectionInput(); }
    return this.repository.createCollectionProperty(memberId, collectionId, normalized.properties.at(-1)!);
  }

  moveRecord(memberId: string, collectionId: string, recordId: string, value: unknown) {
    if (!uuid.test(collectionId) || !uuid.test(recordId) || !value || typeof value !== "object" || Array.isArray(value)
      || Object.keys(value).some((key) => key !== "beforeId")) throw new InvalidCollectionInput();
    const beforeId = (value as Record<string, unknown>).beforeId;
    if (beforeId !== undefined && !uuid.test(String(beforeId))) throw new InvalidCollectionInput();
    return this.repository.moveCollectionRecord(memberId, collectionId, recordId, typeof beforeId === "string" ? beforeId : undefined);
  }

  async createRecord(memberId: string, collectionId: string, value: unknown) {
    if (!uuid.test(collectionId)) throw new InvalidCollectionInput();
    const current = await this.repository.readCollection(memberId, collectionId);
    if (current.status !== "found") return current;
    let normalized: CanonicalCollection;
    try { normalized = normalizeCollection({ ...current.collection, records: [...current.collection.records, value] }); }
    catch { throw new InvalidCollectionInput(); }
    return this.repository.createCollectionRecord(memberId, collectionId, normalized.records.at(-1)!);
  }

  async updateRecord(memberId: string, collectionId: string, recordId: string, value: unknown) {
    if (!uuid.test(collectionId) || !uuid.test(recordId) || !value || typeof value !== "object" || Array.isArray(value)
      || Object.keys(value).length !== 1 || !Object.hasOwn(value, "values") || !(value as Record<string, unknown>).values
      || typeof (value as Record<string, unknown>).values !== "object" || Array.isArray((value as Record<string, unknown>).values))
      throw new InvalidCollectionInput();
    const current = await this.repository.readCollection(memberId, collectionId);
    if (current.status !== "found") return current;
    const found = current.collection.records.find(({ id }) => id === recordId);
    if (!found) return { status: "record_not_found" as const };
    let normalized: CanonicalCollection;
    try { normalized = normalizeCollection({ ...current.collection, records: current.collection.records.map((record) => record.id === recordId
      ? { ...record, values: { ...record.values, ...(value as { values: Record<string, CollectionPropertyValue> }).values } } : record) }); }
    catch { throw new InvalidCollectionInput(); }
    return this.repository.updateCollectionRecord(memberId, collectionId, normalized.records.find(({ id }) => id === recordId)!);
  }

  createView(memberId: string, ownerNoteId: string, value: unknown) {
    let view: CanonicalViewBlock;
    try { view = normalizeViewBlock(value); } catch { throw new InvalidCollectionInput(); }
    if (!uuid.test(ownerNoteId) || view.ownerNoteId !== ownerNoteId) throw new InvalidCollectionInput();
    return this.repository.createCanonicalViewBlock(memberId, view);
  }

  readView(memberId: string, viewId: string) {
    if (!uuid.test(viewId)) throw new InvalidCollectionInput();
    return this.repository.readCanonicalViewBlock(memberId, viewId);
  }

  updateView(memberId: string, viewId: string, value: unknown) {
    if (!uuid.test(viewId)) throw new InvalidCollectionInput();
    let definition: ViewDefinition;
    try { definition = normalizeViewDefinition(value); } catch { throw new InvalidCollectionInput(); }
    return this.repository.updateCanonicalViewBlock(memberId, viewId, definition);
  }

  listForNote(memberId: string, noteId: string) {
    if (!uuid.test(noteId)) throw new InvalidCollectionInput(); return this.repository.listCollectionsForNote(memberId, noteId);
  }

  previewRemoval(memberId: string, noteId: string) {
    if (!uuid.test(noteId)) throw new InvalidCollectionInput(); return this.repository.previewCollectionRemoval(memberId, noteId);
  }

  relocate(memberId: string, noteId: string, value: unknown) {
    if (!uuid.test(noteId) || !value || typeof value !== "object" || Array.isArray(value)) throw new InvalidCollectionInput();
    const input = value as Record<string, unknown>;
    if (Object.keys(input).length !== 2 || !uuid.test(String(input.destinationNoteId)) || !Array.isArray(input.collectionIds)
      || !input.collectionIds.length || input.collectionIds.some((id) => !uuid.test(String(id))) || new Set(input.collectionIds).size !== input.collectionIds.length)
      throw new InvalidCollectionInput();
    return this.repository.relocateCollections(memberId, noteId, String(input.destinationNoteId), input.collectionIds.map(String));
  }

  delete(memberId: string, noteId: string, value: unknown) {
    if (!uuid.test(noteId) || !value || typeof value !== "object" || Array.isArray(value)) throw new InvalidCollectionInput();
    const input = value as Record<string, unknown>;
    if (Object.keys(input).length !== 3 || input.confirmed !== true || typeof input.impactToken !== "string"
      || !Array.isArray(input.collectionIds) || !input.collectionIds.length || input.collectionIds.some((id) => !uuid.test(String(id)))
      || new Set(input.collectionIds).size !== input.collectionIds.length) throw new InvalidCollectionInput();
    return this.repository.deleteCollections(memberId, noteId, input.collectionIds.map(String), input.impactToken);
  }
}

export type CollectionProperty = import("@stash/domain-types").CollectionProperty;
export type CollectionRecord = import("@stash/domain-types").CollectionRecord;
export type Collection = CanonicalCollection;
export type ViewBlock = CanonicalViewBlock;
export interface StarterKnowledgeSetup {
  rootNoteId: string;
  collection: Collection;
  viewBlock: ViewBlock;
}
export interface TutorialContribution {
  workspaceId: string;
  rootNoteId: string;
  notes: Array<{ id: string; title: string; content: string; parentId?: string }>;
  links: Array<{ id: string; sourceNoteId: string; targetNoteId: string; label: string }>;
  collection: Collection;
  viewBlock: ViewBlock;
}

export interface TutorialContributionRepository {
  prepare(client: PostgresQueryable): Promise<void>;
  seed(client: PostgresQueryable, input: StarterKnowledgeSetup,
    lifecycle: { workflowStatusId: string; sampleTaskIds: string[] }): Promise<void>;
  read(memberId: string, noteId: string): Promise<TutorialContribution | undefined>;
  updateCollection(memberId: string, noteId: string,
    input: { title?: string; recordValue?: string }): Promise<TutorialContribution | undefined>;
  updateViewBlock(memberId: string, noteId: string,
    input: { layout: "list" | "table"; titleContains: string }): Promise<TutorialContribution | undefined>;
  remove(memberId: string, noteId: string): Promise<"removed" | "not_found">;
  inspect(memberId: string, noteIds: readonly string[], action: "archive" | "trash" | "move"): Promise<{
    collectionCount: number;
    collectionRelocationRequired?: boolean;
  }>;
}

/** The narrow transactional seam identity setup needs from knowledge authoring. */
export type StarterKnowledgeSeeder = Pick<TutorialContributionRepository, "prepare" | "seed">;

export class InvalidTutorialContributionInput extends Error {}

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const text = (value: unknown, maximum: number) => typeof value === "string" && Boolean(value.trim())
  && value.trim().length <= maximum && !/[\r\n]/.test(value);

export class TutorialContributionService {
  constructor(private readonly repository: TutorialContributionRepository) {}

  read(memberId: string, noteId: string) {
    if (!uuid.test(noteId)) throw new InvalidTutorialContributionInput();
    return this.repository.read(memberId, noteId);
  }

  updateCollection(memberId: string, noteId: string, value: unknown) {
    if (!uuid.test(noteId) || !value || typeof value !== "object" || Array.isArray(value)) throw new InvalidTutorialContributionInput();
    const input = value as Record<string, unknown>;
    if (!Object.keys(input).length || !Object.keys(input).every((key) => key === "title" || key === "recordValue")
      || input.title !== undefined && !text(input.title, 120)
      || input.recordValue !== undefined && !text(input.recordValue, 500)) throw new InvalidTutorialContributionInput();
    return this.repository.updateCollection(memberId, noteId, {
      ...(typeof input.title === "string" ? { title: input.title.trim() } : {}),
      ...(typeof input.recordValue === "string" ? { recordValue: input.recordValue.trim() } : {}),
    });
  }

  updateViewBlock(memberId: string, noteId: string, value: unknown) {
    if (!uuid.test(noteId) || !value || typeof value !== "object" || Array.isArray(value)) throw new InvalidTutorialContributionInput();
    const input = value as Record<string, unknown>;
    if (Object.keys(input).length !== 2 || !["list", "table"].includes(String(input.layout))
      || typeof input.titleContains !== "string" || input.titleContains.length > 120 || /[\r\n]/.test(input.titleContains))
      throw new InvalidTutorialContributionInput();
    return this.repository.updateViewBlock(memberId, noteId, {
      layout: input.layout as "list" | "table", titleContains: input.titleContains.trim(),
    });
  }

  remove(memberId: string, noteId: string, value: unknown) {
    if (!uuid.test(noteId) || !value || typeof value !== "object" || Array.isArray(value)
      || Object.keys(value).length !== 1 || (value as Record<string, unknown>).confirmed !== true)
      throw new InvalidTutorialContributionInput();
    return this.repository.remove(memberId, noteId);
  }
}
