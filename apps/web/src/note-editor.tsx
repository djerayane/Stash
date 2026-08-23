import { Collaboration } from "@tiptap/extension-collaboration";
import Image from "@tiptap/extension-image";
import Link from "@tiptap/extension-link";
import TaskItem from "@tiptap/extension-task-item";
import TaskList from "@tiptap/extension-task-list";
import { TableKit } from "@tiptap/extension-table";
import { Extension, Node, mergeAttributes } from "@tiptap/core";
import { EditorContent, useEditor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import { useQuery } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useGSAP } from "@gsap/react";
import gsap from "gsap";
import * as Y from "yjs";
import { toTiptap, type NoteDocument } from "./note-document";
import styles from "./note-editor.module.css";

gsap.registerPlugin(useGSAP);

interface Note { id: string; content: string; document: NoteDocument; revision: number }
interface Snapshot { sequence: number; update: string; updatedAt: string; updatedByMemberId: string }
interface NoteEditorProps { noteId: string; fetcher?: typeof fetch; token?: string }

const BlockIdentity = Extension.create({
  name: "blockIdentity",
  addGlobalAttributes() { return [{ types: ["paragraph", "heading", "blockquote", "codeBlock", "bulletList", "taskList", "callout", "workspaceAttachment", "image", "table"], attributes: {
    blockKey: { default: null, parseHTML: (element) => element.dataset.blockKey, renderHTML: (attributes) => attributes.blockKey ? { "data-block-key": attributes.blockKey } : {} },
    blockId: { default: null, parseHTML: (element) => element.dataset.blockId, renderHTML: (attributes) => attributes.blockId ? { "data-block-id": attributes.blockId } : {} },
  } }]; },
});

const Callout = Node.create({
  name: "callout", group: "block", content: "block+", defining: true,
  addAttributes: () => ({ kind: { default: "note" } }),
  parseHTML: () => [{ tag: "aside[data-callout]" }],
  renderHTML: ({ HTMLAttributes }) => ["aside", mergeAttributes(HTMLAttributes, { "data-callout": HTMLAttributes.kind, role: "note" }), 0],
});

const WorkspaceAttachment = Node.create({
  name: "workspaceAttachment", group: "block", atom: true,
  addAttributes: () => ({ href: { default: null }, label: { default: "Attachment" } }),
  parseHTML: () => [{ tag: "a[data-workspace-attachment]" }],
  renderHTML: ({ HTMLAttributes }) => ["a", mergeAttributes(HTMLAttributes, { "data-workspace-attachment": "", href: HTMLAttributes.href }), HTMLAttributes.label],
});

const decode = (value: string) => Uint8Array.from(atob(value), (character) => character.charCodeAt(0));
export function encodeUpdateBase64(value: Uint8Array): string {
  const chunks: string[] = [];
  for (let offset = 0; offset < value.length; offset += 0x8000)
    chunks.push(String.fromCharCode(...value.subarray(offset, offset + 0x8000)));
  return btoa(chunks.join(""));
}

function readPendingUpdate(key: string): string | null {
  try { return localStorage.getItem(key); } catch { return null; }
}

function storePendingUpdate(key: string, update: string): boolean {
  try { localStorage.setItem(key, update); return true; } catch { return false; }
}

function removePendingUpdate(key: string): void {
  try { localStorage.removeItem(key); } catch { /* A successful server acknowledgement remains authoritative. */ }
}

export function applyAcknowledgedUpdate(localDocument: Y.Doc, update: Uint8Array): Uint8Array {
  const acknowledgedDocument = new Y.Doc();
  Y.applyUpdate(acknowledgedDocument, update);
  const acknowledgedVector = Y.encodeStateVector(acknowledgedDocument);
  Y.applyUpdate(localDocument, update);
  acknowledgedDocument.destroy();
  return acknowledgedVector;
}

