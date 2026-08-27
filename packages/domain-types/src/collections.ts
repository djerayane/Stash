export const collectionPropertyTypes = ["text", "number", "checkbox", "date_time", "single_select", "multi_select",
  "person", "url", "attachment", "relation"] as const;
export type CollectionPropertyType = (typeof collectionPropertyTypes)[number];

export interface CollectionPropertyBase { readonly id: string; readonly name: string; readonly position: number }
export interface CollectionSelectOption { readonly id: string; readonly name: string }
export type CollectionRelationTarget =
  | { readonly kind: "collection_records"; readonly collectionId: string }
  | { readonly kind: "notes" | "tasks" | "projects" };
export type CollectionProperty =
  | (CollectionPropertyBase & { readonly type: "text" | "number" | "checkbox" | "date_time" | "person" | "url" | "attachment" })
  | (CollectionPropertyBase & { readonly type: "single_select" | "multi_select"; readonly options: readonly CollectionSelectOption[] })
  | (CollectionPropertyBase & { readonly type: "relation"; readonly target: CollectionRelationTarget });

export interface CollectionDateTimeValue { readonly start: string; readonly end?: string; readonly includeTime: boolean }
export interface CollectionRelationValue { readonly id: string; readonly fallback: string }
export type CollectionPropertyValue = string | number | boolean | null | readonly string[] | CollectionDateTimeValue
  | readonly CollectionRelationValue[];
export interface CollectionRecord { readonly id: string; readonly position: number; readonly values: Readonly<Record<string, CollectionPropertyValue>> }
export interface Collection {
  readonly schema: "stash.collection.v1"; readonly id: string; readonly workspaceId: string; readonly ownerNoteId: string;
  readonly title: string; readonly properties: readonly CollectionProperty[]; readonly records: readonly CollectionRecord[];
}

export type ViewPresentation = "table" | "board" | "list" | "calendar";
export interface ViewFilter { readonly propertyId: string; readonly operator: "equals" | "not_equals" | "contains" | "is_empty" | "is_not_empty"; readonly value?: CollectionPropertyValue }
export interface ViewSort { readonly propertyId: string; readonly direction: "ascending" | "descending" }
export type ViewSource = { readonly kind: "collection"; readonly collectionId: string }
  | { readonly kind: "tasks"; readonly workspaceId: string };
export interface ViewDefinition {
  readonly source: ViewSource; readonly presentation: ViewPresentation; readonly filters: readonly ViewFilter[];
  readonly sorts: readonly ViewSort[]; readonly groupBy?: string; readonly layout: Readonly<Record<string, unknown>>;
  readonly focused?: { readonly recordId: string };
}
export interface ViewBlock {
  readonly schema: "stash.view-block.v1"; readonly id: string; readonly workspaceId: string; readonly ownerNoteId: string;
  readonly blockId: string; readonly title: string; readonly definition: ViewDefinition;
}
export interface CollectionImpact {
  readonly noteId: string;
  readonly collections: readonly { readonly id: string; readonly title: string; readonly recordCount: number }[];
  readonly relations: readonly { readonly collectionId: string; readonly recordId: string; readonly propertyId: string; readonly referenceCount: number }[];
  readonly viewBlocks: readonly { readonly id: string; readonly title: string; readonly ownerNoteId: string }[];
  readonly token: string;
}

export const taskViewPropertyIds = ["task:title", "task:description", "task:status", "task:assignee", "task:project"] as const;
export type TaskViewPropertyId = (typeof taskViewPropertyIds)[number];
export function isTaskViewPropertyId(value: string): value is TaskViewPropertyId {
  return (taskViewPropertyIds as readonly string[]).includes(value);
}

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const plain = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === "object" && !Array.isArray(value)
  && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
const exact = (value: Record<string, unknown>, required: readonly string[], optional: readonly string[] = []) => {
  const allowed = new Set([...required, ...optional]); return required.every((key) => Object.hasOwn(value, key))
    && Object.keys(value).every((key) => allowed.has(key));
};
const label = (value: unknown, maximum = 120) => typeof value === "string" && Boolean(value.trim())
  && value.trim().length <= maximum && !/[\r\n]/.test(value);
function invalid(): never { throw new Error("invalid_collection_property"); }
function invalidCollection(): never { throw new Error("invalid_collection"); }
function invalidView(): never { throw new Error("invalid_view_definition"); }

