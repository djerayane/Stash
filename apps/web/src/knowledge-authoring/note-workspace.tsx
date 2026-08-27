import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { Link } from "react-router";
import type { Collection, ViewBlock } from "@stash/domain-types";

import { ContextDrawer, type NoteContextData } from "./context-drawer";
import { branchImpactConfirmation, type BranchImpact } from "./branch-impact";
import styles from "./note-tree.module.css";
import { CollectionWorkspace } from "./collection-editor";

export function NoteWorkspace({ noteId, token, children, fetcher = globalThis.fetch }: {
  noteId: string; token: string; children: ReactNode; fetcher?: typeof fetch;
}) {
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [removedState, setRemovedState] = useState<"archived" | "trashed">();
  const [permanentlyRemoved, setPermanentlyRemoved] = useState(false);
  const toggleRef = useRef<HTMLButtonElement>(null);
  const removalStatusRef = useRef<HTMLParagraphElement>(null);
  const activeNoteIdRef = useRef(noteId);
  activeNoteIdRef.current = noteId;
  useEffect(() => { setRemovedState(undefined); setPermanentlyRemoved(false); }, [noteId]);
  useEffect(() => { if (permanentlyRemoved) removalStatusRef.current?.focus(); }, [permanentlyRemoved]);
  const client = useQueryClient();
  const context = useQuery({ queryKey: ["note-context", noteId], retry: false, queryFn: async () => {
    const response = await fetcher(`/api/notes/${encodeURIComponent(noteId)}/context`, { headers: { authorization: `Bearer ${token}` } });
    const body = await response.json() as NoteContextData & { message?: string };
    if (!response.ok) throw new Error(body.message || "Note context is unavailable.");
    return body;
  } });
  const branchAction = useMutation({ mutationFn: async ({ action, originNoteId }: {
    action: "archive" | "trash"; originNoteId: string;
  }) => {
    const previewResponse = await fetcher(`/api/notes/${encodeURIComponent(originNoteId)}/branch-preview`, { method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify({ action }) });
    const preview = await previewResponse.json() as { impact?: BranchImpact; message?: string };
    if (!previewResponse.ok || !preview.impact) throw new Error(preview.message || "The branch impact could not be calculated.");
    const impact = preview.impact;
    const verb = action === "archive" ? "Archive" : "Move to trash";
    const confirmed = window.confirm(branchImpactConfirmation(`${verb} this Note and ${impact.descendantCount} descendants?`, impact));
    if (!confirmed) return { cancelled: true as const, originNoteId };
    const response = await fetcher(`/api/notes/${encodeURIComponent(originNoteId)}/${action}`, { method: "POST", headers: { authorization: `Bearer ${token}` } });
    const body = await response.json() as { message?: string };
    if (!response.ok) throw new Error(body.message || "The Note branch could not be updated.");
    return { cancelled: false as const, originNoteId,
      state: action === "archive" ? "archived" as const : "trashed" as const };
  }, onSuccess: async (result) => {
    if (!result || result.cancelled) return;
    const invalidation = client.invalidateQueries({ queryKey: ["note-tree"] });
    if (activeNoteIdRef.current === result.originNoteId) setRemovedState(result.state);
    await invalidation;
  } });
  const restore = useMutation({ mutationFn: async (originNoteId: string) => {
    const response = await fetcher(`/api/notes/${encodeURIComponent(originNoteId)}/restore`, { method: "POST", headers: { authorization: `Bearer ${token}` } });
    const body = await response.json() as { message?: string };
    if (!response.ok) throw new Error(body.message || "The Note branch could not be restored.");
    return originNoteId;
  }, onSuccess: async (originNoteId) => {
    const invalidation = client.invalidateQueries({ queryKey: ["note-tree"] });
    if (activeNoteIdRef.current === originNoteId) setRemovedState(undefined);
    await invalidation;
  } });
  const branchActionCurrent = branchAction.variables?.originNoteId === noteId;
  const restoreCurrent = restore.variables === noteId;
  const close = () => { setDrawerOpen(false); requestAnimationFrame(() => toggleRef.current?.focus()); };
  return <div className={`${styles.noteWorkspace} ${drawerOpen ? styles.drawerIsOpen : ""}`}>
    <section aria-label="Note workspace controls" className={styles.workspaceBar}>
      {context.data ? <nav aria-label="Breadcrumb"><ol>{context.data.breadcrumbs.map((item, index) => <li key={item.id}>{index < context.data!.breadcrumbs.length - 1 ? <Link to={`/app/notes/${item.id}`}>{item.title}</Link> : <span aria-current="page">{item.title}</span>}</li>)}</ol></nav> : <span>{context.isError ? "Context unavailable" : "Opening Note…"}</span>}
      <div className={styles.workspaceActions}><Link to={`/app/notes/${noteId}/history`}>View history</Link>
        {context.data?.access === "read" ? <span role="note">Read-only access · Project Guests can navigate context and inspect history, but cannot change the Note.</span> : null}
        {context.data?.access === "edit" && !permanentlyRemoved && (removedState ? <button aria-label="Restore Note branch" disabled={restore.isPending && restoreCurrent} type="button" onClick={() => restore.mutate(noteId)}>Restore branch</button> : <>
        <button aria-label="Archive Note branch" disabled={branchAction.isPending && branchActionCurrent} type="button" onClick={() => branchAction.mutate({ action: "archive", originNoteId: noteId })}>Archive</button>
        <button aria-label="Move Note branch to trash" disabled={branchAction.isPending && branchActionCurrent} type="button" onClick={() => branchAction.mutate({ action: "trash", originNoteId: noteId })}>Trash</button></>)}
        <button ref={toggleRef} aria-expanded={drawerOpen} aria-label={drawerOpen ? "Close Note context" : "Open Note context"} type="button"
          onClick={() => drawerOpen ? close() : setDrawerOpen(true)}>{drawerOpen ? "Close context" : "Context"}</button></div>
    </section>
    {permanentlyRemoved ? <p className={styles.branchStatus} ref={removalStatusRef} role="status" tabIndex={-1}>The starter tutorial and its sample Tasks were permanently removed.</p>
      : removedState ? <p className={styles.branchStatus} role="status">This Note branch is {removedState}. Restore it to return it to the Note Tree.</p>
        : (branchAction.isError && branchActionCurrent) || (restore.isError && restoreCurrent)
          ? <p className={styles.branchError} role="alert">{branchActionCurrent ? branchAction.error?.message : restore.error?.message}</p> : null}
    {!permanentlyRemoved ? <div className={styles.editorSlot}>{children}</div> : null}
    {!removedState && !permanentlyRemoved ? <CollectionWorkspace editable={context.data?.access === "edit"} fetcher={fetcher}
      noteId={noteId} token={token} /> : null}
    {!removedState && !permanentlyRemoved ? <StarterTutorialPanel fetcher={fetcher} noteId={noteId} token={token}
      onRemoved={(originNoteId) => { if (activeNoteIdRef.current === originNoteId) setPermanentlyRemoved(true); }} /> : null}
    {drawerOpen && context.data ? <ContextDrawer context={context.data} fetcher={fetcher} onClose={close} token={token} /> : null}
  </div>;
}

