import type {
  RelationshipNeighborhood,
  RelationshipQuery,
} from "@stash/domain-types";

export interface RelationshipMaintenance {
  readonly orphans: ReadonlyArray<{ id: string; title: string }>;
  readonly brokenLinks: ReadonlyArray<{
    id: string; sourceNoteId: string; sourceTitle: string; label: string; targetPath?: string; revision: number;
    candidates: ReadonlyArray<{ id: string; title: string }>;
  }>;
}
export interface RelationshipMaintenancePage extends RelationshipMaintenance { readonly nextCursor?: string }
export interface RelationshipMaintenanceQuery { readonly limit: number; readonly offset: number }

export interface RelationshipQueryRepository {
  query(memberId: string, query: RelationshipQuery): Promise<
    { status: "found"; neighborhood: RelationshipNeighborhood } | { status: "not_found" }
  >;
  maintenance(memberId: string, workspaceId: string, query: RelationshipMaintenanceQuery): Promise<
    { status: "found"; orphans: RelationshipMaintenance["orphans"]; brokenLinks: RelationshipMaintenance["brokenLinks"]; nextCursor?: string }
    | { status: "workspace_forbidden" }
  >;
}

export class InvalidRelationshipQuery extends Error {}
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);

export class RelationshipQueryService {
  constructor(private readonly repository: RelationshipQueryRepository) {}

  async query(memberId: string, rootId: string, value: unknown) {
    if (!uuid.test(rootId) || value !== undefined && !object(value)) throw new InvalidRelationshipQuery();
    const input = value as Record<string, unknown> | undefined;
    if (input && !Object.keys(input).every((key) => ["depth", "limit", "direction", "relationTypes", "includeHierarchy"].includes(key)))
      throw new InvalidRelationshipQuery();
    const depth = input?.depth ?? 1; const limit = input?.limit ?? 24; const direction = input?.direction ?? "both";
    if (!Number.isInteger(depth) || Number(depth) < 1 || Number(depth) > 3 || !Number.isInteger(limit) || Number(limit) < 1
      || Number(limit) > 100 || !["incoming", "outgoing", "both"].includes(String(direction))
      || input?.includeHierarchy !== undefined && typeof input.includeHierarchy !== "boolean") throw new InvalidRelationshipQuery();
    let relationTypes: string[] | undefined;
    if (input?.relationTypes !== undefined) {
      if (!Array.isArray(input.relationTypes) || input.relationTypes.length > 20 || input.relationTypes.some((item) =>
        typeof item !== "string" || !item.trim() || item.trim().length > 80 || /[\r\n]/.test(item))) throw new InvalidRelationshipQuery();
      relationTypes = [...new Set(input.relationTypes.map((item) => String(item).trim()))];
    }
    const query: RelationshipQuery = { rootId, depth: Number(depth), limit: Number(limit), direction: direction as RelationshipQuery["direction"],
      ...(relationTypes ? { relationTypes } : {}), includeHierarchy: input?.includeHierarchy !== false };
    return this.repository.query(memberId, query);
  }

  async maintenance(memberId: string, workspaceId: string, value?: unknown) {
    if (!uuid.test(workspaceId) || value !== undefined && !object(value)) throw new InvalidRelationshipQuery();
    const input = value as Record<string, unknown> | undefined;
    if (input && !Object.keys(input).every((key) => ["limit", "cursor"].includes(key))) throw new InvalidRelationshipQuery();
    const limit = input?.limit ?? 24; const cursor = input?.cursor ?? "0";
    if (!Number.isInteger(limit) || Number(limit) < 1 || Number(limit) > 50 || typeof cursor !== "string" || !/^\d{1,5}$/.test(cursor))
      throw new InvalidRelationshipQuery();
    return this.repository.maintenance(memberId, workspaceId, { limit: Number(limit), offset: Number(cursor) });
  }
}
