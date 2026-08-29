import type { Collection, CollectionRecord, ViewDefinition } from "@stash/domain-types";
import { recordTitle } from "./table-view";

export function CalendarView({ title, collection, records, definition, editable, onFocus }: { title: string; collection: Collection;
  records: readonly CollectionRecord[]; definition: ViewDefinition; editable: boolean; onFocus: (recordId: string) => void }) {
  const property = collection.properties.find(({ id, type }) => id === definition.groupBy && type === "date_time")
    ?? collection.properties.find(({ type }) => type === "date_time");
  const groups = new Map<string, CollectionRecord[]>();
  for (const record of records) { const value = property ? record.values[property.id] : undefined;
    const key = value && typeof value === "object" && !Array.isArray(value) && "start" in value ? value.start.slice(0, 10) : "No date";
    groups.set(key, [...(groups.get(key) ?? []), record]); }
  return <section aria-label={`${title} calendar`} className="collection-calendar">{property ? groups.size
    ? [...groups].sort(([a], [b]) => a.localeCompare(b)).map(([date, entries]) =>
      <section key={date}><h4>{date === "No date" ? date : <time dateTime={date}>{date}</time>}</h4><ul>{entries.map((record) => <li key={record.id}><button type="button"
        disabled={!editable} onClick={() => onFocus(record.id)}>{recordTitle(collection, record)}</button></li>)}</ul></section>)
    : <p role="note">No dated records yet.</p>
    : <p role="note">Add a date/time property to place records on this calendar.</p>}</section>;
}
