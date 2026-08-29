import type { Collection, CollectionProperty, CollectionPropertyValue } from "@stash/domain-types";

export interface CollectionSelectionOption { readonly id: string; readonly label: string }
export interface CollectionSelectionOptions {
  readonly members: readonly CollectionSelectionOption[];
  readonly attachments: readonly CollectionSelectionOption[];
  readonly notes: readonly CollectionSelectionOption[];
  readonly tasks: readonly CollectionSelectionOption[];
  readonly projects: readonly CollectionSelectionOption[];
}

export const emptyCollectionSelectionOptions: CollectionSelectionOptions = {
  members: [], attachments: [], notes: [], tasks: [], projects: [],
};

function collectionRecordLabel(collection: Collection, record: Collection["records"][number]) {
  const primary = [...collection.properties].sort((left, right) => left.position - right.position).find(({ type }) => type === "text");
  const value = primary ? record.values[primary.id] : undefined;
  return typeof value === "string" && value.trim() ? value.trim() : `Untitled record ${record.position}`;
}

export function selectionOptionsForProperty(property: CollectionProperty, selections: CollectionSelectionOptions,
  collections: readonly Collection[] = []): readonly CollectionSelectionOption[] {
  if (property.type === "single_select" || property.type === "multi_select")
    return property.options.map(({ id, name }) => ({ id, label: name }));
  if (property.type === "person") return selections.members;
  if (property.type === "attachment") return selections.attachments;
  if (property.type !== "relation") return [];
  const relationTarget = property.target;
  if (relationTarget.kind === "collection_records") {
    const target = collections.find(({ id }) => id === relationTarget.collectionId);
    return target?.records.map((record) => ({ id: record.id, label: collectionRecordLabel(target, record) })) ?? [];
  }
  if (relationTarget.kind === "notes") return selections.notes;
  if (relationTarget.kind === "tasks") return selections.tasks;
  return selections.projects;
}

export function selectionIds(value: CollectionPropertyValue | undefined): string[] {
  if (!Array.isArray(value)) return [];
  return value.map((entry) => typeof entry === "string" ? entry : entry.id);
}

export function relationSelectionValue(ids: readonly string[], options: readonly CollectionSelectionOption[]): CollectionPropertyValue {
  return ids.map((id) => ({ id, fallback: options.find((option) => option.id === id)?.label ?? "Unavailable item" }));
}
