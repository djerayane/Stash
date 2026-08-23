import { Collaboration } from "@tiptap/extension-collaboration";
import Image from "@tiptap/extension-image";
import Link from "@tiptap/extension-link";
import TaskItem from "@tiptap/extension-task-item";
import TaskList from "@tiptap/extension-task-list";
import { TableKit } from "@tiptap/extension-table";
import { Extension } from "@tiptap/core";
import { EditorContent, useEditor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import { useQuery } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import * as Y from "yjs";
import { toTiptap, type NoteDocument } from "./note-document";
import styles from "./note-editor.module.css";

interface Note { id: string; content: string; document: NoteDocument; revision: number }
interface Snapshot { sequence: number; update: string; updatedAt: string; updatedByMemberId: string }
interface NoteEditorProps { noteId: string; fetcher?: typeof fetch; token?: string }

const BlockIdentity = Extension.create({
  name: "blockIdentity",
  addGlobalAttributes() { return [{ types: ["paragraph", "heading", "blockquote", "codeBlock", "bulletList", "taskList"], attributes: {
    blockKey: { default: null, parseHTML: (element) => element.dataset.blockKey, renderHTML: (attributes) => attributes.blockKey ? { "data-block-key": attributes.blockKey } : {} },
    blockId: { default: null, parseHTML: (element) => element.dataset.blockId, renderHTML: (attributes) => attributes.blockId ? { "data-block-id": attributes.blockId } : {} },
  } }]; },
});

const decode = (value: string) => Uint8Array.from(atob(value), (character) => character.charCodeAt(0));
const encode = (value: Uint8Array) => btoa(String.fromCharCode(...value));

export function NoteEditor({ noteId, fetcher = globalThis.fetch, token = localStorage.getItem("stash.memberToken") ?? "" }: NoteEditorProps) {
  const [status, setStatus] = useState("Loading collaborative document");
  const [error, setError] = useState("");
  const persistedVector = useRef<Uint8Array>(new Uint8Array());
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
    Y.applyUpdate(ydoc, decode(collaboration.data.update));
    persistedVector.current = Y.encodeStateVector(ydoc);
    try {
      const pending = localStorage.getItem(`stash.pending-note-update:${noteId}`);
      if (pending) Y.applyUpdate(ydoc, decode(pending));
    } catch { /* Browser storage may be disabled; the live Y.Doc still retains this session's contribution. */ }
  }

  const editor = useEditor({ immediatelyRender: false, extensions: [
    StarterKit.configure({ undoRedo: false, link: false }), BlockIdentity, TaskList, TaskItem.configure({ nested: true }), Image, Link.configure({ openOnClick: false }),
    TableKit, Collaboration.configure({ document: ydoc }),
  ], content: undefined, editorProps: { attributes: { "aria-label": "Note content", role: "textbox", "aria-multiline": "true" } } }, [ydoc]);

  useEffect(() => {
    if (!editor || !note.data || !collaboration.data) return;
    if (ydoc.getXmlFragment("default").length === 0) editor.commands.setContent(toTiptap(note.data.document));
    setStatus("All changes saved"); setError("");
  }, [editor, note.data, collaboration.data, ydoc]);

  const synchronize = useCallback(async () => {
    const update = Y.encodeStateAsUpdate(ydoc, persistedVector.current);
    if (update.byteLength <= 2) return;
    const key = `stash.pending-note-update:${noteId}`;
    setStatus("Saving changes");
    try {
      localStorage.setItem(key, encode(update));
      const response = await fetcher(`/api/notes/${encodeURIComponent(noteId)}/collaboration`, { method: "POST",
        headers: { ...headers, "content-type": "application/json" }, body: JSON.stringify({ update: encode(update) }) });
      if (!response.ok) throw new Error("The Instance rejected this update.");
      const snapshot = await response.json() as Snapshot; Y.applyUpdate(ydoc, decode(snapshot.update));
      persistedVector.current = Y.encodeStateVector(ydoc); localStorage.removeItem(key); setStatus("All changes saved"); setError("");
    } catch (cause) { setStatus("Changes kept on this device"); setError(cause instanceof Error ? cause.message : "The update could not be saved."); }
  }, [fetcher, headers, noteId, ydoc]);

  useEffect(() => { if (!editor) return; let timer = 0; const changed = () => { clearTimeout(timer); timer = window.setTimeout(() => void synchronize(), 350); };
    ydoc.on("update", changed); return () => { clearTimeout(timer); ydoc.off("update", changed); }; }, [editor, synchronize, ydoc]);

  useEffect(() => {
    if (!collaboration.data) return;
    const refresh = window.setInterval(() => { void fetcher(`/api/notes/${encodeURIComponent(noteId)}/collaboration`, { headers })
      .then(async (response) => { if (!response.ok) return; const snapshot = await response.json() as Snapshot;
        Y.applyUpdate(ydoc, decode(snapshot.update)); persistedVector.current = Y.encodeStateVector(ydoc); })
      .catch(() => undefined); }, 2_000);
    return () => clearInterval(refresh);
  }, [collaboration.data, fetcher, headers, noteId, ydoc]);

  if (note.isError || collaboration.isError) return <div role="alert" className={styles.error}>The Note editor is unavailable. <button onClick={() => { void note.refetch(); void collaboration.refetch(); }}>Try again</button></div>;
  return <main className={styles.layout} aria-busy={!editor || !note.data || !collaboration.data}>
    <article className={styles.document}>
      <header className={styles.header}><p className={styles.kicker}>Collaborative Note</p><h1 className={styles.title}>{note.data?.content.split("\n")[0] || "Untitled Note"}</h1></header>
      <div className={styles.toolbar} role="toolbar" aria-label="Text formatting">
        <button type="button" aria-label="Bold" aria-pressed={editor?.isActive("bold") ?? false} onClick={() => editor?.chain().focus().toggleBold().run()}>B</button>
        <button type="button" aria-label="Italic" aria-pressed={editor?.isActive("italic") ?? false} onClick={() => editor?.chain().focus().toggleItalic().run()}>I</button>
        <button type="button" aria-label="Heading" aria-pressed={editor?.isActive("heading", { level: 2 }) ?? false} onClick={() => editor?.chain().focus().toggleHeading({ level: 2 }).run()}>H2</button>
        <button type="button" aria-label="Bullet list" aria-pressed={editor?.isActive("bulletList") ?? false} onClick={() => editor?.chain().focus().toggleBulletList().run()}>List</button>
        <button type="button" aria-label="Checklist" aria-pressed={editor?.isActive("taskList") ?? false} onClick={() => editor?.chain().focus().toggleTaskList().run()}>Check</button>
        <button type="button" aria-label="Code block" aria-pressed={editor?.isActive("codeBlock") ?? false} onClick={() => editor?.chain().focus().toggleCodeBlock().run()}>Code</button>
        <button type="button" aria-label="Quote" aria-pressed={editor?.isActive("blockquote") ?? false} onClick={() => editor?.chain().focus().toggleBlockquote().run()}>Quote</button>
        <button type="button" aria-label="Insert table" onClick={() => editor?.chain().focus().insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run()}>Table</button>
        <button type="button" aria-label="Insert image" onClick={() => { const src = window.prompt("Image URL"); if (src) editor?.chain().focus().setImage({ src }).run(); }}>Image</button>
        <button type="button" aria-label="Undo" onClick={() => editor?.chain().focus().undo().run()}>Undo</button>
        <button type="button" aria-label="Redo" onClick={() => editor?.chain().focus().redo().run()}>Redo</button>
      </div>
      <div className={styles.editor}><EditorContent editor={editor} /></div>
    </article>
    <aside className={styles.aside} aria-label="Collaboration status"><h2>Collaboration</h2><p className={styles.status} role="status">{status}</p>
      {error ? <><p className={styles.error} role="alert">{error}</p><button className={styles.retry} type="button" onClick={() => void synchronize()}>Retry saving</button></> : null}
      <p>Changes merge with contributions from other Members. Offline work remains on this device until the Instance accepts it.</p>
    </aside>
  </main>;
}
