import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useRef, useState } from "react";
import type { Collection, CollectionImpact, CollectionProperty, CollectionPropertyType, CollectionPropertyValue, ViewBlock, ViewDefinition, ViewPresentation } from "@stash/domain-types";

import { evaluateCollectionView, updateBoardGroup } from "./views/view-model";
import { TableView } from "./views/table-view";
import { BoardView } from "./views/board-view";
import { ListView } from "./views/list-view";
import { CalendarView } from "./views/calendar-view";
import styles from "./collection-editor.module.css";

const propertyTypes: Array<{ value: CollectionPropertyType; label: string }> = [
  { value: "text", label: "Text" }, { value: "number", label: "Number" }, { value: "checkbox", label: "Checkbox" },
  { value: "date_time", label: "Date and time" }, { value: "single_select", label: "Single select" },
  { value: "multi_select", label: "Multi select" }, { value: "person", label: "Person" }, { value: "url", label: "URL" },
  { value: "attachment", label: "Attachment" }, { value: "relation", label: "Direct relation" },
];
function id() { return globalThis.crypto.randomUUID(); }
function auth(token: string) { return { authorization: `Bearer ${token}` }; }

export function CollectionWorkspace({ noteId, token, editable = true, fetcher = globalThis.fetch }: { noteId: string; token: string; editable?: boolean; fetcher?: typeof fetch }) {
  const client = useQueryClient(); const [createOpen, setCreateOpen] = useState(false); const [title, setTitle] = useState("");
  const [propertyName, setPropertyName] = useState("Name"); const [propertyType, setPropertyType] = useState<CollectionPropertyType>("text");
  const [relationKind, setRelationKind] = useState<"collection_records" | "notes" | "tasks" | "projects">("notes");
  const [relationCollectionId, setRelationCollectionId] = useState(""); const [viewSourceId, setViewSourceId] = useState("");
  const [impact, setImpact] = useState<CollectionImpact>(); const [destinationNoteId, setDestinationNoteId] = useState("");
  const [deleteSelection, setDeleteSelection] = useState<string[]>([]); const [deleteConfirmed, setDeleteConfirmed] = useState(false);
  const query = useQuery({ queryKey: ["note-collections", noteId], retry: false, queryFn: async () => {
    const response = await fetcher(`/api/notes/${encodeURIComponent(noteId)}/collections`, { headers: auth(token) });
    const body = await response.json() as { workspaceId?: string; collections?: Collection[]; availableCollections?: Collection[]; views?: ViewBlock[]; message?: string };
    if (!response.ok || !body.workspaceId || !body.collections || !body.views) throw new Error(body.message || "Collections are unavailable.");
    return { workspaceId: body.workspaceId, collections: body.collections, availableCollections: body.availableCollections ?? body.collections, views: body.views };
  } });
  const create = useMutation({ mutationFn: async () => {
    const propertyId = id(); const collectionId = id(); const base = { id: propertyId, name: propertyName.trim(), position: 1 };
    const property = propertyType === "single_select" || propertyType === "multi_select" ? { ...base, type: propertyType, options: [{ id: "option", name: "Option" }] }
      : propertyType === "relation" ? { ...base, type: "relation" as const, target: relationKind === "collection_records"
        ? { kind: "collection_records" as const, collectionId: relationCollectionId } : { kind: relationKind } } : { ...base, type: propertyType };
    const collection = { schema: "stash.collection.v1", id: collectionId, workspaceId: query.data!.workspaceId,
      ownerNoteId: noteId, title: title.trim(), properties: [property], records: [] };
    const response = await fetcher(`/api/notes/${encodeURIComponent(noteId)}/collections`, { method: "POST",
      headers: { ...auth(token), "content-type": "application/json" }, body: JSON.stringify(collection) });
    const body = await response.json() as { message?: string }; if (!response.ok) throw new Error(body.message || "The Collection could not be created.");
  }, onSuccess: async () => { setCreateOpen(false); setTitle(""); await client.invalidateQueries({ queryKey: ["note-collections", noteId] }); } });
  const createView = useMutation({ mutationFn: async () => {
    const source = query.data?.availableCollections.find(({ id: collectionId }) => collectionId === viewSourceId);
    if (!source) throw new Error("Choose an accessible Collection.");
    const view: ViewBlock = { schema: "stash.view-block.v1", id: id(), workspaceId: source.workspaceId, ownerNoteId: noteId,
      blockId: id(), title: `${source.title} view`, definition: { source: { kind: "collection", collectionId: source.id },
        presentation: "table", filters: [], sorts: [], layout: {} } };
    const response = await fetcher(`/api/notes/${encodeURIComponent(noteId)}/view-blocks`, { method: "POST",
      headers: { ...auth(token), "content-type": "application/json" }, body: JSON.stringify(view) });
    const body = await response.json() as { message?: string }; if (!response.ok) throw new Error(body.message || "The View Block could not be created.");
  }, onSuccess: async () => { setViewSourceId(""); await client.invalidateQueries({ queryKey: ["note-collections", noteId] }); } });
  const preview = useMutation({ mutationFn: async () => { const response = await fetcher(`/api/notes/${encodeURIComponent(noteId)}/collections/impact`,
    { headers: auth(token) }); const body = await response.json() as { impact?: CollectionImpact; message?: string };
    if (!response.ok || !body.impact) throw new Error(body.message || "Collection impact is unavailable."); return body.impact; }, onSuccess: (nextImpact) => {
    setImpact(nextImpact); setDeleteSelection([]); setDeleteConfirmed(false); } });
  const relocate = useMutation({ mutationFn: async () => { const response = await fetcher(`/api/notes/${encodeURIComponent(noteId)}/collections/relocate`, {
    method: "POST", headers: { ...auth(token), "content-type": "application/json" }, body: JSON.stringify({ destinationNoteId,
      collectionIds: impact?.collections.map(({ id }) => id) ?? [] }) }); const body = await response.json() as { message?: string };
    if (!response.ok) throw new Error(body.message || "Collections could not be relocated."); }, onSuccess: async () => {
    setImpact(undefined); await client.invalidateQueries({ queryKey: ["note-collections", noteId] }); } });
  const remove = useMutation({ mutationFn: async () => { const response = await fetcher(`/api/notes/${encodeURIComponent(noteId)}/collections/delete`, {
    method: "POST", headers: { ...auth(token), "content-type": "application/json" }, body: JSON.stringify({ confirmed: true,
      impactToken: impact?.token, collectionIds: deleteSelection }) }); const body = await response.json() as { message?: string };
    if (!response.ok) throw new Error(body.message || "Collections could not be permanently deleted."); }, onSuccess: async () => {
    setImpact(undefined); setDeleteSelection([]); setDeleteConfirmed(false);
    await client.invalidateQueries({ queryKey: ["note-collections", noteId] }); } });
  if (query.isPending) return <p className={styles.status}>Opening structured knowledge…</p>;
  if (query.isError) return <p role="alert" className={styles.status}>{query.error.message}</p>;
  const collections = query.data.collections; const views = query.data.views;
  return <section className={styles.workspace} aria-labelledby="collections-heading"><header><div><h2 id="collections-heading">Collections and views</h2></div>
    {editable ? <button type="button" onClick={() => setCreateOpen((open) => !open)}>{createOpen ? "Close Collection form" : "New Collection"}</button> : null}</header>
    {createOpen ? <form className={styles.form} onSubmit={(event) => { event.preventDefault(); create.mutate(); }}>
      <label>Collection title<input required value={title} onChange={(event) => setTitle(event.target.value)} /></label>
      <label>First property<input required value={propertyName} onChange={(event) => setPropertyName(event.target.value)} /></label>
      <label>Property type<select value={propertyType} onChange={(event) => setPropertyType(event.target.value as CollectionPropertyType)}>
        {propertyTypes.map((type) => <option key={type.value} value={type.value}>{type.label}</option>)}</select></label>
      {propertyType === "relation" ? <><label>Relation target<select value={relationKind} onChange={(event) => setRelationKind(event.target.value as typeof relationKind)}>
        <option value="notes">Notes</option><option value="tasks">Tasks</option><option value="projects">Projects</option><option value="collection_records">Collection records</option></select></label>
        {relationKind === "collection_records" ? <label>Related Collection identity<input required value={relationCollectionId} onChange={(event) => setRelationCollectionId(event.target.value)} /></label> : null}</> : null}
      <button disabled={create.isPending}>{create.isPending ? "Creating…" : "Create Collection"}</button>{create.isError ? <p role="alert">{create.error.message}</p> : null}</form> : null}
    {editable ? <div className={styles.viewCreate}><label>Source Collection<select value={viewSourceId} onChange={(event) => setViewSourceId(event.target.value)}>
      <option value="">Choose an accessible Collection</option>{query.data.availableCollections.map((entry) => <option key={entry.id} value={entry.id}>{entry.title}</option>)}</select></label>
      <button type="button" disabled={!viewSourceId || createView.isPending} onClick={() => createView.mutate()}>Add View Block</button></div> : null}
    {createView.isError ? <p role="alert">{createView.error.message}</p> : null}
    {editable ? <div className={styles.authoring}>{collections.map((entry) => <CollectionAuthoring key={entry.id} collection={entry}
      token={token} fetcher={fetcher} noteId={noteId} />)}</div> : null}
    <div className={styles.views}>{views.map((entry) => <SavedCollectionView key={entry.id} initialView={entry} token={token} fetcher={fetcher} />)}
      {!views.length && collections.map((entry) => <CollectionView key={entry.id} view={{ schema: "stash.view-block.v1", id: entry.id,
        workspaceId: entry.workspaceId, ownerNoteId: noteId, blockId: entry.id, title: entry.title,
        definition: { source: { kind: "collection", collectionId: entry.id }, presentation: "table", filters: [], sorts: [], layout: {} } }}
        collection={entry} token={token} fetcher={fetcher} persisted={false} />)}</div>
    {editable ? <footer className={styles.ownership}><div><strong>Collection ownership</strong><span>Archive keeps records and views. Before trash or permanent removal, relocate or explicitly remove owned Collections after reviewing the impact.</span></div>
      <button type="button" disabled={preview.isPending} onClick={() => preview.mutate()}>Review removal impact</button></footer> : null}
    {impact ? <section className={styles.impact} aria-live="polite"><h3>Removal impact</h3><p>{impact.collections.length} Collections · {impact.collections.reduce((sum, item) => sum + item.recordCount, 0)} records · {impact.relations.reduce((sum, item) => sum + item.referenceCount, 0)} relations · {impact.viewBlocks.length} View Blocks</p>
      <p>{impact.relations.reduce((sum, item) => sum + item.referenceCount, 0)} direct relation references will be removed.</p>
      <p>{impact.viewBlocks.length} View Block{impact.viewBlocks.length === 1 ? "" : "s"} will be removed.</p>
      <details><summary>Review affected structured data</summary><ul>{impact.collections.map((item) => <li key={item.id}>{item.title}: {item.recordCount} records</li>)}
        {impact.relations.map((item) => <li key={`${item.collectionId}-${item.recordId}-${item.propertyId}`}>{item.referenceCount} relation references from record {item.recordId}</li>)}
        {impact.viewBlocks.map((item) => <li key={item.id}>View Block: {item.title}</li>)}</ul></details>
      <form onSubmit={(event) => { event.preventDefault(); relocate.mutate(); }}><label>Relocate to Note identity<input required value={destinationNoteId} onChange={(event) => setDestinationNoteId(event.target.value)} /></label>
        <button disabled={relocate.isPending}>{relocate.isPending ? "Relocating…" : "Relocate Collections"}</button></form>
      <form onSubmit={(event) => { event.preventDefault(); remove.mutate(); }}><fieldset><legend>Select every Collection to delete permanently</legend>
        {impact.collections.map((item) => <label key={item.id}><input type="checkbox" checked={deleteSelection.includes(item.id)}
          onChange={(event) => setDeleteSelection((selected) => event.target.checked ? [...selected, item.id] : selected.filter((id) => id !== item.id))} />
          Delete {item.title} and its {item.recordCount} record{item.recordCount === 1 ? "" : "s"}</label>)}</fieldset>
        <label><input type="checkbox" checked={deleteConfirmed} onChange={(event) => setDeleteConfirmed(event.target.checked)} />
          I understand this permanently deletes the selected records, relations, and View Blocks</label>
        <button disabled={remove.isPending || !deleteConfirmed || deleteSelection.length !== impact.collections.length}>
          {remove.isPending ? "Deleting…" : "Permanently delete selected Collections"}</button></form>
      {relocate.isError ? <p role="alert">{relocate.error.message}</p> : null}{remove.isError ? <p role="alert">{remove.error.message}</p> : null}</section> : null}
  </section>;
}

