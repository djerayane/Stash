import type { Collection, CollectionPropertyType, CollectionPropertyValue, CollectionRecord, ViewDefinition, ViewPresentation } from "@stash/domain-types";

export interface EvaluatedCollectionView {
  readonly records: readonly CollectionRecord[];
  readonly groups: readonly { readonly key: string; readonly label: string; readonly recordIds: readonly string[] }[];
}

function comparable(value: CollectionPropertyValue | undefined): string | number | boolean {
  if (value === undefined || value === null) return "";
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return value;
  if ("start" in value) return value.start;
  return (value as readonly (string | { fallback: string })[]).map((entry) => typeof entry === "string" ? entry : entry.fallback).join("\u0000");
}

function matches(value: CollectionPropertyValue | undefined, operator: ViewDefinition["filters"][number]["operator"], expected?: CollectionPropertyValue) {
  const empty = value === undefined || value === null || value === "" || Array.isArray(value) && value.length === 0;
  if (operator === "is_empty") return empty;
  if (operator === "is_not_empty") return !empty;
  const left = comparable(value); const right = comparable(expected);
  if (operator === "equals") return left === right;
  if (operator === "not_equals") return left !== right;
  return String(left).toLocaleLowerCase().includes(String(right).toLocaleLowerCase());
}

function groupKey(value: CollectionPropertyValue | undefined): string[] {
  if (value !== undefined && value !== null && typeof value === "object" && !("start" in value)) {
    const entries = value as readonly (string | { fallback: string })[];
    return entries.length ? entries.map((entry) => typeof entry === "string" ? entry : entry.fallback) : ["ungrouped"];
  }
  const key = comparable(value); return key === "" ? ["ungrouped"] : [String(key)];
}

export function evaluateCollectionView(collection: Collection, definition: ViewDefinition): EvaluatedCollectionView {
  if (definition.source.kind !== "collection" || definition.source.collectionId !== collection.id) throw new Error("view_source_mismatch");
  const indexed = collection.records.map((record, index) => ({ record, index }))
    .filter(({ record }) => definition.filters.every((filter) => matches(record.values[filter.propertyId], filter.operator, filter.value)));
  indexed.sort((left, right) => {
    for (const sort of definition.sorts) {
      const a = comparable(left.record.values[sort.propertyId]); const b = comparable(right.record.values[sort.propertyId]);
      const compared = typeof a === "number" && typeof b === "number" ? a - b : String(a).localeCompare(String(b));
      if (compared) return sort.direction === "ascending" ? compared : -compared;
    }
    return left.record.position - right.record.position || left.index - right.index;
  });
  const records = indexed.map(({ record }) => record); const grouped = new Map<string, string[]>();
  if (definition.groupBy) for (const record of records) for (const key of groupKey(record.values[definition.groupBy]))
    grouped.set(key, [...(grouped.get(key) ?? []), record.id]);
  return { records, groups: [...grouped].map(([key, recordIds]) => ({ key, label: key === "ungrouped" ? "No value" : key, recordIds })) };
}

export function updateBoardGroup(collection: Collection, definition: ViewDefinition, recordId: string, groupValue: CollectionPropertyValue) {
  if (!definition.groupBy) throw new Error("board_group_unavailable");
  const property = collection.properties.find(({ id }) => id === definition.groupBy);
  if (!collection.records.some(({ id }) => id === recordId) || !property)
    throw new Error("board_group_unavailable");
  const value = property.type === "multi_select" ? [String(groupValue)]
    : property.type === "checkbox" ? groupValue === true || groupValue === "true" : groupValue;
  return { recordId, values: { [definition.groupBy]: value } };
}

export function presentationRequirement(collection: Collection, presentation: ViewPresentation):
  { propertyType: CollectionPropertyType; actionLabel: string } | undefined {
  if (presentation === "calendar" && !collection.properties.some(({ type }) => type === "date_time"))
    return { propertyType: "date_time", actionLabel: "Add date property" };
  if (presentation === "board" && !collection.properties.some(({ type }) => type === "single_select" || type === "multi_select" || type === "checkbox"))
    return { propertyType: "single_select", actionLabel: "Add select property" };
  return undefined;
}
