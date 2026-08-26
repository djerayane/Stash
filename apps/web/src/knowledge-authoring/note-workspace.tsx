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
    {drawerOpen && context.data ? <ContextDrawer context={context.data} fetcher={fetcher} onClose={close} token={token} /> : null}
  </div>;
}