function propertyInput(property: CollectionProperty, raw: string | boolean | string[]): CollectionPropertyValue | undefined {
  if (property.type === "checkbox") return Boolean(raw);
  if (Array.isArray(raw)) return raw;
  const value = String(raw).trim(); if (!value) return undefined;
  if (property.type === "number") return Number(value);
  if (property.type === "date_time") return { start: new Date(value).toISOString(), includeTime: true };
  if (property.type === "person" || property.type === "attachment") return value.split(",").map((entry) => entry.trim()).filter(Boolean);
  if (property.type === "relation") return value.split(",").map((entry) => { const [identity, ...fallback] = entry.split("|");
    return { id: identity!.trim(), fallback: fallback.join("|").trim() || identity!.trim() }; });
  return value;
}

function draftValue(property: CollectionProperty, value?: CollectionPropertyValue): string | boolean | string[] {
  if (property.type === "checkbox") return value === true;
  if (property.type === "multi_select") return Array.isArray(value) ? value.map(String) : [];
  if (property.type === "date_time" && value && typeof value === "object" && !Array.isArray(value) && "start" in value)
    return value.start.slice(0, 16);
  if (property.type === "relation" && Array.isArray(value)) return value.map((entry) => typeof entry === "string" ? entry : `${entry.id} | ${entry.fallback}`).join(", ");
  if ((property.type === "person" || property.type === "attachment") && Array.isArray(value)) return value.join(", ");
  return value === undefined || value === null ? "" : String(value);
}

