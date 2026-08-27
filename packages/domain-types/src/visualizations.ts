export type RelationshipDirection = "outgoing" | "incoming" | "both";

export interface RelationshipQuery {
  readonly rootId: string;
  readonly depth: number;
  readonly limit: number;
  readonly direction: RelationshipDirection;
  readonly relationTypes?: readonly string[];
  readonly includeHierarchy: boolean;
}

export interface RelationshipNode {
  readonly id: string;
  readonly title: string;
  readonly depth: number;
}

export interface RelationshipEdge {
  readonly id: string;
  readonly sourceNoteId: string;
  readonly targetNoteId: string;
  readonly kind: "note-link" | "hierarchy";
  readonly relationshipType?: string;
}

export interface RelationshipNeighborhood {
  readonly rootId: string;
  readonly depth: number;
  readonly limit: number;
  readonly direction: RelationshipDirection;
  readonly nodes: readonly RelationshipNode[];
  readonly edges: readonly RelationshipEdge[];
  readonly outline: readonly RelationshipNode[];
  readonly hasMore: boolean;
}

export interface ViewEdge {
  readonly id: string;
  readonly sourceNoteId: string;
  readonly targetNoteId: string;
  readonly relationshipType?: string;
}

export interface VisualizationDefinition {
  readonly schema: "stash.visualization.v1";
  readonly id: string;
  readonly kind: "local-graph" | "global-graph" | "brain-map" | "word-cloud" | "canvas";
  readonly query: RelationshipQuery;
  readonly filters: { readonly relationTypes: readonly string[]; readonly direction: RelationshipDirection };
  readonly layout: Readonly<Record<string, unknown>>;
  readonly viewEdges: readonly ViewEdge[];
}

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const kinds = new Set(["local-graph", "global-graph", "brain-map", "word-cloud", "canvas"]);
const directions = new Set(["outgoing", "incoming", "both"]);
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);

function stringList(value: unknown, maximum: number): string[] {
  if (!Array.isArray(value) || value.length > maximum || value.some((item) => typeof item !== "string" || !item.trim() || item.length > 80 || /[\r\n]/.test(item)))
    throw new TypeError("Invalid visualization string list");
  return [...new Set(value.map((item) => String(item).trim()))];
}

function portableJson(value: unknown, depth = 0): boolean {
  if (value === null || typeof value === "boolean" || typeof value === "string") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (depth >= 8) return false;
  if (Array.isArray(value)) return value.length <= 500 && value.every((item) => portableJson(item, depth + 1));
  if (!object(value) || Object.keys(value).length > 500) return false;
  return Object.values(value).every((item) => portableJson(item, depth + 1));
}

/** Validates portable state at every persistence/import boundary. */
export function normalizeVisualizationDefinition(value: unknown): VisualizationDefinition {
  if (!object(value) || value.schema !== "stash.visualization.v1" || typeof value.id !== "string" || !uuid.test(value.id)
    || typeof value.kind !== "string" || !kinds.has(value.kind) || !object(value.query) || !object(value.filters)
    || !object(value.layout) || !portableJson(value.layout) || !Array.isArray(value.viewEdges)) throw new TypeError("Invalid Visualization Block");
  const query = value.query;
  if (typeof query.rootId !== "string" || !uuid.test(query.rootId) || !Number.isInteger(query.depth) || Number(query.depth) < 1
    || Number(query.depth) > 3 || !Number.isInteger(query.limit) || Number(query.limit) < 1 || Number(query.limit) > 100
    || typeof query.direction !== "string" || !directions.has(query.direction) || typeof query.includeHierarchy !== "boolean")
    throw new TypeError("Invalid Visualization Block query");
  const relationTypes = query.relationTypes === undefined ? undefined : stringList(query.relationTypes, 20);
  const filterTypes = stringList(value.filters.relationTypes, 20);
  if (typeof value.filters.direction !== "string" || !directions.has(value.filters.direction)) throw new TypeError("Invalid visualization filters");
  const viewEdges = value.viewEdges.map((edge) => {
    if (!object(edge) || typeof edge.id !== "string" || !edge.id.trim() || edge.id.length > 120
      || typeof edge.sourceNoteId !== "string" || !uuid.test(edge.sourceNoteId)
      || typeof edge.targetNoteId !== "string" || !uuid.test(edge.targetNoteId)
      || edge.sourceNoteId === edge.targetNoteId || edge.relationshipType !== undefined
      && (typeof edge.relationshipType !== "string" || !edge.relationshipType.trim() || edge.relationshipType.length > 80 || /[\r\n]/.test(edge.relationshipType)))
      throw new TypeError("Invalid visualization view edge");
    return { id: edge.id.trim(), sourceNoteId: edge.sourceNoteId, targetNoteId: edge.targetNoteId,
      ...(edge.relationshipType ? { relationshipType: edge.relationshipType.trim() } : {}) };
  });
  if (new Set(viewEdges.map(({ id }) => id)).size !== viewEdges.length) throw new TypeError("Duplicate visualization view edge");
  return { schema: "stash.visualization.v1", id: value.id, kind: value.kind as VisualizationDefinition["kind"],
    query: { rootId: query.rootId, depth: Number(query.depth), limit: Number(query.limit),
      direction: query.direction as RelationshipDirection, ...(relationTypes ? { relationTypes } : {}), includeHierarchy: query.includeHierarchy },
    filters: { relationTypes: filterTypes, direction: value.filters.direction as RelationshipDirection }, layout: value.layout,
    viewEdges };
}
