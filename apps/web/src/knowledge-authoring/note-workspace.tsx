import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useRef, useState, type ReactNode } from "react";
import { Link } from "react-router";

import { ContextDrawer, type NoteContextData } from "./context-drawer";
import { branchImpactConfirmation, type BranchImpact } from "./branch-impact";
import styles from "./note-tree.module.css";

export function NoteWorkspace({ noteId, token, children, fetcher = globalThis.fetch }: {
  noteId: string; token: string; children: ReactNode; fetcher?: typeof fetch;
}) {
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [removedState, setRemovedState] = useState<"archived" | "trashed">();
  const toggleRef = useRef<HTMLButtonElement>(null);
  const client = useQueryClient();
  const context = useQuery({ queryKey: ["note-context", noteId], retry: false, queryFn: async () => {
    const response = await fetcher(`/api/notes/${encodeURIComponent(noteId)}/context`, { headers: { authorization: `Bearer ${token}` } });
    const body = await response.json() as NoteContextData & { message?: string };
    if (!response.ok) throw new Error(body.message || "Note context is unavailable.");
    return body;
  } });
  const branchAction = useMutation({ mutationFn: async (action: "archive" | "trash") => {
    const previewResponse = await fetcher(`/api/notes/${encodeURIComponent(noteId)}/branch-preview`, { method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify({ action }) });
    const preview = await previewResponse.json() as { impact?: BranchImpact; message?: string };
    if (!previewResponse.ok || !preview.impact) throw new Error(preview.message || "The branch impact could not be calculated.");
    const impact = preview.impact;
    const verb = action === "archive" ? "Archive" : "Move to trash";
    const confirmed = window.confirm(branchImpactConfirmation(`${verb} this Note and ${impact.descendantCount} descendants?`, impact));
    if (!confirmed) return { cancelled: true as const };
    const response = await fetcher(`/api/notes/${encodeURIComponent(noteId)}/${action}`, { method: "POST", headers: { authorization: `Bearer ${token}` } });
    const body = await response.json() as { message?: string };
    if (!response.ok) throw new Error(body.message || "The Note branch could not be updated.");
    return { cancelled: false as const, state: action === "archive" ? "archived" as const : "trashed" as const };
  }, onSuccess: async (result) => { if (!result || result.cancelled) return; setRemovedState(result.state); await client.invalidateQueries({ queryKey: ["note-tree"] }); } });
  const restore = useMutation({ mutationFn: async () => {
    const response = await fetcher(`/api/notes/${encodeURIComponent(noteId)}/restore`, { method: "POST", headers: { authorization: `Bearer ${token}` } });
    const body = await response.json() as { message?: string };
    if (!response.ok) throw new Error(body.message || "The Note branch could not be restored.");
  }, onSuccess: async () => { setRemovedState(undefined); await client.invalidateQueries({ queryKey: ["note-tree"] }); } });
  const close = () => { setDrawerOpen(false); requestAnimationFrame(() => toggleRef.current?.focus()); };
  return <div className={`${styles.noteWorkspace} ${drawerOpen ? styles.drawerIsOpen : ""}`}>
    <section aria-label="Note workspace controls" className={styles.workspaceBar}>
      {context.data ? <nav aria-label="Breadcrumb"><ol>{context.data.breadcrumbs.map((item, index) => <li key={item.id}>{index < context.data!.breadcrumbs.length - 1 ? <Link to={`/app/notes/${item.id}`}>{item.title}</Link> : <span aria-current="page">{item.title}</span>}</li>)}</ol></nav> : <span>{context.isError ? "Context unavailable" : "Opening Note…"}</span>}
      <div className={styles.workspaceActions}><Link to={`/app/notes/${noteId}/history`}>View history</Link>
        {context.data?.access === "read" ? <span role="note">Read-only access · Project Guests can navigate context and inspect history, but cannot change the Note.</span> : null}
        {context.data?.access === "edit" && (removedState ? <button aria-label="Restore Note branch" disabled={restore.isPending} type="button" onClick={() => restore.mutate()}>Restore branch</button> : <>
        <button aria-label="Archive Note branch" disabled={branchAction.isPending} type="button" onClick={() => branchAction.mutate("archive")}>Archive</button>
        <button aria-label="Move Note branch to trash" disabled={branchAction.isPending} type="button" onClick={() => branchAction.mutate("trash")}>Trash</button></>)}
        <button ref={toggleRef} aria-expanded={drawerOpen} aria-label={drawerOpen ? "Close Note context" : "Open Note context"} type="button"
          onClick={() => drawerOpen ? close() : setDrawerOpen(true)}>{drawerOpen ? "Close context" : "Context"}</button></div>
    </section>
    {removedState ? <p className={styles.branchStatus} role="status">This Note branch is {removedState}. Restore it to return it to the Note Tree.</p> : branchAction.isError || restore.isError ? <p className={styles.branchError} role="alert">{branchAction.error?.message ?? restore.error?.message}</p> : null}
    <div className={styles.editorSlot}>{children}</div>
    {!removedState ? <StarterTutorialPanel fetcher={fetcher} noteId={noteId} token={token} /> : null}
    {drawerOpen && context.data ? <ContextDrawer context={context.data} fetcher={fetcher} onClose={close} token={token} /> : null}
  </div>;
}

