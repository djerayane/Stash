export type RelationshipDirection = "outgoing" | "incoming" | "both";

export interface RelationshipQuery {
  readonly rootId: string; readonly depth: number; readonly limit: number;
  readonly direction: RelationshipDirection; readonly relationTypes?: readonly string[];
  readonly includeHierarchy: boolean;
}
export interface RelationshipNode { readonly id: string; readonly title: string; readonly depth: number }
export interface RelationshipEdge { readonly id: string; readonly sourceNoteId: string; readonly targetNoteId: string;
  readonly kind: "note-link" | "hierarchy"; readonly relationshipType?: string }
export interface RelationshipNeighborhood { readonly rootId: string; readonly depth: number; readonly limit: number;
  readonly direction: RelationshipDirection; readonly nodes: readonly RelationshipNode[]; readonly edges: readonly RelationshipEdge[];
  readonly outline: readonly RelationshipNode[]; readonly hasMore: boolean }

/** Stable lens contracts. Only the relationship lens is executable today. */
export type VisualizationQuery =
  | { readonly kind: "relationship"; readonly input: RelationshipQuery }
  | { readonly kind: "search"; readonly input: { readonly text: string; readonly limit: number } }
  | { readonly kind: "facet"; readonly input: { readonly field: string; readonly values: readonly string[]; readonly limit: number } }
  | { readonly kind: "aggregate"; readonly input: { readonly field: string; readonly operation: "count" | "sum"; readonly limit: number } };
export type VisualizationResult =
  | { readonly kind: "relationship"; readonly result: RelationshipNeighborhood }
  | { readonly kind: "search"; readonly result: { readonly noteIds: readonly string[]; readonly hasMore: boolean } }
  | { readonly kind: "facet"; readonly result: { readonly buckets: readonly { value: string; count: number }[] } }
  | { readonly kind: "aggregate"; readonly result: { readonly buckets: readonly { term: string; value: number }[] } };

export interface ViewEdge { readonly id: string; readonly sourceNoteId: string; readonly targetNoteId: string; readonly relationshipType?: string }
export interface VisualizationPoint { readonly x: number; readonly y: number }
type RelationshipVisualization = {
  readonly schema: "stash.visualization.v1"; readonly id: string;
  readonly query: Extract<VisualizationQuery, { kind: "relationship" }>;
  readonly filters: { readonly relationTypes: readonly string[]; readonly direction: RelationshipDirection };
  readonly viewEdges: readonly ViewEdge[];
};
export type VisualizationDefinition =
  | RelationshipVisualization & { readonly kind: "local-graph"; readonly layout: { readonly kind: "focused"; readonly positions: Readonly<Record<string, VisualizationPoint>> } }
  | RelationshipVisualization & { readonly kind: "global-graph"; readonly layout: { readonly kind: "force"; readonly positions: Readonly<Record<string, VisualizationPoint>> } }
  | RelationshipVisualization & { readonly kind: "brain-map"; readonly layout: { readonly kind: "radial"; readonly positions: Readonly<Record<string, VisualizationPoint>> } };

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const directions = new Set(["outgoing", "incoming", "both"]);
const layoutFor = { "local-graph": "focused", "global-graph": "force", "brain-map": "radial" } as const;
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
const exact = (value: Record<string, unknown>, keys: readonly string[]) => {
  if (Object.keys(value).some((key) => !keys.includes(key))) throw new TypeError("Unknown visualization property");
};
function stringList(value: unknown, maximum: number): string[] {
  if (!Array.isArray(value) || value.length > maximum || value.some((item) => typeof item !== "string" || !item.trim() || item.length > 80 || /[\r\n]/.test(item)))
    throw new TypeError("Invalid visualization string list");
  return [...new Set(value.map((item) => String(item).trim()))];
}
function normalizePositions(value: unknown): Record<string, VisualizationPoint> {
  if (value === undefined) return {};
  if (!object(value) || Object.keys(value).length > 100) throw new TypeError("Invalid visualization positions");
  return Object.fromEntries(Object.entries(value).map(([id, point]) => {
    if (!uuid.test(id) || !object(point)) throw new TypeError("Invalid visualization position");
    exact(point, ["x", "y"]); const x = Number(point.x); const y = Number(point.y);
    if (!Number.isFinite(x) || !Number.isFinite(y) || Math.abs(x) > 100_000 || Math.abs(y) > 100_000)
      throw new TypeError("Invalid visualization position");
    return [id, { x, y }];
  }));
}

