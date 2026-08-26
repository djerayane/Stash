import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useRef, useState, type DragEvent, type FormEvent, type KeyboardEvent } from "react";
import { useNavigate } from "react-router";

import styles from "./note-tree.module.css";

export interface NoteTreeNode {
  id: string;
  workspaceId: string;
  parentId?: string;
  title: string;
  position: string;
  childCount: number;
}

interface NoteTreeProps {
  workspaceId: string;
  token: string;
  activeNoteId?: string;
  fetcher?: typeof fetch;
  variant?: "sidebar" | "page";
}

async function request(fetcher: typeof fetch, token: string, path: string, init?: RequestInit) {
  const response = await fetcher(path, { ...init, headers: { authorization: `Bearer ${token}`, "content-type": "application/json", ...init?.headers } });
  const body = await response.json() as any;
  if (!response.ok) throw new Error(body.message || "The Note Tree could not be updated.");
  return body;
}

export function NoteTree({ workspaceId, token, activeNoteId, fetcher = globalThis.fetch, variant = "sidebar" }: NoteTreeProps) {
  const navigate = useNavigate();
  const client = useQueryClient();
  const [collapsed, setCollapsed] = useState(() => new Set<string>());
  const [rootTitle, setRootTitle] = useState("");
  const [childOf, setChildOf] = useState<string>();
  const [childTitle, setChildTitle] = useState("");
  const [siblingOf, setSiblingOf] = useState<string>();
  const [siblingTitle, setSiblingTitle] = useState("");
  const [status, setStatus] = useState("");
  const itemRefs = useRef(new Map<string, HTMLDivElement>());
  const queryKey = ["note-tree", workspaceId];
  const titleId = variant === "page" ? "note-tree-page-title" : "note-tree-sidebar-title";
  const tree = useQuery({ queryKey, retry: false, enabled: Boolean(workspaceId), queryFn: async () =>
    (await request(fetcher, token, `/api/workspaces/${encodeURIComponent(workspaceId)}/note-tree`)) as { nodes: NoteTreeNode[] } });
  const nodes = tree.data?.nodes ?? [];
  const byId = useMemo(() => new Map(nodes.map((node) => [node.id, node])), [nodes]);
  const visible = nodes.filter((node) => {
    let parentId = node.parentId;
    while (parentId) { if (collapsed.has(parentId)) return false; parentId = byId.get(parentId)?.parentId; }
    return true;
  });
  const create = useMutation({ mutationFn: (input: { title: string; parentId?: string }) => request(fetcher, token,
    `/api/workspaces/${encodeURIComponent(workspaceId)}/note-tree`, { method: "POST", body: JSON.stringify(input) }) as Promise<{ node: NoteTreeNode }>,
  onSuccess: async ({ node }) => { setRootTitle(""); setChildTitle(""); setChildOf(undefined); setSiblingTitle(""); setSiblingOf(undefined);
    await client.invalidateQueries({ queryKey }); navigate(`/app/notes/${encodeURIComponent(node.id)}`); } });
  const move = useMutation({ mutationFn: async ({ noteId, destination }: { noteId: string; destination: { parentId?: string; beforeId?: string } }) => {
    const preview = await request(fetcher, token, `/api/notes/${encodeURIComponent(noteId)}/branch-preview`, { method: "POST",
      body: JSON.stringify({ action: "move", ...destination }) }) as { impact: { projectAccessChanges: Array<{ effect: "gained" | "lost" }> } };
    const changes = preview.impact.projectAccessChanges;
    if (changes.length && !window.confirm(`Move this branch? Project access will change for ${changes.length} Notes.`)) return { cancelled: true as const };
    await request(fetcher, token, `/api/notes/${encodeURIComponent(noteId)}/move`, { method: "POST", body: JSON.stringify(destination) });
    return { cancelled: false as const };
  },
  onSuccess: async (value, variables) => { if (value.cancelled) { setStatus("Move cancelled."); return; } const title = byId.get(variables.noteId)?.title ?? "Note"; setStatus(`${title} moved.`);
    await client.invalidateQueries({ queryKey }); requestAnimationFrame(() => itemRefs.current.get(variables.noteId)?.focus()); } });

  const depth = (node: NoteTreeNode) => { let count = 0; let parentId = node.parentId; while (parentId) { count += 1; parentId = byId.get(parentId)?.parentId; } return count; };
  const siblingBefore = (node: NoteTreeNode) => {
    const siblings = nodes.filter(({ parentId }) => parentId === node.parentId);
    const index = siblings.findIndex(({ id }) => id === node.id);
    return index > 0 ? siblings[index - 1] : undefined;
  };
  const keyboard = (event: KeyboardEvent<HTMLDivElement>, node: NoteTreeNode) => {
    const index = visible.findIndex(({ id }) => id === node.id);
    if (event.key === "ArrowDown") { event.preventDefault(); itemRefs.current.get(visible[index + 1]?.id ?? node.id)?.focus(); }
    else if (event.key === "ArrowUp") { event.preventDefault(); itemRefs.current.get(visible[index - 1]?.id ?? node.id)?.focus(); }
    else if (event.key === "ArrowRight" && node.childCount) { event.preventDefault(); setCollapsed((current) => { const next = new Set(current); next.delete(node.id); return next; }); }
    else if (event.key === "ArrowLeft" && node.childCount && !collapsed.has(node.id)) { event.preventDefault(); setCollapsed((current) => new Set(current).add(node.id)); }
    else if (event.key === "Enter" || event.key === " ") { event.preventDefault(); navigate(`/app/notes/${encodeURIComponent(node.id)}`); }
  };
  const drop = (event: DragEvent<HTMLDivElement>, parentId: string) => { event.preventDefault(); const noteId = event.dataTransfer.getData("text/stash-note-id");
    if (noteId && noteId !== parentId) move.mutate({ noteId, destination: { parentId } }); };

  const TreeHeading = variant === "page" ? "h1" : "h2";
  return <section className={`${styles.treePanel} ${variant === "page" ? styles.treePage : ""}`} aria-label={variant === "page" ? "Note Tree workspace" : "Note Tree sidebar"}>
    <div className={styles.treeHeader}><div><p>Knowledge</p><TreeHeading id={titleId}>Note Tree</TreeHeading></div>
      <button aria-label="Create root Note" type="button" onClick={() => { setSiblingOf(undefined); setChildOf(childOf === "root" ? undefined : "root"); }}>+</button></div>
    {childOf === "root" ? <form className={styles.quickCreate} onSubmit={(event: FormEvent) => { event.preventDefault(); if (rootTitle.trim()) create.mutate({ title: rootTitle.trim() }); }}>
      <label>Root Note title<input autoFocus value={rootTitle} onChange={(event) => setRootTitle(event.target.value)} /></label>
      <button disabled={create.isPending} type="submit">Create root Note</button></form> : null}
    {tree.isPending ? <p className={styles.feedback}>Opening your Notes…</p> : tree.isError ? <p aria-live="polite" className={styles.feedback}>{tree.error.message}</p>
      : nodes.length ? <div className={styles.tree} role="tree" aria-label="Note Tree">{visible.map((node) => {
        const previous = siblingBefore(node); const isCollapsed = collapsed.has(node.id);
        return <div key={node.id} ref={(element) => { if (element) itemRefs.current.set(node.id, element); else itemRefs.current.delete(node.id); }}
          className={styles.treeItem} role="treeitem" aria-label={node.title} aria-level={depth(node) + 1}
          aria-current={activeNoteId === node.id ? "page" : undefined} aria-expanded={node.childCount ? !isCollapsed : undefined}
          tabIndex={activeNoteId === node.id || !activeNoteId && node === visible[0] ? 0 : -1} draggable
          style={{ "--note-depth": depth(node) } as React.CSSProperties}
          onClick={() => navigate(`/app/notes/${encodeURIComponent(node.id)}`)} onKeyDown={(event) => keyboard(event, node)}
          onDragStart={(event) => { event.dataTransfer.effectAllowed = "move"; event.dataTransfer.setData("text/stash-note-id", node.id); }}
          onDragOver={(event) => { event.preventDefault(); event.dataTransfer.dropEffect = "move"; }} onDrop={(event) => drop(event, node.id)}>
          <button className={styles.disclosure} aria-label={`${isCollapsed ? "Expand" : "Collapse"} ${node.title}`} disabled={!node.childCount}
            type="button" onClick={(event) => { event.stopPropagation(); setCollapsed((current) => { const next = new Set(current); isCollapsed ? next.delete(node.id) : next.add(node.id); return next; }); }}>{node.childCount ? (isCollapsed ? "+" : "−") : "·"}</button>
          <span className={styles.noteTitle}>{node.title}</span>
          <span className={styles.itemActions}>
            <button aria-label={`Add child to ${node.title}`} type="button" onClick={(event) => { event.stopPropagation(); setSiblingOf(undefined); setChildOf(node.id); setChildTitle(""); }}>+</button>
            <button aria-label={`Add sibling to ${node.title}`} type="button" onClick={(event) => { event.stopPropagation(); setChildOf(undefined); setSiblingOf(node.id); setSiblingTitle(""); }}>＋</button>
            {node.parentId ? <button aria-label={`Move ${node.title} to root`} type="button" onClick={(event) => { event.stopPropagation(); move.mutate({ noteId: node.id, destination: {} }); }}>↖</button> : null}
            {previous ? <button aria-label={`Move ${node.title} before ${previous.title}`} type="button" onClick={(event) => { event.stopPropagation(); move.mutate({ noteId: node.id, destination: { ...(node.parentId ? { parentId: node.parentId } : {}), beforeId: previous.id } }); }}>↑</button> : null}
          </span>
          {childOf === node.id ? <form className={styles.inlineCreate} onSubmit={(event) => { event.preventDefault(); event.stopPropagation(); if (childTitle.trim()) create.mutate({ title: childTitle.trim(), parentId: node.id }); }} onClick={(event) => event.stopPropagation()}>
            <label>Child Note title<input autoFocus value={childTitle} onChange={(event) => setChildTitle(event.target.value)} /></label>
            <button disabled={create.isPending} type="submit">Create child Note</button></form> : null}
          {siblingOf === node.id ? <form className={styles.inlineCreate} onSubmit={(event) => { event.preventDefault(); event.stopPropagation();
            if (siblingTitle.trim()) create.mutate({ title: siblingTitle.trim(), ...(node.parentId ? { parentId: node.parentId } : {}) }); }} onClick={(event) => event.stopPropagation()}>
            <label>Sibling Note title<input autoFocus value={siblingTitle} onChange={(event) => setSiblingTitle(event.target.value)} /></label>
            <button disabled={create.isPending} type="submit">Create sibling Note</button></form> : null}
        </div>;
      })}</div> : <p className={styles.feedback}>Create a root Note to begin shaping this Workspace.</p>}
    {status ? <p className={styles.srStatus} role="status">{status}</p> : null}
  </section>;
}
