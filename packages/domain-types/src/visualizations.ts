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

export type VisualizationQuery =
  | { readonly kind: "relationship"; readonly input: RelationshipQuery }
  | { readonly kind: "search"; readonly input: { readonly text: string; readonly terms: readonly string[]; readonly limit: number } }
  | { readonly kind: "facet"; readonly input: { readonly field: string; readonly terms: readonly string[]; readonly limit: number } }
  | { readonly kind: "aggregate"; readonly input: { readonly field: string; readonly operation: "count" | "sum";
      readonly terms: readonly string[]; readonly limit: number } };
export type VisualizationResult =
  | { readonly kind: "relationship"; readonly result: RelationshipNeighborhood }
  | { readonly kind: "search"; readonly result: { readonly noteIds: readonly string[]; readonly hasMore: boolean } }
  | { readonly kind: "facet"; readonly result: { readonly buckets: readonly { value: string; count: number }[] } }
  | { readonly kind: "aggregate"; readonly result: { readonly buckets: readonly { term: string; value: number }[] } };

export interface ViewEdge { readonly id: string; readonly sourceNoteId: string; readonly targetNoteId: string; readonly relationshipType?: string }
export interface VisualizationPoint { readonly x: number; readonly y: number }
export interface RelationshipVisualizationFilters { readonly relationTypes: readonly string[]; readonly direction: RelationshipDirection }
export interface TermVisualizationFilters { readonly terms: readonly string[] }
type Common = { readonly schema: "stash.visualization.v1"; readonly id: string; readonly viewEdges: readonly ViewEdge[] };
type RelationshipLens = Extract<VisualizationQuery, { kind: "relationship" }>;
type SearchLens = Extract<VisualizationQuery, { kind: "search" }>;
type WordLens = Extract<VisualizationQuery, { kind: "facet" | "aggregate" }>;
export type VisualizationDefinition =
  | Common & { readonly kind: "local-graph"; readonly query: RelationshipLens; readonly filters: RelationshipVisualizationFilters;
      readonly layout: { readonly kind: "focused"; readonly positions: Readonly<Record<string, VisualizationPoint>> } }
  | Common & { readonly kind: "global-graph"; readonly query: RelationshipLens; readonly filters: RelationshipVisualizationFilters;
      readonly layout: { readonly kind: "force"; readonly positions: Readonly<Record<string, VisualizationPoint>> } }
  | Common & { readonly kind: "brain-map"; readonly query: RelationshipLens; readonly filters: RelationshipVisualizationFilters;
      readonly layout: { readonly kind: "radial"; readonly positions: Readonly<Record<string, VisualizationPoint>> } }
  | Common & { readonly kind: "word-cloud"; readonly query: WordLens; readonly filters: TermVisualizationFilters;
      readonly layout: { readonly kind: "word-cloud"; readonly minFontSize: number; readonly maxFontSize: number }; readonly viewEdges: readonly [] }
  | Common & { readonly kind: "canvas"; readonly query: RelationshipLens; readonly filters: RelationshipVisualizationFilters;
      readonly layout: { readonly kind: "spatial"; readonly positions: Readonly<Record<string, VisualizationPoint>> } }
  | Common & { readonly kind: "canvas"; readonly query: SearchLens; readonly filters: TermVisualizationFilters;
      readonly layout: { readonly kind: "spatial"; readonly positions: Readonly<Record<string, VisualizationPoint>> } };

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const directions = new Set(["outgoing", "incoming", "both"]);
const graphLayouts = new Map([["local-graph", "focused"], ["global-graph", "force"], ["brain-map", "radial"]] as const);
const kinds = new Set(["local-graph", "global-graph", "brain-map", "word-cloud", "canvas"]);
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
const owns = (value: Record<string, unknown>, key: string): boolean => Object.prototype.hasOwnProperty.call(value, key);
const exact = (value: Record<string, unknown>, keys: readonly string[]) => {
  if (Object.keys(value).some((key) => !keys.includes(key))) throw new TypeError("Unknown visualization property");
};
function stringList(value: unknown, maximum: number): string[] {
  if (!Array.isArray(value) || value.length > maximum || value.some((item) => typeof item !== "string" || !item.trim()
    || item.length > 80 || /[\r\n]/.test(item))) throw new TypeError("Invalid visualization string list");
  return [...new Set(value.map((item) => String(item).trim()))];
}
function normalizePositions(value: unknown): Record<string, VisualizationPoint> {
  if (value === undefined) return {};
  if (!object(value) || Object.keys(value).length > 100) throw new TypeError("Invalid visualization positions");
  return Object.fromEntries(Object.entries(value).map(([id, point]) => {
    if (!uuid.test(id) || !object(point)) throw new TypeError("Invalid visualization position");
    exact(point, ["x", "y"]);
    if (typeof point.x !== "number" || typeof point.y !== "number"
      || !Number.isFinite(point.x) || !Number.isFinite(point.y)
      || Math.abs(point.x) > 100_000 || Math.abs(point.y) > 100_000)
      throw new TypeError("Invalid visualization position");
    return [id, { x: point.x, y: point.y }];
  }));
}
function normalizeQuery(value: Record<string, unknown>): VisualizationQuery {
  exact(value, ["kind", "input"]); if (!owns(value, "kind") || typeof value.kind !== "string" || !object(value.input))
    throw new TypeError("Invalid visualization query");
  const input = value.input;
  if (value.kind === "relationship") {
    exact(input, ["rootId", "depth", "limit", "direction", "relationTypes", "includeHierarchy"]);
    if (typeof input.rootId !== "string" || !uuid.test(input.rootId) || !Number.isInteger(input.depth) || Number(input.depth) < 1
      || Number(input.depth) > 3 || !Number.isInteger(input.limit) || Number(input.limit) < 1 || Number(input.limit) > 100
      || typeof input.direction !== "string" || !directions.has(input.direction) || typeof input.includeHierarchy !== "boolean")
      throw new TypeError("Invalid relationship visualization query");
    const relationTypes = input.relationTypes === undefined ? undefined : stringList(input.relationTypes, 20);
    return { kind: "relationship", input: { rootId: input.rootId, depth: Number(input.depth), limit: Number(input.limit),
      direction: input.direction as RelationshipDirection, ...(relationTypes ? { relationTypes } : {}), includeHierarchy: input.includeHierarchy } };
  }
  if (value.kind === "search") {
    exact(input, ["text", "terms", "limit"]);
    if (typeof input.text !== "string" || input.text.length > 200 || /[\r\n]/.test(input.text)
      || !Number.isInteger(input.limit) || Number(input.limit) < 1 || Number(input.limit) > 100) throw new TypeError("Invalid search visualization query");
    return { kind: "search", input: { text: input.text, terms: stringList(input.terms, 50), limit: Number(input.limit) } };
  }
  if (value.kind === "facet" || value.kind === "aggregate") {
    exact(input, value.kind === "facet" ? ["field", "terms", "limit"] : ["field", "operation", "terms", "limit"]);
    if (typeof input.field !== "string" || !input.field.trim() || input.field.length > 80 || /[\r\n]/.test(input.field)
      || !Number.isInteger(input.limit) || Number(input.limit) < 1 || Number(input.limit) > 100
      || value.kind === "aggregate" && !["count", "sum"].includes(String(input.operation))) throw new TypeError("Invalid term visualization query");
    const common = { field: input.field.trim(), terms: stringList(input.terms, 50), limit: Number(input.limit) };
    return value.kind === "facet" ? { kind: "facet", input: common }
      : { kind: "aggregate", input: { ...common, operation: input.operation as "count" | "sum" } };
  }
  throw new TypeError("Unsupported visualization query");
}
function normalizeEdges(value: unknown): ViewEdge[] {
  if (!Array.isArray(value) || value.length > 100) throw new TypeError("Invalid visualization view edges");
  const edges = value.map((edge) => {
    if (!object(edge)) throw new TypeError("Invalid visualization view edge");
    exact(edge, ["id", "sourceNoteId", "targetNoteId", "relationshipType"]);
    if (typeof edge.id !== "string" || !edge.id.trim() || edge.id.length > 120 || typeof edge.sourceNoteId !== "string"
      || !uuid.test(edge.sourceNoteId) || typeof edge.targetNoteId !== "string" || !uuid.test(edge.targetNoteId)
      || edge.sourceNoteId === edge.targetNoteId || edge.relationshipType !== undefined && (typeof edge.relationshipType !== "string"
        || !edge.relationshipType.trim() || edge.relationshipType.length > 80 || /[\r\n]/.test(edge.relationshipType)))
      throw new TypeError("Invalid visualization view edge");
    return { id: edge.id.trim(), sourceNoteId: edge.sourceNoteId, targetNoteId: edge.targetNoteId,
      ...(edge.relationshipType ? { relationshipType: edge.relationshipType.trim() } : {}) };
  });
  if (new Set(edges.map(({ id }) => id)).size !== edges.length) throw new TypeError("Duplicate visualization view edge");
  return edges;
}