function TypedValueControl({ property, value, onChange, prefix = "", labelText }: { property: CollectionProperty; value: string | boolean | string[];
  onChange: (value: string | boolean | string[]) => void; prefix?: string; labelText?: string }) {
  const label = labelText ?? `${prefix}${property.name} value`;
  if (property.type === "checkbox") return <label>{label}<input type="checkbox" checked={value === true} onChange={(event) => onChange(event.target.checked)} /></label>;
  if (property.type === "single_select") return <label>{label}<select value={String(value)} onChange={(event) => onChange(event.target.value)}>
    <option value="">No value</option>{property.options.map((option) => <option key={option.id} value={option.id}>{option.name}</option>)}</select></label>;
  if (property.type === "multi_select") return <label>{label}<select multiple value={Array.isArray(value) ? value : []}
    onChange={(event) => onChange(Array.from(event.target.selectedOptions).map(({ value: selected }) => selected))}>
    {property.options.map((option) => <option key={option.id} value={option.id}>{option.name}</option>)}</select></label>;
  const type = property.type === "number" ? "number" : property.type === "date_time" ? "datetime-local" : property.type === "url" ? "url" : "text";
  const hint = property.type === "relation" ? "Identity | readable fallback, comma separated" : property.type === "person" || property.type === "attachment"
    ? "Identities, comma separated" : undefined;
  return <label>{label}<input type={type} value={String(value)} placeholder={hint} onChange={(event) => onChange(event.target.value)} /></label>;
}

