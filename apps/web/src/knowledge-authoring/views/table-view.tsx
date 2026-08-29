import type { Collection, CollectionPropertyValue, CollectionRecord } from "@stash/domain-types";

export function valueText(value: CollectionPropertyValue | undefined): string {
  if (value === undefined || value === null) return "—";
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return String(value);
  if ("start" in value) return value.end ? `${value.start} – ${value.end}` : value.start;
  return (value as readonly (string | { fallback: string })[]).map((entry) => typeof entry === "string" ? entry : entry.fallback).join(", ") || "—";
}

export function recordTitle(collection: Collection, record: CollectionRecord): string {
  const title = collection.properties.find(({ type }) => type === "text");
  return title ? valueText(record.values[title.id]) : `Record ${record.position}`;
}
