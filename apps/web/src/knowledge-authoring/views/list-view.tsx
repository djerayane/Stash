import type { Collection, CollectionRecord } from "@stash/domain-types";
import { recordTitle, valueText } from "./table-view";

export function ListView({ title, collection, records, onFocus }: { title: string; collection: Collection;
  records: readonly CollectionRecord[]; onFocus: (recordId: string) => void }) {
  return <ul aria-label={title} className="collection-list">{records.map((record) => <li key={record.id}>
    <button type="button" onClick={() => onFocus(record.id)}><strong>{recordTitle(collection, record)}</strong>
      <span>{collection.properties.slice(1, 4).map((property) => `${property.name}: ${valueText(record.values[property.id])}`).join(" · ")}</span></button>
  </li>)}</ul>;
}