export function NoteEditor({ noteId, fetcher = globalThis.fetch, token = localStorage.getItem("stash.memberToken") ?? "" }: NoteEditorProps) {
  const [status, setStatus] = useState("Loading collaborative document");
  const [error, setError] = useState("");
  const [, refreshToolbar] = useState(0);
  const persistedVector = useRef<Uint8Array>(new Uint8Array());
  const restoredPendingUpdate = useRef(false);
  const layoutRef = useRef<HTMLElement>(null);
  const toolbarRef = useRef<HTMLDivElement>(null);
  const asideRef = useRef<HTMLElement>(null);
  const statusRef = useRef<HTMLParagraphElement>(null);
  const unavailableRef = useRef<HTMLDivElement>(null);
  const headers = useMemo(() => ({ authorization: `Bearer ${token}` }), [token]);
  const ydoc = useMemo(() => new Y.Doc(), [noteId]);
  const note = useQuery({ queryKey: ["note", noteId], queryFn: async () => {
    const response = await fetcher(`/api/notes/${encodeURIComponent(noteId)}`, { headers });
    if (!response.ok) throw new Error("The Note could not be loaded."); return response.json() as Promise<Note>;
  }});
  const collaboration = useQuery({ queryKey: ["note-collaboration", noteId], queryFn: async () => {
    const response = await fetcher(`/api/notes/${encodeURIComponent(noteId)}/collaboration`, { headers });
    if (!response.ok) throw new Error("Collaboration could not be started."); return response.json() as Promise<Snapshot>;
  }});

  if (collaboration.data && persistedVector.current.byteLength === 0) {
    persistedVector.current = applyAcknowledgedUpdate(ydoc, decode(collaboration.data.update));
    try {
      const pending = readPendingUpdate(`stash.pending-note-update:${noteId}`);
      if (pending) { Y.applyUpdate(ydoc, decode(pending)); restoredPendingUpdate.current = true; }
    } catch { /* Browser storage may be disabled; the live Y.Doc still retains this session's contribution. */ }
  }

  const editor = useEditor({ immediatelyRender: false, onSelectionUpdate: () => refreshToolbar((revision) => revision + 1),
    onTransaction: () => refreshToolbar((revision) => revision + 1), extensions: [
    StarterKit.configure({ undoRedo: false, link: false }), BlockIdentity, TaskList, TaskItem.configure({ nested: true }), Image, Link.configure({ openOnClick: false }),
    TableKit, Callout, WorkspaceAttachment, Collaboration.configure({ document: ydoc }),
  ], content: undefined, editorProps: { attributes: { "aria-label": "Note content", role: "textbox", "aria-multiline": "true" } } }, [ydoc]);

  useGSAP(() => {
    if (!toolbarRef.current || !asideRef.current || window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) return;
    gsap.fromTo(toolbarRef.current, { y: -10, opacity: 0 }, { y: 0, opacity: 1, duration: .34, ease: "power2.out" });
    gsap.fromTo(asideRef.current, { x: 14, opacity: 0 }, { x: 0, opacity: 1, duration: .42, ease: "power2.out" });
  }, { scope: layoutRef });

  useGSAP(() => {
    if (!statusRef.current || window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) return;
    gsap.fromTo(statusRef.current, { opacity: .35, y: 3 }, { opacity: 1, y: 0, duration: .24, ease: "power1.out" });
  }, { scope: layoutRef, dependencies: [status], revertOnUpdate: true });

  useEffect(() => {
    if (!editor || !note.data || !collaboration.data) return;
    if (ydoc.getXmlFragment("default").length === 0) editor.commands.setContent(toTiptap(note.data.document));
    setStatus(restoredPendingUpdate.current ? "Restoring changes from this device" : "All changes saved"); setError("");
  }, [editor, note.data, collaboration.data, ydoc]);

  const synchronize = useCallback(async () => {
    const update = Y.encodeStateAsUpdate(ydoc, persistedVector.current);
    if (update.byteLength <= 2) return;
    const key = `stash.pending-note-update:${noteId}`;
    setStatus("Saving changes");
    const encodedUpdate = encodeUpdateBase64(update);
    const storedOnDevice = storePendingUpdate(key, encodedUpdate);
    try {
      const response = await fetcher(`/api/notes/${encodeURIComponent(noteId)}/collaboration`, { method: "POST",
        headers: { ...headers, "content-type": "application/json" }, body: JSON.stringify({ update: encodedUpdate }) });
      if (!response.ok) throw new Error("The Instance rejected this update.");
      const snapshot = await response.json() as Snapshot;
      persistedVector.current = applyAcknowledgedUpdate(ydoc, decode(snapshot.update));
      removePendingUpdate(key); setStatus("All changes saved"); setError("");
    } catch (cause) { setStatus(storedOnDevice ? "Changes kept on this device" : "Changes remain only in this open tab");
      setError(cause instanceof Error ? cause.message : "The update could not be saved."); }
  }, [fetcher, headers, noteId, ydoc]);

  useEffect(() => { if (!editor) return; let timer = 0; const changed = () => { clearTimeout(timer); timer = window.setTimeout(() => void synchronize(), 350); };
    ydoc.on("update", changed); return () => { clearTimeout(timer); ydoc.off("update", changed); }; }, [editor, synchronize, ydoc]);

  useEffect(() => {
    if (!editor || !collaboration.data || !restoredPendingUpdate.current) return;
    restoredPendingUpdate.current = false;
    void synchronize();
  }, [collaboration.data, editor, synchronize]);

  useEffect(() => {
    if (!collaboration.data) return;
    const refresh = window.setInterval(() => { void fetcher(`/api/notes/${encodeURIComponent(noteId)}/collaboration`, { headers })
      .then(async (response) => { if (!response.ok) return; const snapshot = await response.json() as Snapshot;
        persistedVector.current = applyAcknowledgedUpdate(ydoc, decode(snapshot.update));
        if (readPendingUpdate(`stash.pending-note-update:${noteId}`)) void synchronize(); })
      .catch(() => undefined); }, 2_000);
    return () => clearInterval(refresh);
  }, [collaboration.data, fetcher, headers, noteId, synchronize, ydoc]);

  const isUnavailable = note.isError || collaboration.isError;
  useEffect(() => {
    if (isUnavailable) unavailableRef.current?.focus();
  }, [isUnavailable]);

  if (isUnavailable) return <main id="workspace-content" className={styles.errorState}>
    <div ref={unavailableRef} role="alert" tabIndex={-1} className={styles.errorPanel}>
      <h1>The Note editor is unavailable.</h1>
      <p>Check the Instance connection, then try loading the collaborative document again.</p>
      <button className={styles.retry} type="button" onClick={() => { void note.refetch(); void collaboration.refetch(); }}>Try again</button>
    </div>
  </main>;
  return <main id="workspace-content" ref={layoutRef} className={styles.layout} aria-busy={!editor || !note.data || !collaboration.data}>
    <article className={styles.document}>
      <header className={styles.header}><p className={styles.kicker}>Collaborative Note</p><h1 className={styles.title}>{note.data?.content.split("\n")[0] || "Untitled Note"}</h1></header>
      <div ref={toolbarRef} className={styles.toolbar} role="toolbar" aria-label="Text formatting">
        <button type="button" aria-label="Bold" aria-pressed={editor?.isActive("bold") ?? false} onClick={() => editor?.chain().focus().toggleBold().run()}>B</button>
        <button type="button" aria-label="Italic" aria-pressed={editor?.isActive("italic") ?? false} onClick={() => editor?.chain().focus().toggleItalic().run()}>I</button>
        <button type="button" aria-label="Heading" aria-pressed={editor?.isActive("heading", { level: 2 }) ?? false} onClick={() => editor?.chain().focus().toggleHeading({ level: 2 }).run()}>H2</button>
        <button type="button" aria-label="Bullet list" aria-pressed={editor?.isActive("bulletList") ?? false} onClick={() => editor?.chain().focus().toggleBulletList().run()}>List</button>
        <button type="button" aria-label="Checklist" aria-pressed={editor?.isActive("taskList") ?? false} onClick={() => editor?.chain().focus().toggleTaskList().run()}>Check</button>
        <button type="button" aria-label="Code block" aria-pressed={editor?.isActive("codeBlock") ?? false} onClick={() => editor?.chain().focus().toggleCodeBlock().run()}>Code</button>
        <button type="button" aria-label="Quote" aria-pressed={editor?.isActive("blockquote") ?? false} onClick={() => editor?.chain().focus().toggleBlockquote().run()}>Quote</button>
        <button type="button" aria-label="Insert table" onClick={() => editor?.chain().focus().insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run()}>Table</button>
        <button type="button" aria-label="Insert image" onClick={() => { const src = window.prompt("Image URL"); if (src) editor?.chain().focus().setImage({ src }).run(); }}>Image</button>
        <button type="button" aria-label="Insert link" aria-pressed={editor?.isActive("link") ?? false} onClick={() => { const href = window.prompt("Link URL"); if (href) editor?.chain().focus().extendMarkRange("link").setLink({ href }).run(); }}>Link</button>
        <button type="button" aria-label="Insert callout" onClick={() => editor?.chain().focus().insertContent({ type: "callout", attrs: { blockKey: crypto.randomUUID(), blockId: null, kind: "note" }, content: [{ type: "paragraph", content: [{ type: "text", text: "Callout" }] }] }).run()}>Callout</button>
        <button type="button" aria-label="Insert Workspace Attachment" onClick={() => { const href = window.prompt("Workspace Attachment path"); if (!href?.startsWith("./attachments/")) return; const label = window.prompt("Attachment label")?.trim() || "Attachment"; editor?.chain().focus().insertContent({ type: "workspaceAttachment", attrs: { blockKey: crypto.randomUUID(), blockId: null, href, label } }).run(); }}>Attachment</button>
        <button type="button" aria-label="Undo" onClick={() => editor?.chain().focus().undo().run()}>Undo</button>
        <button type="button" aria-label="Redo" onClick={() => editor?.chain().focus().redo().run()}>Redo</button>
      </div>
      <div className={styles.editor}><EditorContent editor={editor} /></div>
    </article>
    <aside ref={asideRef} className={styles.aside} aria-label="Collaboration status"><h2>Collaboration</h2><p ref={statusRef} className={styles.status} role="status">{status}</p>
      {error ? <><p className={styles.error} role="alert">{error}</p><button className={styles.retry} type="button" onClick={() => void synchronize()}>Retry saving</button></> : null}
      <p>Changes merge with contributions from other Members. Offline work remains on this device until the Instance accepts it.</p>
    </aside>
  </main>;
}