interface StarterTutorialData {
  workspaceId: string;
  rootNoteId: string;
  notes: Array<{ id: string; title: string; content: string; parentId?: string }>;
  links: Array<{ id: string; sourceNoteId: string; targetNoteId: string; label: string }>;
  collection: Collection;
  viewBlock: ViewBlock;
}

function StarterTutorialPanel({ noteId, token, fetcher, onRemoved }: {
  noteId: string; token: string; fetcher: typeof fetch; onRemoved: (originNoteId: string) => void;
}) {
  const client = useQueryClient(); const headers = { authorization: `Bearer ${token}` };
  const tutorial = useQuery({ queryKey: ["starter-tutorial", noteId], retry: false, queryFn: async () => {
    const response = await fetcher(`/api/notes/${encodeURIComponent(noteId)}/starter-tutorial`, { headers });
    if (response.status === 404) return null;
    const body = await response.json() as { tutorial?: StarterTutorialData; message?: string };
    if (!response.ok || !body.tutorial) throw new Error(body.message || "The starter guide could not be loaded.");
    return body.tutorial;
  } });
  const tasks = useQuery({ queryKey: ["starter-projectless-tasks", tutorial.data?.workspaceId], enabled: Boolean(tutorial.data), retry: false,
    queryFn: async () => { const response = await fetcher(`/api/workspaces/${encodeURIComponent(tutorial.data!.workspaceId)}/tasks?scope=projectless`, { headers });
      const body = await response.json() as { tasks?: Array<{ id: string; title: string; status: { id: string; name: string; category: string } }>; message?: string };
      if (!response.ok || !body.tasks) throw new Error(body.message || "Starter Tasks could not be loaded."); return body.tasks; } });
  const [collectionTitle, setCollectionTitle] = useState<string>(); const [recordValue, setRecordValue] = useState<string>();
  const [viewLayout, setViewLayout] = useState<"list" | "table">(); const [titleContains, setTitleContains] = useState<string>();
  const saveCollection = useMutation({ mutationFn: async () => { const response = await fetcher(`/api/notes/${encodeURIComponent(noteId)}/starter-tutorial/collection`, {
      method: "PUT", headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify({ title: collectionTitle ?? data!.collection.title,
        recordValue: recordValue ?? String(Object.values(data!.collection.records[0]?.values ?? {})[0] ?? "") }),
    }); const body = await response.json() as { message?: string }; if (!response.ok) throw new Error(body.message || "The Collection could not be saved."); },
    onSuccess: () => client.invalidateQueries({ queryKey: ["starter-tutorial", noteId] }) });
  const saveView = useMutation({ mutationFn: async () => { const response = await fetcher(`/api/notes/${encodeURIComponent(noteId)}/starter-tutorial/view`, {
      method: "PUT", headers: { ...headers, "content-type": "application/json" }, body: JSON.stringify({
        layout: viewLayout ?? (data!.viewBlock.definition.presentation === "table" ? "table" : "list"),
        titleContains: titleContains ?? String(data!.viewBlock.definition.filters.find(({ propertyId }) => propertyId === "task:title")?.value ?? ""),
      }),
    }); const body = await response.json() as { message?: string }; if (!response.ok) throw new Error(body.message || "The Task View could not be saved."); },
    onSuccess: () => client.invalidateQueries({ queryKey: ["starter-tutorial", noteId] }) });
  const remove = useMutation({ mutationFn: async (originNoteId: string) => {
    if (!window.confirm("Permanently remove this starter Note branch, its Collection and View, and its sample Tasks? This cannot be undone."))
      return { removed: false as const, originNoteId };
    const response = await fetcher(`/api/notes/${encodeURIComponent(originNoteId)}/starter-tutorial`, { method: "DELETE",
      headers: { ...headers, "content-type": "application/json" }, body: JSON.stringify({ confirmed: true }) });
    const body = await response.json() as { removed?: boolean; message?: string };
    if (!response.ok || !body.removed) throw new Error(body.message || "The starter tutorial could not be removed.");
    return { removed: true as const, originNoteId };
  }, onSuccess: async (result) => {
    if (!result.removed) return;
    const invalidation = client.invalidateQueries({ queryKey: ["note-tree"] });
    onRemoved(result.originNoteId);
    await invalidation;
  } });
  const removeCurrent = remove.variables === noteId;
  const data = tutorial.data; if (!data) return null;
  const children = data.notes.filter((note) => note.parentId === data.rootNoteId);
  const property = data.collection.properties[0];
  const savedTitleFilter = String(data.viewBlock.definition.filters.find(({ propertyId }) => propertyId === "task:title")?.value ?? "");
  const visibleTasks = tasks.data?.filter((task) => task.title.toLocaleLowerCase().includes(savedTitleFilter.toLocaleLowerCase()));
  return <aside className={styles.starterTutorial} aria-labelledby="starter-tutorial-title">
    <header><p>Working guide</p><h2 id="starter-tutorial-title">Try the pieces together</h2><span>These Notes, links, structured content, and Tasks are real Workspace objects.</span></header>
    <section aria-labelledby="starter-notes-title"><h3 id="starter-notes-title">Nested Notes</h3><ul>{children.map((note) => <li key={note.id}><Link to={`/app/notes/${note.id}`}><strong>{note.title}</strong><span>{note.content}</span></Link></li>)}</ul>
      {data.links.map((link) => <p className={styles.tutorialLink} key={link.id}><span>Relationship</span><Link to={`/app/notes/${link.targetNoteId}`}>{link.label} →</Link></p>)}</section>
    <section aria-labelledby="starter-collection-title"><h3 id="starter-collection-title">Collection</h3><form onSubmit={(event) => { event.preventDefault(); saveCollection.mutate(); }}>
      <label>Collection title<input value={collectionTitle ?? data.collection.title} onChange={(event) => setCollectionTitle(event.target.value)} /></label>
      <label>{property?.name ?? "Record"}<input value={recordValue ?? (property ? String(data.collection.records[0]?.values[property.id] ?? "") : "")}
        onChange={(event) => setRecordValue(event.target.value)} /></label>
      <button disabled={saveCollection.isPending}>{saveCollection.isPending ? "Saving…" : "Save Collection"}</button></form>
      {saveCollection.isError ? <p role="alert">{saveCollection.error.message}</p> : null}</section>
    <section aria-labelledby="starter-task-view-title"><h3 id="starter-task-view-title">Task View · {data.viewBlock.title}</h3><p>Project: none · Workspace Workflow</p>
      <form onSubmit={(event) => { event.preventDefault(); saveView.mutate(); }}><label>Layout<select value={viewLayout ?? (data.viewBlock.definition.presentation === "table" ? "table" : "list")}
        onChange={(event) => setViewLayout(event.target.value as "list" | "table")}><option value="list">List</option><option value="table">Table</option></select></label>
        <label>Task title contains<input value={titleContains ?? savedTitleFilter}
          onChange={(event) => setTitleContains(event.target.value)} /></label><button disabled={saveView.isPending}>{saveView.isPending ? "Saving…" : "Save Task View"}</button></form>
      {tasks.isError ? <p role="alert">{tasks.error.message}</p> : data.viewBlock.definition.presentation === "table" ? <table><thead><tr><th>Task</th><th>Status</th></tr></thead><tbody>{visibleTasks?.map((task) => <tr key={task.id}><td>{task.title}</td><td>{task.status.name}</td></tr>)}</tbody></table>
        : <ul>{visibleTasks?.map((task) => <li key={task.id}><span>{task.title}</span><strong>{task.status.name}</strong></li>)}</ul>}
      {saveView.isError ? <p role="alert">{saveView.error.message}</p> : null}</section>
    <footer className={styles.tutorialRemoval}><div><strong>Finished with the guide?</strong><span>Permanent removal also deletes its Collection, View, sample Tasks, and tutorial-only Workflow status.</span></div>
      <button disabled={remove.isPending && removeCurrent} type="button" onClick={() => remove.mutate(noteId)}>{remove.isPending && removeCurrent ? "Removing…" : "Remove tutorial"}</button>
      {remove.isError && removeCurrent ? <p role="alert">{remove.error.message}</p> : null}</footer>
  </aside>;
}
