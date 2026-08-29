import { useState } from "react";
import type { Collection, CollectionPropertyValue, CollectionRecord, ViewDefinition } from "@stash/domain-types";
import { recordTitle } from "./table-view";

export function BoardView({ title, collection, records, definition, editable, onMove, onFocus }: { title: string; collection: Collection;
  records: readonly CollectionRecord[]; definition: ViewDefinition;
  editable: boolean; onMove: (recordId: string, source: CollectionPropertyValue, destination: CollectionPropertyValue) => Promise<void>;
  onFocus: (recordId: string) => void }) {
  const [failedMove, setFailedMove] = useState<{ recordId: string; source: CollectionPropertyValue; destination: CollectionPropertyValue }>();
  const move = async (recordId: string, source: CollectionPropertyValue, destination: CollectionPropertyValue) => {
    try { await onMove(recordId, source, destination); setFailedMove(undefined); }
    catch { setFailedMove({ recordId, source, destination }); }
  };
  const property = collection.properties.find(({ id }) => id === definition.groupBy);
  const options: ReadonlyArray<{ id: string | null; name: string }> = property?.type === "single_select" || property?.type === "multi_select" ? [...property.options, { id: null, name: "No value" }]
    : property?.type === "checkbox" ? [{ id: "false", name: "Not checked" }, { id: "true", name: "Checked" }] : [];
  return <section aria-label={`${title} board`} className="collection-board">{options.length ? options.map((option) => {
    const groupRecords = records.filter((record) => { const value = record.values[property!.id];
      if (option.id === null) return value === undefined || value === null || value === "" || Array.isArray(value) && value.length === 0;
      return property?.type === "multi_select" ? Array.isArray(value) && value.map(String).includes(option.id) : String(value ?? "false") === option.id; });
    const groupId = option.id ?? "no-value";
    return <section key={groupId} aria-labelledby={`collection-group-${property!.id}-${groupId}`}><h4 id={`collection-group-${property!.id}-${groupId}`}>{option.name}</h4>
      {groupRecords.length ? <ul>{groupRecords.map((record) => <li key={record.id}><button type="button" disabled={!editable} className="collection-card" onClick={() => onFocus(record.id)}>{recordTitle(collection, record)}</button>
        {editable ? <div aria-label={`Move ${recordTitle(collection, record)}`}>{options.filter(({ id }) => id !== option.id).map((destination) => <button key={destination.id ?? "no-value"}
          type="button" onClick={() => void move(record.id, option.id, destination.id)}
          aria-label={`Move ${recordTitle(collection, record)} to ${destination.name}`}>Move to {destination.name}</button>)}</div> : null}
        {failedMove?.recordId === record.id ? <p role="alert">Move not saved. <button type="button"
          onClick={() => void move(record.id, failedMove.source, failedMove.destination)}>Try again</button></p> : null}</li>)}</ul>
        : <p role="note">No records in this group.</p>}</section>;
  }) : <p role="note">Choose a checkbox or select property under Group by to arrange this board.</p>}</section>;
}