export function normalizeCollectionProperty(value: unknown): CollectionProperty {
  if (!plain(value) || !exact(value, ["id", "name", "type", "position"], ["options", "target"])
    || !uuid.test(String(value.id)) || !label(value.name) || !Number.isInteger(value.position) || Number(value.position) < 1
    || !collectionPropertyTypes.includes(value.type as CollectionPropertyType)) invalid();
  const base = { id: String(value.id), name: String(value.name).trim(), position: Number(value.position) };
  if (value.type === "single_select" || value.type === "multi_select") {
    if (!Array.isArray(value.options) || value.options.length > 100) invalid();
    const ids = new Set<string>();
    const options = value.options.map((option) => {
      if (!plain(option) || !exact(option, ["id", "name"]) || !label(option.id, 80) || !label(option.name, 80)
        || ids.has(String(option.id))) invalid();
      ids.add(String(option.id)); return { id: String(option.id), name: String(option.name).trim() };
    });
    return { ...base, type: value.type, options };
  }
  if (value.type === "relation") {
    if (!plain(value.target) || !exact(value.target, ["kind"], ["collectionId"])
      || !["collection_records", "notes", "tasks", "projects"].includes(String(value.target.kind))) invalid();
    if (value.target.kind === "collection_records") {
      if (!uuid.test(String(value.target.collectionId)) || !exact(value.target, ["kind", "collectionId"])) invalid();
      return { ...base, type: "relation", target: { kind: "collection_records", collectionId: String(value.target.collectionId) } };
    }
    if (Object.hasOwn(value.target, "collectionId")) invalid();
    return { ...base, type: "relation", target: { kind: value.target.kind as "notes" | "tasks" | "projects" } };
  }
  if (Object.hasOwn(value, "options") || Object.hasOwn(value, "target")) invalid();
  return { ...base, type: value.type as Exclude<CollectionPropertyType, "single_select" | "multi_select" | "relation"> };
}

function portableJson(value: unknown, depth = 0): unknown {
  if (depth > 8) invalidView();
  if (value === null || typeof value === "string" || typeof value === "boolean"
    || typeof value === "number" && Number.isFinite(value)) return value;
  if (Array.isArray(value)) return value.map((entry) => portableJson(entry, depth + 1));
  if (plain(value)) return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, portableJson(entry, depth + 1)]));
  invalidView();
}

function normalizePropertyValue(property: CollectionProperty, value: unknown): CollectionPropertyValue {
  if (value === null && ["text", "number", "date_time", "single_select", "url"].includes(property.type)) return null;
  if (property.type === "text") { if (typeof value !== "string" || value.length > 20_000) invalidCollection(); return value; }
  if (property.type === "number") { if (typeof value !== "number" || !Number.isFinite(value)) invalidCollection(); return value; }
  if (property.type === "checkbox") { if (typeof value !== "boolean") invalidCollection(); return value; }
  if (property.type === "date_time") {
    if (!plain(value) || !exact(value, ["start", "includeTime"], ["end"]) || typeof value.start !== "string"
      || !Number.isFinite(Date.parse(value.start)) || typeof value.includeTime !== "boolean"
      || value.end !== undefined && (typeof value.end !== "string" || !Number.isFinite(Date.parse(value.end)))) invalidCollection();
    return { start: value.start, ...(typeof value.end === "string" ? { end: value.end } : {}), includeTime: value.includeTime };
  }
  if (property.type === "single_select") {
    if (typeof value !== "string" || !property.options.some(({ id }) => id === value)) invalidCollection(); return value;
  }
  if (property.type === "multi_select") {
    if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string") || new Set(value).size !== value.length
      || value.some((entry) => !property.options.some(({ id }) => id === entry))) invalidCollection(); return [...value];
  }
  if (property.type === "person" || property.type === "attachment") {
    if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string" || !uuid.test(entry)) || new Set(value).size !== value.length)
      invalidCollection();
    return [...value];
  }
  if (property.type === "url") {
    if (typeof value !== "string" || value.length > 2_000) invalidCollection();
    try { const parsed = new URL(value); if (!['http:', 'https:'].includes(parsed.protocol)) invalidCollection(); } catch { invalidCollection(); }
    return value;
  }
  if (!Array.isArray(value) || value.length > 500) invalidCollection();
  const seen = new Set<string>();
  return value.map((entry) => {
    if (!plain(entry) || !exact(entry, ["id", "fallback"]) || !uuid.test(String(entry.id)) || !label(entry.fallback, 240)
      || seen.has(String(entry.id))) invalidCollection();
    seen.add(String(entry.id)); return { id: String(entry.id), fallback: String(entry.fallback).trim() };
  });
}