/** Validates portable state and exact kind/query/layout combinations at every persistence/import boundary. */
export function normalizeVisualizationDefinition(value: unknown): VisualizationDefinition {
  if (!object(value)) throw new TypeError("Invalid Visualization Block");
  exact(value, ["schema", "id", "kind", "query", "filters", "layout", "viewEdges"]);
  if (!["schema", "id", "kind", "query", "filters", "viewEdges"].every((key) => owns(value, key))
    || value.schema !== "stash.visualization.v1" || typeof value.id !== "string" || !uuid.test(value.id)
    || typeof value.kind !== "string" || !kinds.has(value.kind) || !object(value.query) || !object(value.filters)
    || !owns(value, "layout") && value.layout !== undefined || value.layout !== undefined && !object(value.layout))
    throw new TypeError("Invalid Visualization Block");
  const query = normalizeQuery(value.query); const viewEdges = normalizeEdges(value.viewEdges);
  const relationship = query.kind === "relationship";
  exact(value.filters, relationship ? ["relationTypes", "direction"] : ["terms"]);
  const filters = relationship
    ? (() => { if (typeof value.filters.direction !== "string" || !directions.has(value.filters.direction)) throw new TypeError("Invalid relationship filters");
      return { relationTypes: stringList(value.filters.relationTypes, 20), direction: value.filters.direction as RelationshipDirection }; })()
    : { terms: stringList(value.filters.terms, 50) };
  if (graphLayouts.has(value.kind as "local-graph")) {
    if (!relationship) throw new TypeError("Graph visualizations require a relationship query");
    const expected = graphLayouts.get(value.kind as "local-graph")!; const layout = value.layout ?? { kind: expected };
    if (!object(layout) || !owns(layout, "kind")) throw new TypeError("Invalid graph layout"); exact(layout, ["kind", "positions"]);
    if (layout.kind !== expected) throw new TypeError("Invalid graph layout for kind");
    return { schema: "stash.visualization.v1", id: value.id, kind: value.kind, query, filters,
      layout: { kind: expected, positions: normalizePositions(layout.positions) }, viewEdges } as VisualizationDefinition;
  }
  if (value.kind === "word-cloud") {
    if (!["facet", "aggregate"].includes(query.kind) || viewEdges.length) throw new TypeError("Invalid word-cloud definition");
    const layout = value.layout ?? { kind: "word-cloud", minFontSize: 12, maxFontSize: 48 };
    if (!object(layout) || !owns(layout, "kind")) throw new TypeError("Invalid word-cloud layout"); exact(layout, ["kind", "minFontSize", "maxFontSize"]);
    if (layout.kind !== "word-cloud" || typeof layout.minFontSize !== "number" || typeof layout.maxFontSize !== "number"
      || !Number.isFinite(layout.minFontSize) || !Number.isFinite(layout.maxFontSize)
      || layout.minFontSize < 8 || layout.maxFontSize > 200 || layout.maxFontSize < layout.minFontSize)
      throw new TypeError("Invalid word-cloud layout");
    return { schema: "stash.visualization.v1", id: value.id, kind: "word-cloud", query: query as WordLens,
      filters: filters as TermVisualizationFilters,
      layout: { kind: "word-cloud", minFontSize: layout.minFontSize, maxFontSize: layout.maxFontSize }, viewEdges: [] };
  }
  if (value.kind === "canvas") {
    if (!["relationship", "search"].includes(query.kind)) throw new TypeError("Invalid canvas query");
    const layout = value.layout ?? { kind: "spatial" }; if (!object(layout) || !owns(layout, "kind")) throw new TypeError("Invalid spatial layout");
    exact(layout, ["kind", "positions"]); if (layout.kind !== "spatial") throw new TypeError("Invalid canvas layout");
    return { schema: "stash.visualization.v1", id: value.id, kind: "canvas", query: query as RelationshipLens | SearchLens,
      filters, layout: { kind: "spatial", positions: normalizePositions(layout.positions) }, viewEdges } as VisualizationDefinition;
  }
  throw new TypeError("Unsupported visualization kind");
}
