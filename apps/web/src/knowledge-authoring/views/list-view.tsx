import type { Collection, CollectionRecord } from "@stash/domain-types";
import { recordTitle, valueText } from "./table-view";

export function ListView({ title, collection, records, editable, onFocus }: { title: string; collection: Collection;
  records: readonly CollectionRecord[]; editable: boolean; onFocus: (recordId: string) => void }) {
  if (!records.length) return <p role="note">No records in this view.</p>;
  return <ul aria-label={title} className="collection-list">{records.map((record) => <li key={record.id}>
    <button type="button" disabled={!editable} onClick={() => onFocus(record.id)}><strong>{recordTitle(collection, record)}</strong>
      {collection.properties.length > 1 ? <span>{collection.properties.slice(1, 4).map((property) => `${property.name}: ${valueText(record.values[property.id])}`).join(" · ")}</span> : null}</button>
  </li>)}</ul>;
}