/** Validates portable state and kind-specific query/layout combinations at every boundary. */
export function normalizeVisualizationDefinition(value: unknown): VisualizationDefinition {
  if (!object(value)) throw new TypeError("Invalid Visualization Block");
  exact(value, ["schema", "id", "kind", "query", "filters", "layout", "viewEdges"]);
  if (value.schema !== "stash.visualization.v1" || typeof value.id !== "string" || !uuid.test(value.id)
    || typeof value.kind !== "string" || !(value.kind in layoutFor) || !object(value.query) || !object(value.filters)
    || value.layout !== undefined && !object(value.layout) || !Array.isArray(value.viewEdges)) throw new TypeError("Invalid Visualization Block");
  exact(value.query, ["kind", "input"]);
  if (value.query.kind !== "relationship" || !object(value.query.input)) throw new TypeError("Unsupported visualization query");
  const query = value.query.input; exact(query, ["rootId", "depth", "limit", "direction", "relationTypes", "includeHierarchy"]);
  if (typeof query.rootId !== "string" || !uuid.test(query.rootId) || !Number.isInteger(query.depth) || Number(query.depth) < 1
    || Number(query.depth) > 3 || !Number.isInteger(query.limit) || Number(query.limit) < 1 || Number(query.limit) > 100
    || typeof query.direction !== "string" || !directions.has(query.direction) || typeof query.includeHierarchy !== "boolean")
    throw new TypeError("Invalid Visualization Block query");
  const relationTypes = query.relationTypes === undefined ? undefined : stringList(query.relationTypes, 20);
  exact(value.filters, ["relationTypes", "direction"]); const filterTypes = stringList(value.filters.relationTypes, 20);
  if (typeof value.filters.direction !== "string" || !directions.has(value.filters.direction)) throw new TypeError("Invalid visualization filters");
  const expectedLayout = layoutFor[value.kind as keyof typeof layoutFor];
  const layout = value.layout ?? { kind: expectedLayout }; if (!object(layout)) throw new TypeError("Invalid visualization layout");
  exact(layout, ["kind", "positions"]);
  if (layout.kind !== expectedLayout) throw new TypeError("Invalid visualization layout for kind");
  const viewEdges = value.viewEdges.map((edge) => {
    if (!object(edge)) throw new TypeError("Invalid visualization view edge");
    exact(edge, ["id", "sourceNoteId", "targetNoteId", "relationshipType"]);
    if (typeof edge.id !== "string" || !edge.id.trim() || edge.id.length > 120
      || typeof edge.sourceNoteId !== "string" || !uuid.test(edge.sourceNoteId)
      || typeof edge.targetNoteId !== "string" || !uuid.test(edge.targetNoteId) || edge.sourceNoteId === edge.targetNoteId
      || edge.relationshipType !== undefined && (typeof edge.relationshipType !== "string" || !edge.relationshipType.trim()
        || edge.relationshipType.length > 80 || /[\r\n]/.test(edge.relationshipType))) throw new TypeError("Invalid visualization view edge");
    return { id: edge.id.trim(), sourceNoteId: edge.sourceNoteId, targetNoteId: edge.targetNoteId,
      ...(edge.relationshipType ? { relationshipType: edge.relationshipType.trim() } : {}) };
  });
  if (new Set(viewEdges.map(({ id }) => id)).size !== viewEdges.length) throw new TypeError("Duplicate visualization view edge");
  return { schema: "stash.visualization.v1", id: value.id, kind: value.kind,
    query: { kind: "relationship", input: { rootId: query.rootId, depth: Number(query.depth), limit: Number(query.limit),
      direction: query.direction as RelationshipDirection, ...(relationTypes ? { relationTypes } : {}), includeHierarchy: query.includeHierarchy } },
    filters: { relationTypes: filterTypes, direction: value.filters.direction as RelationshipDirection },
    layout: { kind: expectedLayout, positions: normalizePositions(layout.positions) }, viewEdges } as VisualizationDefinition;
}
