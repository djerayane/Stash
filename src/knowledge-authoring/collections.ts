import type { PostgresQueryable } from "../instance-operations/storage/postgres-kernel.js";

export interface CollectionProperty {
  id: string; name: string; type: "text"; position: number;
}
export interface CollectionRecord {
  id: string; position: number; values: Record<string, string>;
}
export interface Collection {
  schema: "stash.collection.v1"; id: string; workspaceId: string; ownerNoteId: string; title: string;
  properties: CollectionProperty[]; records: CollectionRecord[];
}
export interface ViewBlock {
  schema: "stash.view-block.v1"; id: string; workspaceId: string; ownerNoteId: string; blockId: string;
  title: string; source: { kind: "tasks"; workspaceId: string; project: "none" };
  definition: { query: { scope: "projectless"; titleContains: string }; layout: "list" | "table" };
}
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
  inspect(memberId: string, noteIds: readonly string[]): Promise<{ collectionCount: number }>;
}

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
