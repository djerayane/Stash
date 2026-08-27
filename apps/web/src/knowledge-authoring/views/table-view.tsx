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

export function TableView({ title, collection, records, onFocus }: { title: string; collection: Collection;
  records: readonly CollectionRecord[]; onFocus: (recordId: string) => void }) {
  return <div className="collection-table-scroll"><table aria-label={title}><thead><tr><th scope="col">Record</th>
    {collection.properties.map((property) => <th key={property.id} scope="col">{property.name}</th>)}</tr></thead><tbody>
    {records.map((record) => <tr key={record.id}><th scope="row"><button type="button" onClick={() => onFocus(record.id)}>{recordTitle(collection, record)}</button></th>
      {collection.properties.map((property) => <td key={property.id}>{valueText(record.values[property.id])}</td>)}</tr>)}</tbody></table></div>;
}
