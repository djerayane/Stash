import type { VisualizationDefinition } from "@stash/domain-types";
import { normalizeVisualizationDefinition } from "@stash/domain-types";

export interface SavedVisualizationBlock { readonly noteId: string; readonly definition: VisualizationDefinition; readonly revision: number }
export interface VisualizationBlockRepository {
  save(memberId: string, noteId: string, definition: VisualizationDefinition, expectedRevision?: number): Promise<
    { status: "saved"; block: SavedVisualizationBlock } | { status: "not_found" } | { status: "changed"; block: SavedVisualizationBlock }>;
  read(memberId: string, noteId: string, blockId: string): Promise<
    { status: "found"; block: SavedVisualizationBlock } | { status: "not_found" }>;
  promoteViewEdge(memberId: string, noteId: string, blockId: string, edgeId: string, idempotencyKey: string): Promise<
    { status: "promoted"; linkId: string; activityId: string } | { status: "not_found" | "edge_not_found" | "already_linked" }>;
}

export class InvalidVisualizationBlock extends Error {}
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export class VisualizationBlockService {
  constructor(private readonly repository: VisualizationBlockRepository) {}
  async save(memberId: string, noteId: string, value: unknown, expectedRevision?: number) {
    if (!uuid.test(noteId) || expectedRevision !== undefined && (!Number.isInteger(expectedRevision) || expectedRevision < 1)) throw new InvalidVisualizationBlock();
    let definition: VisualizationDefinition; try { definition = normalizeVisualizationDefinition(value); } catch { throw new InvalidVisualizationBlock(); }
    return this.repository.save(memberId, noteId, definition, expectedRevision);
  }
  async read(memberId: string, noteId: string, blockId: string) {
    if (!uuid.test(noteId) || !uuid.test(blockId)) throw new InvalidVisualizationBlock();
    return this.repository.read(memberId, noteId, blockId);
  }
  async promoteViewEdge(memberId: string, noteId: string, blockId: string, edgeId: string, idempotencyKey: unknown) {
    if (!uuid.test(noteId) || !uuid.test(blockId) || typeof edgeId !== "string" || !edgeId.trim() || edgeId.length > 120
      || typeof idempotencyKey !== "string" || !uuid.test(idempotencyKey)) throw new InvalidVisualizationBlock();
    return this.repository.promoteViewEdge(memberId, noteId, blockId, edgeId.trim(), idempotencyKey);
  }
}
