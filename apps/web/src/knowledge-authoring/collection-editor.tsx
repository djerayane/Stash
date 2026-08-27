import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";
import type { Collection, CollectionImpact, CollectionPropertyType, CollectionPropertyValue, ViewBlock, ViewDefinition, ViewPresentation } from "@stash/domain-types";

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
  const query = useQuery({ queryKey: ["note-collections", noteId], retry: false, queryFn: async () => {
    const response = await fetcher(`/api/notes/${encodeURIComponent(noteId)}/collections`, { headers: auth(token) });
    const body = await response.json() as { workspaceId?: string; collections?: Collection[]; views?: ViewBlock[]; message?: string };
    if (!response.ok || !body.workspaceId || !body.collections || !body.views) throw new Error(body.message || "Collections are unavailable.");
    return { workspaceId: body.workspaceId, collections: body.collections, views: body.views };
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
    const source = query.data?.collections.find(({ id: collectionId }) => collectionId === viewSourceId);
    if (!source) throw new Error("Enter a Collection identity available in this Note.");
    const view: ViewBlock = { schema: "stash.view-block.v1", id: id(), workspaceId: source.workspaceId, ownerNoteId: noteId,
      blockId: id(), title: `${source.title} view`, definition: { source: { kind: "collection", collectionId: source.id },
        presentation: "table", filters: [], sorts: [], layout: {} } };
    const response = await fetcher(`/api/notes/${encodeURIComponent(noteId)}/view-blocks`, { method: "POST",
      headers: { ...auth(token), "content-type": "application/json" }, body: JSON.stringify(view) });
    const body = await response.json() as { message?: string }; if (!response.ok) throw new Error(body.message || "The View Block could not be created.");
  }, onSuccess: async () => { setViewSourceId(""); await client.invalidateQueries({ queryKey: ["note-collections", noteId] }); } });
  const preview = useMutation({ mutationFn: async () => { const response = await fetcher(`/api/notes/${encodeURIComponent(noteId)}/collections/impact`,
    { headers: auth(token) }); const body = await response.json() as { impact?: CollectionImpact; message?: string };
    if (!response.ok || !body.impact) throw new Error(body.message || "Collection impact is unavailable."); return body.impact; }, onSuccess: setImpact });
  const relocate = useMutation({ mutationFn: async () => { const response = await fetcher(`/api/notes/${encodeURIComponent(noteId)}/collections/relocate`, {
    method: "POST", headers: { ...auth(token), "content-type": "application/json" }, body: JSON.stringify({ destinationNoteId,
      collectionIds: impact?.collections.map(({ id }) => id) ?? [] }) }); const body = await response.json() as { message?: string };
    if (!response.ok) throw new Error(body.message || "Collections could not be relocated."); }, onSuccess: async () => {
    setImpact(undefined); await client.invalidateQueries({ queryKey: ["note-collections", noteId] }); } });
  if (query.isPending) return <p className={styles.status}>Opening structured knowledge…</p>;
  if (query.isError) return <p role="alert" className={styles.status}>{query.error.message}</p>;
  const collections = query.data.collections; const views = query.data.views;
  return <section className={styles.workspace} aria-labelledby="collections-heading"><header><div><p>Structured knowledge</p><h2 id="collections-heading">Collections and views</h2></div>
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
    {editable ? <div className={styles.viewCreate}><label>Embed an owned Collection<select value={viewSourceId} onChange={(event) => setViewSourceId(event.target.value)}>
      <option value="">Choose a Collection</option>{collections.map((entry) => <option key={entry.id} value={entry.id}>{entry.title}</option>)}</select></label>
      <button type="button" disabled={!viewSourceId || createView.isPending} onClick={() => createView.mutate()}>Add View Block</button></div> : null}
    {createView.isError ? <p role="alert">{createView.error.message}</p> : null}
    <div className={styles.views}>{views.map((entry) => <SavedCollectionView key={entry.id} initialView={entry} token={token} fetcher={fetcher} />)}
      {!views.length && collections.map((entry) => <CollectionView key={entry.id} view={{ schema: "stash.view-block.v1", id: entry.id,
        workspaceId: entry.workspaceId, ownerNoteId: noteId, blockId: entry.id, title: entry.title,
        definition: { source: { kind: "collection", collectionId: entry.id }, presentation: "table", filters: [], sorts: [], layout: {} } }}
        collection={entry} token={token} fetcher={fetcher} persisted={false} />)}</div>
    {editable ? <footer className={styles.ownership}><div><strong>Collection ownership</strong><span>Archive keeps records and views. Before trash or permanent removal, relocate or explicitly remove owned Collections after reviewing the impact.</span></div>
      <button type="button" disabled={preview.isPending} onClick={() => preview.mutate()}>Review removal impact</button></footer> : null}
    {impact ? <section className={styles.impact} aria-live="polite"><h3>Removal impact</h3><p>{impact.collections.length} Collections · {impact.collections.reduce((sum, item) => sum + item.recordCount, 0)} records · {impact.relations.reduce((sum, item) => sum + item.referenceCount, 0)} relations · {impact.viewBlocks.length} View Blocks</p>
      <details><summary>Review affected structured data</summary><ul>{impact.collections.map((item) => <li key={item.id}>{item.title}: {item.recordCount} records</li>)}
        {impact.viewBlocks.map((item) => <li key={item.id}>View Block: {item.title}</li>)}</ul></details>
      <form onSubmit={(event) => { event.preventDefault(); relocate.mutate(); }}><label>Relocate to Note identity<input required value={destinationNoteId} onChange={(event) => setDestinationNoteId(event.target.value)} /></label>
        <button disabled={relocate.isPending}>{relocate.isPending ? "Relocating…" : "Relocate Collections"}</button></form>
      {relocate.isError ? <p role="alert">{relocate.error.message}</p> : null}</section> : null}
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
  useEffect(() => { if (persisted) setDefinition(view.definition); }, [persisted, view.definition]);
  const evaluated = useMemo(() => evaluateCollectionView(collection, definition), [collection, definition]);
  const save = useMutation({ mutationFn: async (next: ViewDefinition) => { if (!persisted) return;
    const response = await fetcher(`/api/view-blocks/${encodeURIComponent(view.id)}`, { method: "PATCH", headers: { ...auth(token), "content-type": "application/json" }, body: JSON.stringify(next) });
    const body = await response.json() as { message?: string }; if (!response.ok) throw new Error(body.message || "The View could not be saved."); },
    onSuccess: async () => client.invalidateQueries({ queryKey: ["collection-view", view.id] }) });
  const update = (next: ViewDefinition) => { setDefinition(next); save.mutate(next); };
  const move = useMutation({ mutationFn: async ({ recordId, value }: { recordId: string; value: CollectionPropertyValue }) => {
    const patch = updateBoardGroup(collection, definition, recordId, value);
    const response = await fetcher(`/api/collections/${encodeURIComponent(collection.id)}/records/${encodeURIComponent(recordId)}`, {
      method: "PATCH", headers: { ...auth(token), "content-type": "application/json" }, body: JSON.stringify({ values: patch.values }) });
    const body = await response.json() as { message?: string }; if (!response.ok) throw new Error(body.message || "The record could not be moved."); },
    onSuccess: async () => { await Promise.all([client.invalidateQueries({ queryKey: ["collection-view", view.id] }),
      client.invalidateQueries({ queryKey: ["note-collections", view.ownerNoteId] })]); } });
  const focus = (recordId: string) => update({ ...definition, focused: { recordId } });
  return <article className={styles.viewBlock} aria-labelledby={`view-${view.id}`}><header><div><p>View Block</p><h3 id={`view-${view.id}`}>{view.title}</h3></div>
    <label>Presentation<select value={definition.presentation} onChange={(event) => update({ ...definition, presentation: event.target.value as ViewPresentation })}>
      <option value="table">Table</option><option value="board">Board</option><option value="list">List</option><option value="calendar">Calendar</option></select></label></header>
    <div className={styles.viewControls}><label>Filter by<select value={definition.filters[0]?.propertyId ?? ""} onChange={(event) => update({ ...definition,
      filters: event.target.value ? [{ propertyId: event.target.value, operator: "contains", value: "" }] : [] })}><option value="">No filter</option>
      {collection.properties.map((property) => <option key={property.id} value={property.id}>{property.name}</option>)}</select></label>
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