function CollectionAuthoring({ collection, token, fetcher, noteId }: { collection: Collection; token: string; fetcher: typeof fetch; noteId: string }) {
  const client = useQueryClient(); const [propertyOpen, setPropertyOpen] = useState(false); const [recordOpen, setRecordOpen] = useState(false);
  const [newName, setNewName] = useState(""); const [newType, setNewType] = useState<CollectionPropertyType>("text");
  const [options, setOptions] = useState(""); const [targetKind, setTargetKind] = useState<"collection_records" | "notes" | "tasks" | "projects">("notes");
  const [targetCollection, setTargetCollection] = useState(""); const [editingRecord, setEditingRecord] = useState<string>();
  const [values, setValues] = useState<Record<string, string | boolean | string[]>>({});
  const invalidate = async () => { await Promise.all([client.invalidateQueries({ queryKey: ["note-collections", noteId] }),
    client.invalidateQueries({ queryKey: ["collection-view"] })]); };
  const addProperty = useMutation({ mutationFn: async () => { const base = { id: id(), name: newName.trim(), type: newType,
    position: collection.properties.length + 1 }; const property = newType === "single_select" || newType === "multi_select"
      ? { ...base, options: options.split(",").map((name, index) => ({ id: `option-${index + 1}`, name: name.trim() })).filter(({ name }) => name) }
      : newType === "relation" ? { ...base, target: targetKind === "collection_records" ? { kind: targetKind, collectionId: targetCollection } : { kind: targetKind } } : base;
    const response = await fetcher(`/api/collections/${encodeURIComponent(collection.id)}/properties`, { method: "POST",
      headers: { ...auth(token), "content-type": "application/json" }, body: JSON.stringify(property) });
    const body = await response.json() as { message?: string }; if (!response.ok) throw new Error(body.message || "The property could not be added."); },
  onSuccess: async () => { setPropertyOpen(false); setNewName(""); await invalidate(); } });
  const saveRecord = useMutation({ mutationFn: async () => { const payload = { values: Object.fromEntries(collection.properties.map((property) =>
    [property.id, propertyInput(property, values[property.id] ?? draftValue(property))]).filter((entry) => entry[1] !== undefined)) };
    const response = await fetcher(editingRecord ? `/api/collections/${encodeURIComponent(collection.id)}/records/${encodeURIComponent(editingRecord)}`
      : `/api/collections/${encodeURIComponent(collection.id)}/records`, { method: editingRecord ? "PATCH" : "POST",
      headers: { ...auth(token), "content-type": "application/json" }, body: JSON.stringify(editingRecord ? payload : { id: id(),
        position: Math.max(0, ...collection.records.map(({ position }) => position)) + 1, ...payload }) });
    const body = await response.json() as { message?: string }; if (!response.ok) throw new Error(body.message || "The record could not be saved."); },
  onSuccess: async () => { setRecordOpen(false); setEditingRecord(undefined); setValues({}); await invalidate(); } });
  const openRecord = (recordId?: string) => { const record = collection.records.find(({ id: found }) => found === recordId); setEditingRecord(recordId);
    setValues(Object.fromEntries(collection.properties.map((property) => [property.id, draftValue(property, record?.values[property.id])]))); setRecordOpen(true); };
  return <section className={styles.authoringLane} aria-label={`${collection.title} authoring`}><header><strong>{collection.title}</strong><div>
    <button type="button" aria-label={`Add property to ${collection.title}`} onClick={() => setPropertyOpen((open) => !open)}>Add property</button>
    <button type="button" aria-label={`Add record to ${collection.title}`} onClick={() => openRecord()}>Add record</button></div></header>
    {propertyOpen ? <form className={styles.form} onSubmit={(event) => { event.preventDefault(); addProperty.mutate(); }}>
      <label>New property name<input required value={newName} onChange={(event) => setNewName(event.target.value)} /></label>
      <label>New property type<select value={newType} onChange={(event) => setNewType(event.target.value as CollectionPropertyType)}>
        {propertyTypes.map((type) => <option key={type.value} value={type.value}>{type.label}</option>)}</select></label>
      {newType === "single_select" || newType === "multi_select" ? <label>Options, comma separated<input required value={options} onChange={(event) => setOptions(event.target.value)} /></label> : null}
      {newType === "relation" ? <><label>Relation target<select value={targetKind} onChange={(event) => setTargetKind(event.target.value as typeof targetKind)}>
        <option value="notes">Notes</option><option value="tasks">Tasks</option><option value="projects">Projects</option><option value="collection_records">Collection records</option></select></label>
        {targetKind === "collection_records" ? <label>Target Collection identity<input required value={targetCollection} onChange={(event) => setTargetCollection(event.target.value)} /></label> : null}</> : null}
      <button disabled={addProperty.isPending}>Save property</button>{addProperty.isError ? <p role="alert">{addProperty.error.message}</p> : null}</form> : null}
    {collection.records.length ? <div className={styles.recordActions}>{collection.records.map((record, index) => <button key={record.id} type="button"
      onClick={() => openRecord(record.id)}>Edit record {index + 1}</button>)}</div> : null}
    {recordOpen ? <form className={styles.form} onSubmit={(event) => { event.preventDefault(); saveRecord.mutate(); }}>
      {collection.properties.map((property) => <TypedValueControl key={property.id} property={property} value={values[property.id] ?? draftValue(property)}
        onChange={(value) => setValues((current) => ({ ...current, [property.id]: value }))} />)}
      <button disabled={saveRecord.isPending}>{editingRecord ? "Save record changes" : "Save new record"}</button>
      {saveRecord.isError ? <p role="alert">{saveRecord.error.message}</p> : null}</form> : null}
  </section>;
}

