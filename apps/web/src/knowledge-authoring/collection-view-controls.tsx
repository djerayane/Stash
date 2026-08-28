import { useState } from "react";
import type { Collection, CollectionPropertyType, ViewDefinition, ViewPresentation } from "@stash/domain-types";

import { Button, Field } from "../ui/control";
import { presentationRequirement } from "./views/view-model";
import styles from "./collection-editor.module.css";

const presentations: Array<{ value: ViewPresentation; label: string }> = [
  { value: "table", label: "Table" }, { value: "board", label: "Board" }, { value: "list", label: "List" }, { value: "calendar", label: "Calendar" },
];

export function CollectionViewControls({ collection, definition, editable, onChange, onAddRequiredProperty }: {
  collection: Collection; definition: ViewDefinition; editable: boolean;
  onChange(definition: ViewDefinition): void;
  onAddRequiredProperty(type: CollectionPropertyType, presentation: ViewPresentation): Promise<void>;
}) {
  const [viewOpen, setViewOpen] = useState(false); const [requested, setRequested] = useState<ViewPresentation>(); const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const choose = (presentation: ViewPresentation) => { if (!editable) return; const requirement = presentationRequirement(collection, presentation);
    if (requirement && editable) { setRequested(presentation); return; }
    onChange({ ...definition, presentation, ...(presentation === "board" && !definition.groupBy ? {
      groupBy: collection.properties.find(({ type }) => type === "single_select" || type === "multi_select" || type === "checkbox")?.id,
    } : {}) }); };
  const requirement = requested ? presentationRequirement(collection, requested) : undefined;
  const addRequired = async () => { if (!requirement || !requested || pending) return; setPending(true); setError("");
    try { await onAddRequiredProperty(requirement.propertyType, requested); setRequested(undefined); }
    catch (reason) { setError(reason instanceof Error ? reason.message : "The required property could not be added."); }
    finally { setPending(false); } };
  const filter = definition.filters[0]; const visible = Array.isArray(definition.layout.visiblePropertyIds)
    ? definition.layout.visiblePropertyIds as string[] : collection.properties.map(({ id }) => id);
  const filterProperty = collection.properties.find(({ id }) => id === filter?.propertyId);
  const updateFilter = (next: Partial<NonNullable<typeof filter>>) => {
    if (!filter) return; const candidate = { ...filter, ...next };
    onChange({ ...definition, filters: [candidate] });
  };
  const active = definition.filters.length + definition.sorts.length + (definition.groupBy ? 1 : 0)
    + (visible.length !== collection.properties.length ? 1 : 0) + (definition.layout.density === "compact" ? 1 : 0);
  return <div className={styles.viewArea}><div className={styles.presentation} role="group" aria-label="Collection presentation">
    {presentations.map((entry) => <button type="button" key={entry.value} aria-pressed={definition.presentation === entry.value}
      disabled={!editable} onClick={() => choose(entry.value)}>{entry.label}</button>)}
    <button type="button" disabled={!editable} aria-expanded={viewOpen} onClick={() => setViewOpen((open) => !open)}>View{active ? ` · ${active}` : ""}</button>
  </div>{requirement && requested ? <div className={styles.requirement} role="status"><p>{requested === "calendar"
    ? "Calendar needs a date property." : "Board needs a select property."}</p><Button pending={pending} type="button" onClick={() => void addRequired()}>{requirement.actionLabel}</Button>
    <Button type="button" variant="secondary" onClick={() => setRequested(undefined)}>Not now</Button></div> : null}
    {error ? <p role="alert">{error} <button type="button" onClick={() => void addRequired()}>Try again</button></p> : null}
    {viewOpen ? <div className={styles.viewControls} aria-label="View settings">
      <Field label="Filter by"><select disabled={!editable} aria-label="Filter by" value={filter?.propertyId ?? ""} onChange={(event) => onChange({ ...definition,
        filters: event.target.value ? [{ propertyId: event.target.value, operator: "contains", value: "" }] : [] })}><option value="">No filter</option>
        {collection.properties.map((property) => <option key={property.id} value={property.id}>{property.name}</option>)}</select></Field>
      {filter ? <><Field label="Filter condition"><select disabled={!editable} aria-label="Filter condition" value={filter.operator} onChange={(event) => {
        const operator = event.target.value as typeof filter.operator;
        updateFilter(["is_empty", "is_not_empty"].includes(operator) ? { operator, value: undefined } : { operator, value: filter.value ?? "" });
      }}><option value="contains">Contains</option><option value="equals">Equals</option><option value="not_equals">Does not equal</option>
        <option value="is_empty">Is empty</option><option value="is_not_empty">Is not empty</option></select></Field>
      {filter.operator !== "is_empty" && filter.operator !== "is_not_empty" ? <Field label="Filter value"><input aria-label="Filter value"
        disabled={!editable} type={filterProperty?.type === "number" ? "number" : filterProperty?.type === "date_time" ? "date" : "text"}
        value={typeof filter.value === "string" || typeof filter.value === "number" ? String(filter.value) : ""}
        onChange={(event) => updateFilter({ value: filterProperty?.type === "number" && event.target.value
          ? Number(event.target.value) : event.target.value })} /></Field> : null}</> : null}
      <Field label="Sort by"><select disabled={!editable} aria-label="Sort by" value={definition.sorts[0]?.propertyId ?? ""} onChange={(event) => onChange({ ...definition,
        sorts: event.target.value ? [{ propertyId: event.target.value, direction: "ascending" }] : [] })}><option value="">Record order</option>
        {collection.properties.map((property) => <option key={property.id} value={property.id}>{property.name}</option>)}</select></Field>
      <Field label="Group by"><select disabled={!editable} aria-label="Group by" value={definition.groupBy ?? ""} onChange={(event) => onChange({ ...definition,
        groupBy: event.target.value || undefined })}><option value="">No grouping</option>{collection.properties.map((property) =>
          <option key={property.id} value={property.id}>{property.name}</option>)}</select></Field>
      <Field label="Density"><select disabled={!editable} aria-label="Density" value={String(definition.layout.density ?? "comfortable")} onChange={(event) => onChange({ ...definition,
        layout: { ...definition.layout, density: event.target.value } })}><option value="comfortable">Comfortable</option><option value="compact">Compact</option></select></Field>
      <fieldset disabled={!editable}><legend>Visible properties</legend>{collection.properties.map((property) => <label key={property.id}><input type="checkbox"
        checked={visible.includes(property.id)} onChange={(event) => onChange({ ...definition, layout: { ...definition.layout,
          visiblePropertyIds: event.target.checked ? [...visible, property.id] : visible.filter((id) => id !== property.id) } })} />{property.name}</label>)}</fieldset>
    </div> : null}</div>;
}
