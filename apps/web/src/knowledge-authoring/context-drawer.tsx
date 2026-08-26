import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState, type FormEvent, type KeyboardEvent } from "react";
import { Link } from "react-router";

import styles from "./note-tree.module.css";

export interface NoteContextData {
  noteId: string;
  workspaceId: string;
  breadcrumbs: Array<{ id: string; title: string }>;
  outgoingLinks: Array<{ id: string; noteId: string; title: string; label: string; relationshipType?: string }>;
  backlinks: Array<{ id: string; noteId: string; title: string; label: string; relationshipType?: string }>;
  projectIds: string[];
  projects: Array<{ id: string; name: string; key: string }>;
}

export function ContextDrawer({ context, onClose, token, fetcher = globalThis.fetch }: { context: NoteContextData; onClose(): void; token: string; fetcher?: typeof fetch }) {
  const [tab, setTab] = useState<"links" | "properties" | "projects" | "sharing" | "discussions">("links");
  const [targetNoteId, setTargetNoteId] = useState("");
  const [relationshipType, setRelationshipType] = useState("");
  const client = useQueryClient();
  const tree = useQuery({ queryKey: ["note-tree", context.workspaceId], retry: false, queryFn: async () => {
    const response = await fetcher(`/api/workspaces/${encodeURIComponent(context.workspaceId)}/note-tree`, { headers: { authorization: `Bearer ${token}` } });
    const body = await response.json() as { nodes?: Array<{ id: string; title: string }>; message?: string };
    if (!response.ok || !body.nodes) throw new Error(body.message || "Available Notes could not be opened.");
    return { nodes: body.nodes };
  } });
  const createLink = useMutation({ mutationFn: async () => {
    const response = await fetcher(`/api/notes/${encodeURIComponent(context.noteId)}/context/links`, { method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ targetNoteId: targetNoteId.trim(), label: "Note", ...(relationshipType.trim() ? { relationshipType: relationshipType.trim() } : {}) }) });
    const body = await response.json() as { message?: string };
    if (!response.ok) throw new Error(body.message || "The Note link could not be created.");
  }, onSuccess: async () => { setTargetNoteId(""); setRelationshipType(""); await client.invalidateQueries({ queryKey: ["note-context", context.noteId] }); } });
  const tabs = ["links", "properties", "projects", "sharing", "discussions"] as const;
  const tabKeyboard = (event: KeyboardEvent<HTMLButtonElement>, item: typeof tabs[number]) => { const index = tabs.indexOf(item);
    const next = event.key === "ArrowRight" ? tabs[(index + 1) % tabs.length] : event.key === "ArrowLeft" ? tabs[(index - 1 + tabs.length) % tabs.length] : undefined;
    if (!next) return; event.preventDefault(); setTab(next); event.currentTarget.parentElement?.querySelector<HTMLButtonElement>(`[data-tab="${next}"]`)?.focus(); };
  return <aside className={styles.drawer} aria-label="Note context">
    <header><div><p>In context</p><h2>{context.breadcrumbs.at(-1)?.title ?? "Note"}</h2></div><button aria-label="Close Note context" type="button" onClick={onClose}>×</button></header>
    <div className={styles.drawerTabs} role="tablist" aria-label="Note context sections">{tabs.map((item) => <button key={item} role="tab" data-tab={item}
      aria-selected={tab === item} tabIndex={tab === item ? 0 : -1} type="button" onKeyDown={(event) => tabKeyboard(event, item)} onClick={() => setTab(item)}>{item[0]!.toUpperCase() + item.slice(1)}</button>)}</div>
    <div className={styles.drawerBody} role="tabpanel">
      {tab === "links" ? <><form className={styles.linkForm} onSubmit={(event: FormEvent) => { event.preventDefault(); createLink.mutate(); }}>
        <h3>Link another Note</h3><label>Target Note<select required value={targetNoteId} onChange={(event) => setTargetNoteId(event.target.value)}><option value="">Choose a Note</option>
          {tree.data?.nodes.filter(({ id }) => id !== context.noteId).map((note) => <option key={note.id} value={note.id}>{note.title}</option>)}</select></label>
        <label>Relationship type<input maxLength={80} placeholder="supports, contradicts…" value={relationshipType} onChange={(event) => setRelationshipType(event.target.value)} /></label>
        <button disabled={createLink.isPending} type="submit">Create Note link</button>{createLink.isError ? <p role="alert">{createLink.error.message}</p> : null}
      </form><section><h3>Backlinks</h3>{context.backlinks.length ? <ul>{context.backlinks.map((link) => <li key={link.id}><Link to={`/app/notes/${link.noteId}`}>{link.title}</Link><span>{link.relationshipType ?? link.label}</span></li>)}</ul> : <p>No Notes link here yet.</p>}</section>
        <section><h3>Outgoing links</h3>{context.outgoingLinks.length ? <ul>{context.outgoingLinks.map((link) => <li key={link.id}><Link to={`/app/notes/${link.noteId}`}>{link.title}</Link><span>{link.relationshipType ?? link.label}</span></li>)}</ul> : <p>This Note has no outgoing links.</p>}</section></>
        : tab === "properties" ? <section><h3>Properties</h3><Link to={`/app/notes/${context.noteId}/history`}>Open Note history and revisions</Link></section>
          : tab === "projects" ? <section><h3>Project associations</h3>{context.projects.length ? <ul>{context.projects.map((project) => <li key={project.id}>
            <Link to={`/app/projects/${project.id}/boards`}>{project.name}</Link><span>{project.key}</span></li>)}</ul> : <p>No explicit or inherited Project association.</p>}</section>
            : tab === "sharing" ? <section><h3>Sharing</h3><p>Access follows containment and Project association.</p><Link to="/app/settings/members">Open Member access settings</Link></section>
              : <section><h3>Discussions</h3><Link to={`/app/notes/${context.noteId}/discussions`}>Open contextual Discussions</Link></section>}
    </div>
  </aside>;
}
