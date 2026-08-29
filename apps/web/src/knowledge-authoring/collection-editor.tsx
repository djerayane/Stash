import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import type { Collection, ViewBlock, ViewDefinition, ViewPresentation } from "@stash/domain-types";

import { Button, Field, StatusNotice } from "../ui/control";
import { TaskView, type TaskViewRecord } from "../shared/task-view";
import { CollectionTable } from "./collection-table";
import { emptyCollectionSelectionOptions, type CollectionSelectionOptions } from "./collection-selection-options";
import styles from "./collection-editor.module.css";

function id() { return globalThis.crypto.randomUUID(); }
function auth(token: string, json = true) { return { authorization: `Bearer ${token}`, ...(json ? { "content-type": "application/json" } : {}) }; }

interface CollectionWorkspaceData {
  workspaceId: string;
  collections: Collection[];
  availableCollections: Collection[];
  availableCollectionNotes: Record<string, string>;
  availableNotes: Array<{ id: string; title: string }>;
  selectionOptions: CollectionSelectionOptions;
  views: ViewBlock[];
}

export function CollectionWorkspace({ noteId, token, editable = true, fetcher = globalThis.fetch }: {
  noteId: string; token: string; editable?: boolean; fetcher?: typeof fetch;
}) {
  const client = useQueryClient(); const [insertOpen, setInsertOpen] = useState(false); const [sourceId, setSourceId] = useState("");
  const [focusCollectionId, setFocusCollectionId] = useState<string>();
  const query = useQuery({ queryKey: ["note-collections", noteId], retry: false, queryFn: async (): Promise<CollectionWorkspaceData> => {
    const response = await fetcher(`/api/notes/${encodeURIComponent(noteId)}/collections`, { headers: auth(token, false) });
    const body = await response.json() as Partial<CollectionWorkspaceData> & { message?: string };
    if (!response.ok || !body.workspaceId || !body.collections || !body.views) throw new Error(body.message || "Collections are unavailable.");
    const availableNotes = body.availableNotes ?? [];
    return { workspaceId: body.workspaceId, collections: body.collections, availableCollections: body.availableCollections ?? body.collections,
      availableCollectionNotes: body.availableCollectionNotes ?? {}, availableNotes, views: body.views,
      selectionOptions: { ...emptyCollectionSelectionOptions, ...body.selectionOptions,
        notes: body.selectionOptions?.notes ?? availableNotes.map(({ id, title }) => ({ id, label: title })) } };
  } });
  useEffect(() => { if (!focusCollectionId || !query.data?.collections.some(({ id: collectionId }) => collectionId === focusCollectionId)) return;
    const frame = requestAnimationFrame(() => { const title = document.querySelector<HTMLInputElement>(
      `[data-collection-id="${focusCollectionId}"] input[aria-label="Collection title"]`);
      if (title) { title.focus(); setFocusCollectionId(undefined); } });
    return () => cancelAnimationFrame(frame);
  }, [focusCollectionId, query.data?.collections]);
  const changed = async () => { await Promise.all([client.invalidateQueries({ queryKey: ["note-collections", noteId] }),
    client.invalidateQueries({ queryKey: ["collection-view"] })]); };
  const create = useMutation({ mutationFn: async () => { const collectionId = id(); const propertyId = id();
    const collection: Collection = { schema: "stash.collection.v1", id: collectionId, workspaceId: query.data!.workspaceId, ownerNoteId: noteId,
      title: "Untitled collection", properties: [{ id: propertyId, name: "Name", type: "text", position: 1 }], records: [] };
    const response = await fetcher(`/api/notes/${encodeURIComponent(noteId)}/collections`, { method: "POST", headers: auth(token), body: JSON.stringify(collection) });
    const body = await response.json() as { message?: string }; if (!response.ok) throw new Error(body.message || "The Collection could not be created.");
    return collectionId;
  }, onSuccess: async (collectionId) => { setFocusCollectionId(collectionId); await changed(); } });
  const insert = useMutation({ mutationFn: async () => { const source = query.data?.availableCollections.find(({ id }) => id === sourceId);
    if (!source) throw new Error("Choose an accessible Collection.");
    const view: ViewBlock = { schema: "stash.view-block.v1", id: id(), workspaceId: source.workspaceId, ownerNoteId: noteId, blockId: id(),
      title: source.title, definition: { source: { kind: "collection", collectionId: source.id }, presentation: "table", filters: [], sorts: [], layout: {} } };
    const response = await fetcher(`/api/notes/${encodeURIComponent(noteId)}/view-blocks`, { method: "POST", headers: auth(token), body: JSON.stringify(view) });
    const body = await response.json() as { message?: string }; if (!response.ok) throw new Error(body.message || "The view could not be inserted.");
  }, onSuccess: async () => { setInsertOpen(false); setSourceId(""); await changed(); } });
  if (query.isPending) return <StatusNotice>Opening Collections…</StatusNotice>;
  if (query.isError) return <StatusNotice tone="error">{query.error.message}</StatusNotice>;
  const reusable = query.data.availableCollections.filter(({ ownerNoteId }) => ownerNoteId !== noteId);
  const collectionViews = query.data.views.filter((view) => view.definition.source.kind === "collection");
  const taskViews = query.data.views.filter((view) => view.definition.source.kind === "tasks");
  return <section className={styles.workspace} aria-labelledby="collections-heading"><header className={styles.workspaceHeader}>
    <div><h2 id="collections-heading">Collections</h2><p>Shape recurring knowledge directly where you use it.</p></div>
    {editable ? <Button type="button" variant="secondary" onClick={() => setInsertOpen(true)}>Insert view of another collection</Button> : null}
  </header>{insertOpen ? <form className={styles.insertMenu} onSubmit={(event) => { event.preventDefault(); insert.mutate(); }}>
    <Field label="Collection source"><select aria-label="Collection source" required value={sourceId} onChange={(event) => setSourceId(event.target.value)}>
      <option value="">Choose a Collection</option>{reusable.map((entry) => <option key={entry.id} value={entry.id}>{entry.title} — {query.data.availableCollectionNotes[entry.id] ?? "Another Note"}</option>)}</select></Field>
    <div className={styles.menuActions}><Button disabled={!sourceId} pending={insert.isPending}>Insert view</Button>
      <Button type="button" variant="secondary" onClick={() => { setInsertOpen(false); setSourceId(""); }}>Cancel insert view</Button></div>
    {insert.isError ? <p role="alert">{insert.error.message}</p> : null}</form> : null}
    <div className={styles.collections}>{query.data.collections.map((collection) => <CollectionTable key={`collection-${collection.id}`} collection={collection}
      availableNotes={query.data.availableNotes} availableCollections={query.data.availableCollections}
      availableCollectionNotes={query.data.availableCollectionNotes} selectionOptions={query.data.selectionOptions}
      editable={editable} token={token} fetcher={fetcher} onChanged={changed} />)}
      {editable ? <div className={styles.newCollection}><Button type="button" pending={create.isPending} onClick={() => create.mutate()}>New collection</Button>
        {create.isError ? <p role="alert">{create.error.message}</p> : null}</div> : null}
      {collectionViews.map((view) => { const sourceId = view.definition.source.kind === "collection" ? view.definition.source.collectionId : "";
        const source = query.data.availableCollections.find(({ id }) => id === sourceId);
        return source ? <CollectionTable key={`view-${view.id}`} collection={source} view={view} canonicalActions={false}
          sourceNoteTitle={query.data.availableCollectionNotes[source.id] ?? "Another Note"} availableNotes={query.data.availableNotes}
          availableCollections={query.data.availableCollections} availableCollectionNotes={query.data.availableCollectionNotes}
          selectionOptions={query.data.selectionOptions}
          editable={editable} token={token} fetcher={fetcher} onChanged={changed} />
          : <section key={`view-${view.id}`} className={styles.collection} aria-label={view.title}><StatusNotice tone="error">
            {view.title} cannot open because its source Collection is unavailable. <button type="button" onClick={() => void changed()}>Try again</button>
          </StatusNotice></section>; })}</div>
    {taskViews.map((view) => <SavedTaskView key={view.id} view={view} editable={editable} token={token} fetcher={fetcher} />)}
  </section>;
}