function SavedCollectionView({ initialView, token, fetcher }: { initialView: ViewBlock; token: string; fetcher: typeof fetch }) {
  const query = useQuery({ queryKey: ["collection-view", initialView.id], retry: false, queryFn: async () => {
    const response = await fetcher(`/api/view-blocks/${encodeURIComponent(initialView.id)}`, { headers: auth(token) });
    const body = await response.json() as { view?: ViewBlock; source?: { kind: "collection"; collection: Collection }; message?: string };
    if (!response.ok || !body.view || body.source?.kind !== "collection") throw new Error(body.message || "This View source is unavailable.");
    return { view: body.view, collection: body.source.collection };
  } });
  if (query.isPending) return <p className={styles.status}>Opening {initialView.title}…</p>;
  if (query.isError) return <section className={styles.unavailable} role="status"><h3>View unavailable</h3><p>{query.error.message}</p></section>;
  return <CollectionView view={query.data.view} collection={query.data.collection} token={token} fetcher={fetcher} persisted />;
}

function CollectionView({ view, collection, token, fetcher, persisted }: { view: ViewBlock; collection: Collection; token: string;
  fetcher: typeof fetch; persisted: boolean }) {
  const client = useQueryClient(); const [definition, setDefinition] = useState(view.definition);
  const saveQueue = useRef<Promise<unknown>>(Promise.resolve());
  useEffect(() => { if (persisted) setDefinition(view.definition); }, [persisted, view.definition]);
  const evaluated = useMemo(() => evaluateCollectionView(collection, definition), [collection, definition]);
  const save = useMutation({ mutationFn: async (next: ViewDefinition) => { if (!persisted) return;
    const response = await fetcher(`/api/view-blocks/${encodeURIComponent(view.id)}`, { method: "PATCH", headers: { ...auth(token), "content-type": "application/json" }, body: JSON.stringify(next) });
    const body = await response.json() as { message?: string }; if (!response.ok) throw new Error(body.message || "The View could not be saved."); },
    onSuccess: async () => client.invalidateQueries({ queryKey: ["collection-view", view.id] }) });
  const update = (next: ViewDefinition) => { setDefinition(next); if (persisted)
    saveQueue.current = saveQueue.current.catch(() => undefined).then(() => save.mutateAsync(next)); };
  const move = useMutation({ mutationFn: async ({ recordId, value }: { recordId: string; value: CollectionPropertyValue }) => {
    const patch = updateBoardGroup(collection, definition, recordId, value);
    const response = await fetcher(`/api/collections/${encodeURIComponent(collection.id)}/records/${encodeURIComponent(recordId)}`, {
      method: "PATCH", headers: { ...auth(token), "content-type": "application/json" }, body: JSON.stringify({ values: patch.values }) });
    const body = await response.json() as { message?: string }; if (!response.ok) throw new Error(body.message || "The record could not be moved."); },
    onSuccess: async () => { await Promise.all([client.invalidateQueries({ queryKey: ["collection-view", view.id] }),
      client.invalidateQueries({ queryKey: ["note-collections", view.ownerNoteId] })]); } });
  const focus = (recordId: string) => update({ ...definition, focused: { recordId } });
  const filter = definition.filters[0]; const filterProperty = collection.properties.find(({ id: propertyId }) => propertyId === filter?.propertyId);
  const setFilterProperty = (propertyId: string) => update({ ...definition, filters: propertyId
    ? [{ propertyId, operator: "contains", value: "" }] : [] });
  const setFilterOperator = (operator: ViewDefinition["filters"][number]["operator"]) => { if (!filter) return;
    update({ ...definition, filters: [{ propertyId: filter.propertyId, operator,
      ...(!["is_empty", "is_not_empty"].includes(operator) ? { value: filter.value ?? "" } : {}) }] }); };
  const setFilterValue = (raw: string | boolean | string[]) => { if (!filter || !filterProperty) return; const value = propertyInput(filterProperty, raw);
    update({ ...definition, filters: [{ propertyId: filter.propertyId, operator: filter.operator, value: value ?? "" }] }); };
  return <article className={styles.viewBlock} aria-labelledby={`view-${view.id}`}><header><div><h3 id={`view-${view.id}`}>{view.title}</h3></div>
    <label>Presentation<select value={definition.presentation} onChange={(event) => update({ ...definition, presentation: event.target.value as ViewPresentation })}>
      <option value="table">Table</option><option value="board">Board</option><option value="list">List</option><option value="calendar">Calendar</option></select></label></header>
    <div className={styles.viewControls}><label>Filter by<select value={filter?.propertyId ?? ""} onChange={(event) => setFilterProperty(event.target.value)}><option value="">No filter</option>
      {collection.properties.map((property) => <option key={property.id} value={property.id}>{property.name}</option>)}</select></label>
      <label>Filter operator<select disabled={!filter} value={filter?.operator ?? "contains"} onChange={(event) => setFilterOperator(event.target.value as typeof filter.operator)}>
        <option value="contains">Contains</option><option value="equals">Equals</option><option value="not_equals">Does not equal</option>
        <option value="is_empty">Is empty</option><option value="is_not_empty">Is not empty</option></select></label>
      {filter && filterProperty && !["is_empty", "is_not_empty"].includes(filter.operator) ? <TypedValueControl property={filterProperty}
        labelText="Filter value" value={draftValue(filterProperty, filter.value)} onChange={setFilterValue} /> : null}
      <label>Sort by<select value={definition.sorts[0]?.propertyId ?? ""} onChange={(event) => update({ ...definition,
        sorts: event.target.value ? [{ propertyId: event.target.value, direction: "ascending" }] : [] })}><option value="">Record order</option>
        {collection.properties.map((property) => <option key={property.id} value={property.id}>{property.name}</option>)}</select></label>
      <label>Group by<select value={definition.groupBy ?? ""} onChange={(event) => update({ ...definition, groupBy: event.target.value || undefined })}>
        <option value="">No grouping</option>{collection.properties.map((property) => <option key={property.id} value={property.id}>{property.name}</option>)}</select></label>
      <label>Density<select value={String(definition.layout.density ?? "comfortable")} onChange={(event) => update({ ...definition, layout: { ...definition.layout, density: event.target.value } })}>
        <option value="comfortable">Comfortable</option><option value="compact">Compact</option></select></label></div>
    {definition.presentation === "table" ? <TableView title={view.title} collection={collection} records={evaluated.records} onFocus={focus} />
      : definition.presentation === "board" ? <BoardView title={view.title} collection={collection} records={evaluated.records} definition={definition}
        onFocus={focus} onMove={(recordId, value) => move.mutate({ recordId, value })} />
        : definition.presentation === "list" ? <ListView title={view.title} collection={collection} records={evaluated.records} onFocus={focus} />
          : <CalendarView title={view.title} collection={collection} records={evaluated.records} definition={definition} onFocus={focus} />}
    {definition.focused ? <p className={styles.focused} role="status">Focused record: {definition.focused.recordId}</p> : null}
    {save.isError ? <p role="alert">{save.error.message}</p> : null}{move.isError ? <p role="alert">{move.error.message}</p> : null}</article>;
}
