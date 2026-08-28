import type { Collection, CollectionPropertyValue, CollectionRecord, ViewDefinition } from "@stash/domain-types";
import { recordTitle } from "./table-view";

export function BoardView({ title, collection, records, definition, onMove, onFocus }: { title: string; collection: Collection;
  records: readonly CollectionRecord[]; definition: ViewDefinition;
  onMove: (recordId: string, value: CollectionPropertyValue) => void; onFocus: (recordId: string) => void }) {
  const property = collection.properties.find(({ id }) => id === definition.groupBy);
  const options = property?.type === "single_select" || property?.type === "multi_select" ? property.options
    : property?.type === "checkbox" ? [{ id: "false", name: "Not checked" }, { id: "true", name: "Checked" }] : [];
  return <section aria-label={`${title} board`} className="collection-board">{options.length ? options.map((option) => {
    const groupRecords = records.filter((record) => property?.type === "multi_select" ? (record.values[property.id] as readonly string[] | undefined)?.includes(option.id)
      : String(record.values[property!.id] ?? "false") === option.id);
    return <section key={option.id} aria-labelledby={`collection-group-${property!.id}-${option.id}`}><h4 id={`collection-group-${property!.id}-${option.id}`}>{option.name}</h4>
      {groupRecords.length ? <ul>{groupRecords.map((record) => <li key={record.id}><button type="button" className="collection-card" onClick={() => onFocus(record.id)}>{recordTitle(collection, record)}</button>
        <div aria-label={`Move ${recordTitle(collection, record)}`}>{options.filter(({ id }) => id !== option.id).map((destination) => <button key={destination.id}
          type="button" onClick={() => onMove(record.id, property?.type === "checkbox" ? destination.id === "true" : destination.id)}
          aria-label={`Move ${recordTitle(collection, record)} to ${destination.name}`}>Move to {destination.name}</button>)}</div></li>)}</ul>
        : <p role="note">No records in this group.</p>}</section>;
  }) : <p role="note">Choose a checkbox or select property under Group by to arrange this board.</p>}</section>;
}