export function normalizeCollection(value: unknown): Collection {
  if (!plain(value) || !exact(value, ["schema", "id", "workspaceId", "ownerNoteId", "title", "properties", "records"])
    || value.schema !== "stash.collection.v1" || !uuid.test(String(value.id)) || !uuid.test(String(value.workspaceId))
    || !uuid.test(String(value.ownerNoteId)) || !label(value.title) || !Array.isArray(value.properties) || value.properties.length > 100
    || !Array.isArray(value.records) || value.records.length > 10_000) invalidCollection();
  let properties: CollectionProperty[];
  try { properties = value.properties.map(normalizeCollectionProperty); } catch { invalidCollection(); }
  if (new Set(properties.map(({ id }) => id)).size !== properties.length || new Set(properties.map(({ position }) => position)).size !== properties.length)
    invalidCollection();
  const byId = new Map(properties.map((property) => [property.id, property])); const recordIds = new Set<string>(); const positions = new Set<number>();
  const records = value.records.map((record): CollectionRecord => {
    if (!plain(record) || !exact(record, ["id", "position", "values"]) || !uuid.test(String(record.id)) || recordIds.has(String(record.id))
      || !Number.isInteger(record.position) || Number(record.position) < 1 || positions.has(Number(record.position)) || !plain(record.values)) invalidCollection();
    recordIds.add(String(record.id)); positions.add(Number(record.position));
    const values: Record<string, CollectionPropertyValue> = {};
    for (const [propertyId, entry] of Object.entries(record.values)) {
      const property = byId.get(propertyId); if (!property) invalidCollection(); values[propertyId] = normalizePropertyValue(property, entry);
    }
    return { id: String(record.id), position: Number(record.position), values };
  });
  return { schema: "stash.collection.v1", id: String(value.id), workspaceId: String(value.workspaceId), ownerNoteId: String(value.ownerNoteId),
    title: String(value.title).trim(), properties, records };
}

export function normalizeViewDefinition(value: unknown): ViewDefinition {
  if (!plain(value) || !exact(value, ["source", "presentation", "filters", "sorts", "layout"], ["groupBy", "focused"])
    || !plain(value.source) || !["table", "board", "list", "calendar"].includes(String(value.presentation))
    || !Array.isArray(value.filters) || value.filters.length > 50 || !Array.isArray(value.sorts) || value.sorts.length > 20
    || !plain(value.layout)) invalidView();
  let source: ViewSource;
  if (value.source.kind === "collection" && exact(value.source, ["kind", "collectionId"]) && uuid.test(String(value.source.collectionId)))
    source = { kind: "collection", collectionId: String(value.source.collectionId) };
  else if (value.source.kind === "tasks" && exact(value.source, ["kind", "workspaceId"]) && uuid.test(String(value.source.workspaceId)))
    source = { kind: "tasks", workspaceId: String(value.source.workspaceId) };
  else invalidView();
  const filters = value.filters.map((filter): ViewFilter => {
    if (!plain(filter) || !exact(filter, ["propertyId", "operator"], ["value"])
      || !uuid.test(String(filter.propertyId)) && !isTaskViewPropertyId(String(filter.propertyId))
      || !["equals", "not_equals", "contains", "is_empty", "is_not_empty"].includes(String(filter.operator))
      || ["is_empty", "is_not_empty"].includes(String(filter.operator)) === Object.hasOwn(filter, "value")) invalidView();
    return { propertyId: String(filter.propertyId), operator: filter.operator as ViewFilter["operator"],
      ...(Object.hasOwn(filter, "value") ? { value: portableJson(filter.value) as CollectionPropertyValue } : {}) };
  });
  const sorts = value.sorts.map((sort): ViewSort => {
    if (!plain(sort) || !exact(sort, ["propertyId", "direction"])
      || !uuid.test(String(sort.propertyId)) && !isTaskViewPropertyId(String(sort.propertyId))
      || !["ascending", "descending"].includes(String(sort.direction))) invalidView();
    return { propertyId: String(sort.propertyId), direction: sort.direction as ViewSort["direction"] };
  });
  if (value.groupBy !== undefined && !uuid.test(String(value.groupBy)) && !isTaskViewPropertyId(String(value.groupBy))) invalidView();
  let focused: ViewDefinition["focused"];
  if (value.focused !== undefined) {
    if (!plain(value.focused) || !exact(value.focused, ["recordId"]) || !uuid.test(String(value.focused.recordId))) invalidView();
    focused = { recordId: String(value.focused.recordId) };
  }
  const layout = portableJson(value.layout) as Readonly<Record<string, unknown>>;
  if (JSON.stringify(layout).length > 16_384) invalidView();
  return { source, presentation: value.presentation as ViewPresentation, filters, sorts,
    ...(typeof value.groupBy === "string" ? { groupBy: value.groupBy } : {}), layout, ...(focused ? { focused } : {}) };
}

export function normalizeViewBlock(value: unknown): ViewBlock {
  if (!plain(value) || !exact(value, ["schema", "id", "workspaceId", "ownerNoteId", "blockId", "title", "definition"])
    || value.schema !== "stash.view-block.v1" || !uuid.test(String(value.id)) || !uuid.test(String(value.workspaceId))
    || !uuid.test(String(value.ownerNoteId)) || !uuid.test(String(value.blockId)) || !label(value.title)) invalidView();
  return { schema: "stash.view-block.v1", id: String(value.id), workspaceId: String(value.workspaceId), ownerNoteId: String(value.ownerNoteId),
    blockId: String(value.blockId), title: String(value.title).trim(), definition: normalizeViewDefinition(value.definition) };
}