interface StarterTutorialData {
  workspaceId: string;
  notes: Array<{ id: string; title: string; content: string; parentId?: string }>;
  links: Array<{ id: string; sourceNoteId: string; targetNoteId: string; label: string }>;
  collection: { id: string; ownerNoteId: string; name: string; properties: Array<{ id: string; name: string; type: "text" }>;
    records: Array<{ id: string; values: Record<string, string> }> };
  taskView: { name: string; source: { kind: "tasks"; workspaceId: string; project: "none" }; presentation: "list" };
}

function StarterTutorialPanel({ noteId, token, fetcher }: { noteId: string; token: string; fetcher: typeof fetch }) {
  const client = useQueryClient(); const headers = { authorization: `Bearer ${token}` };
  const tutorial = useQuery({ queryKey: ["starter-tutorial", noteId], retry: false, queryFn: async () => {
    const response = await fetcher(`/api/notes/${encodeURIComponent(noteId)}/starter-tutorial`, { headers });
    if (response.status === 404) return undefined;
    const body = await response.json() as { tutorial?: StarterTutorialData; message?: string };
    if (!response.ok || !body.tutorial) throw new Error(body.message || "The starter guide could not be loaded.");
    return body.tutorial;
  } });
  const tasks = useQuery({ queryKey: ["starter-projectless-tasks", tutorial.data?.workspaceId], enabled: Boolean(tutorial.data), retry: false,
    queryFn: async () => { const response = await fetcher(`/api/workspaces/${encodeURIComponent(tutorial.data!.workspaceId)}/tasks?scope=projectless`, { headers });
      const body = await response.json() as { tasks?: Array<{ id: string; title: string; status: { id: string; name: string; category: string } }>; message?: string };
      if (!response.ok || !body.tasks) throw new Error(body.message || "Starter Tasks could not be loaded."); return body.tasks; } });
  const [collectionName, setCollectionName] = useState("");
  const rename = useMutation({ mutationFn: async () => { const response = await fetcher(`/api/notes/${encodeURIComponent(noteId)}/starter-tutorial/collection`, {
      method: "PUT", headers: { ...headers, "content-type": "application/json" }, body: JSON.stringify({ name: collectionName }),
    }); const body = await response.json() as { message?: string }; if (!response.ok) throw new Error(body.message || "The Collection could not be renamed."); },
    onSuccess: () => client.invalidateQueries({ queryKey: ["starter-tutorial", noteId] }) });
  const data = tutorial.data; if (!data) return null;
  const children = data.notes.filter((note) => note.parentId === noteId);
  const property = data.collection.properties[0];
  return <aside className={styles.starterTutorial} aria-labelledby="starter-tutorial-title">
    <header><p>Working guide</p><h2 id="starter-tutorial-title">Try the pieces together</h2><span>Everything here is real, editable, and removed with this starter branch.</span></header>
    <section aria-labelledby="starter-notes-title"><h3 id="starter-notes-title">Nested Notes</h3><ul>{children.map((note) => <li key={note.id}><Link to={`/app/notes/${note.id}`}><strong>{note.title}</strong><span>{note.content}</span></Link></li>)}</ul>
      {data.links.map((link) => <p className={styles.tutorialLink} key={link.id}><span>Relationship</span><Link to={`/app/notes/${link.targetNoteId}`}>{link.label} →</Link></p>)}</section>
    <section aria-labelledby="starter-collection-title"><h3 id="starter-collection-title">Collection</h3><form onSubmit={(event) => { event.preventDefault(); rename.mutate(); }}><label>Collection name<input value={collectionName || data.collection.name} onChange={(event) => setCollectionName(event.target.value)} /></label><button disabled={rename.isPending || !(collectionName || data.collection.name).trim()}>{rename.isPending ? "Saving…" : "Rename Collection"}</button></form>
      <table><thead><tr><th>{property?.name ?? "Value"}</th></tr></thead><tbody>{data.collection.records.map((record) => <tr key={record.id}><td>{property ? record.values[property.id] : ""}</td></tr>)}</tbody></table>{rename.isError ? <p role="alert">{rename.error.message}</p> : null}</section>
    <section aria-labelledby="starter-task-view-title"><h3 id="starter-task-view-title">Task View · {data.taskView.name}</h3><p>Project: none · Workspace Workflow</p>{tasks.isError ? <p role="alert">{tasks.error.message}</p> : <ul>{tasks.data?.map((task) => <li key={task.id}><span>{task.title}</span><strong>{task.status.name}</strong></li>)}</ul>}</section>
  </aside>;
}