function SavedTaskView({ view, editable, token, fetcher }: { view: ViewBlock; editable: boolean; token: string; fetcher: typeof fetch }) {
  const client = useQueryClient(); const [definition, setDefinition] = useState(view.definition); const [title, setTitle] = useState("");
  const query = useQuery({ queryKey: ["collection-view", view.id], retry: false, queryFn: async () => {
    const response = await fetcher(`/api/view-blocks/${encodeURIComponent(view.id)}`, { headers: auth(token, false) });
    const body = await response.json() as { view?: ViewBlock; source?: { kind: "tasks"; records: TaskViewRecord[];
      statuses: Array<{ id: string; name: string }> }; message?: string };
    if (!response.ok || !body.view || body.source?.kind !== "tasks") throw new Error(body.message || "This Task view is unavailable.");
    return { view: body.view, source: body.source };
  } });
  const save = useMutation({ mutationFn: async (next: ViewDefinition) => { const response = await fetcher(`/api/view-blocks/${encodeURIComponent(view.id)}`,
    { method: "PATCH", headers: auth(token), body: JSON.stringify(next) }); if (!response.ok) throw new Error("The View could not be saved."); } });
  const create = useMutation({ mutationFn: async () => { if (definition.source.kind !== "tasks") return;
    const response = await fetcher(`/api/workspaces/${encodeURIComponent(definition.source.workspaceId)}/canonical-tasks`, { method: "POST",
      headers: auth(token), body: JSON.stringify({ title: title.trim() }) }); if (!response.ok) throw new Error("The Task could not be created.");
  }, onSuccess: async () => { setTitle(""); await client.invalidateQueries({ queryKey: ["collection-view", view.id] }); } });
  const move = useMutation({ mutationFn: async ({ id, statusId }: { id: string; statusId: string }) => { const response = await fetcher(
    `/api/canonical-tasks/${encodeURIComponent(id)}`, { method: "PATCH", headers: auth(token), body: JSON.stringify({ statusId }) });
    if (!response.ok) throw new Error("The Task status could not be changed."); },
  onSuccess: async () => { await client.invalidateQueries({ queryKey: ["collection-view", view.id] }); } });
  if (query.isPending) return <StatusNotice>Opening {view.title}…</StatusNotice>;
  if (query.isError) return <StatusNotice tone="error">{query.error.message}</StatusNotice>;
  const update = (presentation: ViewPresentation) => { const next = { ...definition, presentation }; setDefinition(next); save.mutate(next); };
  return <section className={styles.taskView} aria-labelledby={`task-view-${view.id}`}><header><h3 id={`task-view-${view.id}`}>{view.title}</h3>
    <Field label="Presentation"><select disabled={!editable} value={definition.presentation}
      onChange={(event) => update(event.target.value as ViewPresentation)}><option value="table">Table</option><option value="board">Board</option>
      <option value="list">List</option><option value="calendar">Calendar</option></select></Field></header>
    {editable ? <form onSubmit={(event) => { event.preventDefault(); if (title.trim()) create.mutate(); }}><Field label="New Task"><input required
      value={title} onChange={(event) => setTitle(event.target.value)} /></Field><Button pending={create.isPending}>Create Task here</Button></form> : null}
    <TaskView tasks={query.data.source.records} definition={definition} statuses={editable ? query.data.source.statuses : undefined}
      onStatusChange={editable ? (task, statusId) => move.mutate({ id: task.id, statusId }) : undefined} empty={<p role="note">No Tasks in this view.</p>} />
    {create.isError || save.isError || move.isError ? <p role="alert">{(create.error || save.error || move.error)?.message}</p> : null}</section>;
}
