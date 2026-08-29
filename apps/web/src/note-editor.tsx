import { Collaboration } from "@tiptap/extension-collaboration";
import Image from "@tiptap/extension-image";
import TiptapLink from "@tiptap/extension-link";
import TaskItem from "@tiptap/extension-task-item";
import TaskList from "@tiptap/extension-task-list";
import { TableKit } from "@tiptap/extension-table";
import { Extension, Node, mergeAttributes } from "@tiptap/core";
import { EditorContent, useEditor } from "@tiptap/react";
import { Plugin } from "@tiptap/pm/state";
import StarterKit from "@tiptap/starter-kit";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import * as Tabs from "@radix-ui/react-tabs";
import { Link } from "react-router";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useGSAP } from "@gsap/react";
import gsap from "gsap";
import * as Y from "yjs";
import { markdownToRichText } from "@stash/rich-text";
import { markdownFromTiptap, toTiptap, type NoteDocument } from "./note-document";
import styles from "./note-editor.module.css";
import { Button, Field, IconButton } from "./ui/control";

gsap.registerPlugin(useGSAP);

interface Note { id: string; content: string; document: NoteDocument; revision: number }
interface Snapshot { sequence: number; update: string; updatedAt: string; updatedByMemberId: string; access: "edit" | "read" }
interface NoteEditorProps { noteId: string; memberId: string; fetcher?: typeof fetch; token?: string; contextVisible?: boolean }

const blockIdentity = (document: Y.Doc) => Extension.create({
  name: "blockIdentity",
  addGlobalAttributes() { return [{ types: ["paragraph", "heading", "blockquote", "codeBlock", "bulletList", "listItem", "taskList", "taskItem", "callout", "workspaceAttachment", "image", "table"], attributes: {
    blockKey: { default: null, parseHTML: (element) => element.dataset.blockKey, renderHTML: (attributes) => attributes.blockKey ? { "data-block-key": attributes.blockKey } : {} },
    blockId: { default: null, parseHTML: (element) => element.dataset.blockId, renderHTML: (attributes) => attributes.blockId ? { "data-block-id": attributes.blockId } : {} },
  } }]; },
  addProseMirrorPlugins() { return [new Plugin({ appendTransaction: (transactions, _previous, current) => {
    if (!transactions.some((transaction) => transaction.docChanged) || document.getXmlFragment("default").length === 0) return null;
    const transaction = current.tr; const seen = new Set<string>(); let changed = false;
    current.doc.descendants((node, position) => {
      if (!("blockKey" in node.attrs)) return;
      const blockKey = typeof node.attrs.blockKey === "string" ? node.attrs.blockKey : "";
      if (blockKey && !seen.has(blockKey)) { seen.add(blockKey); return; }
      const replacement = crypto.randomUUID(); seen.add(replacement);
      transaction.setNodeMarkup(position, undefined, { ...node.attrs, blockKey: replacement }); changed = true;
    });
    return changed ? transaction : null;
  } })]; },
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

interface MarkdownDraft { base: string; draft: string }
function readMarkdownDraft(key: string): MarkdownDraft | null {
  try {
    const value = JSON.parse(localStorage.getItem(key) ?? "null") as unknown;
    return value && typeof value === "object" && typeof (value as MarkdownDraft).base === "string" && typeof (value as MarkdownDraft).draft === "string"
      ? value as MarkdownDraft : null;
  } catch { return null; }
}

function storeMarkdownDraft(key: string, value: MarkdownDraft): boolean {
  try { localStorage.setItem(key, JSON.stringify(value)); return true; } catch { return false; }
}

export function applyAcknowledgedUpdate(localDocument: Y.Doc, update: Uint8Array): Uint8Array {
  const acknowledgedDocument = new Y.Doc();
  Y.applyUpdate(acknowledgedDocument, update);
  const acknowledgedVector = Y.encodeStateVector(acknowledgedDocument);
  Y.applyUpdate(localDocument, update);
  acknowledgedDocument.destroy();
  return acknowledgedVector;
}

export function createSerializedSynchronization(run: () => Promise<void>): () => Promise<void> {
  let queue = Promise.resolve();
  return () => {
    const synchronization = queue.then(run, run);
    queue = synchronization.catch(() => undefined);
    return synchronization;
  };
}

export function NoteEditor(props: NoteEditorProps) {
  return <NoteEditorDocument key={`${props.memberId}:${props.noteId}`} {...props} />;
}

function NoteEditorDocument({ noteId, memberId, fetcher = globalThis.fetch, token = localStorage.getItem("stash.memberToken") ?? "", contextVisible = true }: NoteEditorProps) {
  const [status, setStatus] = useState("Loading collaborative document");
  const [error, setError] = useState("");
  const [editorMode, setEditorMode] = useState<"rich" | "markdown">("rich");
  const [markdownDraft, setMarkdownDraft] = useState("");
  const [markdownError, setMarkdownError] = useState("");
  const [markdownDraftStored, setMarkdownDraftStored] = useState(true);
  const [readyDocumentIdentity, setReadyDocumentIdentity] = useState("");
  const documentIdentity = `${memberId}:${noteId}`;
  const documentReady = readyDocumentIdentity === documentIdentity;
  const [taskTitle, setTaskTitle] = useState(""); const [taskProjectId, setTaskProjectId] = useState(""); const [taskComposerOpen, setTaskComposerOpen] = useState(false);
  const queryClient = useQueryClient();
  const [, refreshToolbar] = useState(0);
  const persistedVector = useRef<Uint8Array>(new Uint8Array());
  const restoredPendingUpdate = useRef(false);
  const shouldSeedCanonicalDocument = useRef(false);
  const layoutRef = useRef<HTMLElement>(null);
  const statusRef = useRef<HTMLParagraphElement>(null);
  const unavailableRef = useRef<HTMLDivElement>(null);
  const markdownPanelRef = useRef<HTMLDivElement>(null);
  const markdownBase = useRef("");
  const headers = useMemo(() => ({ authorization: `Bearer ${token}` }), [token]);
  const pendingUpdateKey = `stash.pending-note-update:${memberId}:${noteId}`;
  const markdownDraftKey = `stash.markdown-draft:${memberId}:${noteId}`;
  const ydoc = useMemo(() => new Y.Doc(), [memberId, noteId]);
  const note = useQuery({ queryKey: ["note", memberId, noteId], queryFn: async () => {
    const response = await fetcher(`/api/notes/${encodeURIComponent(noteId)}`, { headers });
    if (!response.ok) throw new Error("The Note could not be loaded."); return response.json() as Promise<Note>;
  }});
  const collaboration = useQuery({ queryKey: ["note-collaboration", memberId, noteId], queryFn: async () => {
    const response = await fetcher(`/api/notes/${encodeURIComponent(noteId)}/collaboration`, { headers });
    if (!response.ok) throw new Error("Collaboration could not be started."); return response.json() as Promise<Snapshot>;
  }});
  const linkedTasks = useQuery({ queryKey: ["note-linked-tasks", noteId], retry: false, queryFn: async () => { const response = await fetcher(`/api/notes/${encodeURIComponent(noteId)}/linked-tasks`, { headers }); if (!response.ok) throw new Error("Linked Tasks could not be loaded."); return response.json() as Promise<{ tasks: Array<{ id: string; key: string; title: string; projectId: string; status: { name: string }; relationshipState: string }> }>; } });
  const workspaces = useQuery({ queryKey: ["workspace-discovery"], retry: false, queryFn: async () => { const response = await fetcher("/api/workspaces", { headers }); if (!response.ok) throw new Error("Projects could not be loaded."); return response.json() as Promise<{ workspaces: Array<{ projects: Array<{ id: string; name: string; key: string }> }> }>; } });

  if (collaboration.data && persistedVector.current.byteLength === 0) {
    persistedVector.current = applyAcknowledgedUpdate(ydoc, decode(collaboration.data.update));
    shouldSeedCanonicalDocument.current = ydoc.getXmlFragment("default").length === 0;
    try {
      const pending = readPendingUpdate(pendingUpdateKey);
      if (pending && collaboration.data.access === "edit") { Y.applyUpdate(ydoc, decode(pending)); restoredPendingUpdate.current = true; }
    } catch { /* Browser storage may be disabled; the live Y.Doc still retains this session's contribution. */ }
  }

  const editor = useEditor({ immediatelyRender: false, onSelectionUpdate: () => refreshToolbar((revision) => revision + 1),
    onTransaction: () => refreshToolbar((revision) => revision + 1), extensions: [
    StarterKit.configure({ undoRedo: false, link: false }), blockIdentity(ydoc), TaskList, TaskItem.configure({ nested: true }), Image, TiptapLink.configure({ openOnClick: false }),
    TableKit, Callout, WorkspaceAttachment, Collaboration.configure({ document: ydoc }),
  ], content: undefined, editorProps: { attributes: { "aria-label": "Note content", role: "textbox", "aria-multiline": "true" } } }, [ydoc]);
  const canEdit = collaboration.data?.access === "edit";
  const canEditRef = useRef(false);
  canEditRef.current = canEdit;
  const selectedBlockKey = () => { if (!editor) return ""; for (let depth = editor.state.selection.$from.depth; depth >= 0; depth -= 1) { const value = editor.state.selection.$from.node(depth).attrs.blockKey; if (typeof value === "string" && value) return value; } return ""; };
  const createTask = useMutation({ mutationFn: async () => { const blockKey = selectedBlockKey(); if (!blockKey) throw new Error("Place the cursor in the Block that should source this Task."); const response = await fetcher(`/api/notes/${encodeURIComponent(noteId)}/blocks/${encodeURIComponent(blockKey)}/tasks`, { method: "POST", headers: { ...headers, "content-type": "application/json" }, body: JSON.stringify({ projectId: taskProjectId, title: taskTitle }) }); const body = await response.json().catch(() => ({})) as { message?: string }; if (!response.ok) throw new Error(body.message || "The Task could not be created."); return body; }, onSuccess: async () => { setTaskComposerOpen(false); setTaskTitle(""); await queryClient.invalidateQueries({ queryKey: ["note-linked-tasks", noteId] }); } });

  useGSAP(() => {
    if (editorMode !== "markdown" || !markdownPanelRef.current || window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) return;
    gsap.fromTo(markdownPanelRef.current, { opacity: 0, y: 8 }, { opacity: 1, y: 0, duration: .28, ease: "power2.out", clearProps: "all" });
  }, { scope: layoutRef, dependencies: [editorMode], revertOnUpdate: true });

  useEffect(() => {
    if (!editor || !note.data || !collaboration.data) return;
    if (shouldSeedCanonicalDocument.current) { shouldSeedCanonicalDocument.current = false; editor.commands.setContent(toTiptap(note.data.document)); }
    editor.setEditable(canEdit);
    editor.view.dom.setAttribute("aria-readonly", String(!canEdit));
    setReadyDocumentIdentity(documentIdentity);
    setStatus(canEdit ? restoredPendingUpdate.current ? "Restoring changes from this device" : "All changes saved" : "Read-only Note"); setError("");
  }, [canEdit, collaboration.data, documentIdentity, editor, note.data, ydoc]);

  const performSynchronization = useCallback(async () => {
    if (!canEditRef.current) return;
    const update = Y.encodeStateAsUpdate(ydoc, persistedVector.current);
    if (update.byteLength <= 2) return;
    const key = pendingUpdateKey;
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
  }, [fetcher, headers, noteId, pendingUpdateKey, ydoc]);

  const synchronize = useMemo(() => createSerializedSynchronization(performSynchronization), [performSynchronization]);

  useEffect(() => { if (!editor) return; let timer = 0; const changed = () => { clearTimeout(timer); timer = window.setTimeout(() => void synchronize(), 350); };
    ydoc.on("update", changed); return () => { clearTimeout(timer); ydoc.off("update", changed); }; }, [editor, synchronize, ydoc]);

  useEffect(() => {
    if (!editor || !canEdit || !collaboration.data || !restoredPendingUpdate.current) return;
    restoredPendingUpdate.current = false;
    void synchronize();
  }, [canEdit, collaboration.data, editor, synchronize]);

  useEffect(() => {
    if (!collaboration.data) return;
    const refresh = window.setInterval(() => { void fetcher(`/api/notes/${encodeURIComponent(noteId)}/collaboration`, { headers })
      .then(async (response) => { if (!response.ok) return; const snapshot = await response.json() as Snapshot;
        persistedVector.current = applyAcknowledgedUpdate(ydoc, decode(snapshot.update));
        if (canEdit && readPendingUpdate(pendingUpdateKey)) void synchronize(); })
      .catch(() => undefined); }, 2_000);
    return () => clearInterval(refresh);
  }, [canEdit, collaboration.data, fetcher, headers, noteId, pendingUpdateKey, synchronize, ydoc]);

  const isUnavailable = note.isError || collaboration.isError;
  useEffect(() => {
    if (isUnavailable) unavailableRef.current?.focus();
  }, [isUnavailable]);

  const markdownDirty = Boolean(canEdit && editorMode === "markdown" && markdownDraft !== markdownBase.current);
  const visibleStatus = markdownDirty
    ? markdownDraftStored ? "Markdown draft kept on this device — not applied" : "Markdown draft remains only in this open tab — not applied"
    : status;
  useEffect(() => {
    if (!markdownDirty) return;
    const warn = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ""; };
    const guardLink = (event: MouseEvent) => {
      const link = event.target instanceof Element ? event.target.closest("a[href]") : null;
      if (link && !window.confirm("Your Markdown draft is not applied. Leave this Note and keep the draft on this device?")) event.preventDefault();
    };
    window.addEventListener("beforeunload", warn);
    document.addEventListener("click", guardLink, true);
    return () => { window.removeEventListener("beforeunload", warn); document.removeEventListener("click", guardLink, true); };
  }, [markdownDirty]);

  const changeEditorMode = (nextMode: string) => {
    if (!editor) return;
    if (nextMode === "markdown") {
      const source = markdownFromTiptap(editor.getJSON());
      const recovered = canEdit ? readMarkdownDraft(markdownDraftKey) : null;
      if (recovered) {
        markdownBase.current = recovered.base;
        setMarkdownDraft(recovered.draft);
        setMarkdownDraftStored(true);
        setMarkdownError("");
        setEditorMode("markdown");
        return;
      }
      markdownBase.current = source;
      setMarkdownDraft(source);
      setMarkdownDraftStored(true);
      setMarkdownError("");
      setEditorMode("markdown");
      return;
    }
    if (editorMode !== "markdown") return;
    if (!canEdit || markdownDraft === markdownBase.current) {
      setMarkdownError("");
      setEditorMode("rich");
      return;
    }
    const currentSource = markdownFromTiptap(editor.getJSON());
    if (currentSource !== markdownBase.current) {
      setMarkdownError("This Note changed while Markdown source was open. Copy your draft, reopen Markdown source, and apply it again.");
      return;
    }
    try {
      const parsed = markdownToRichText(markdownDraft);
      editor.commands.setContent(toTiptap(parsed));
      removePendingUpdate(markdownDraftKey);
      setMarkdownError("");
      setEditorMode("rich");
      setStatus("Saving Markdown changes");
    } catch {
      setMarkdownError("This Markdown contains a construct Stash cannot round-trip. Repair the source before returning to rich text.");
    }
  };

  if (isUnavailable) return <main id="workspace-content" className={styles.errorState}>
    <div ref={unavailableRef} role="alert" tabIndex={-1} className={styles.errorPanel}>
      <h1>The Note editor is unavailable.</h1>
      <p>Check the Instance connection, then try loading the collaborative document again.</p>
      <Button className={styles.retry} type="button" variant="secondary" onClick={() => { void note.refetch(); void collaboration.refetch(); }}>Try again</Button>
    </div>
  </main>;
  const taskComposer = taskComposerOpen ? <form onSubmit={(event) => { event.preventDefault(); createTask.mutate(); }}>
    <Field label="Project"><select required value={taskProjectId} onChange={(event) => setTaskProjectId(event.target.value)}><option value="">Choose a Project</option>{workspaces.data?.workspaces.flatMap((workspace) => workspace.projects).map((project) => <option key={project.id} value={project.id}>{project.name} · {project.key}</option>)}</select></Field>
    <Field label="Task title"><input required value={taskTitle} onChange={(event) => setTaskTitle(event.target.value)} /></Field>
    <Button pending={createTask.isPending} pendingLabel="Creating linked Task" type="submit">Create linked Task</Button><Button type="button" variant="secondary" onClick={() => setTaskComposerOpen(false)}>Cancel</Button>
    {createTask.isError ? <p role="alert">{createTask.error.message}</p> : null}</form> : null;
  return <main id="workspace-content" ref={layoutRef} className={`${styles.layout} ${contextVisible || taskComposerOpen ? "" : styles.contextHidden}`} aria-busy={!editor || !note.data || !collaboration.data}>
    <article className={styles.document}>
      <header className={styles.header}><h1 className={styles.title}>{note.data?.content.split("\n")[0] || "Untitled Note"}</h1></header>
      <Tabs.Root className={styles.mode} value={editorMode} activationMode="manual">
        <Tabs.List className={styles.modeList} aria-label="Note editing mode">
          <Tabs.Trigger className={styles.modeTrigger} disabled={!documentReady} value="rich" onClick={() => changeEditorMode("rich")}>Rich text</Tabs.Trigger>
          <Tabs.Trigger className={styles.modeTrigger} disabled={!documentReady} value="markdown" onClick={() => changeEditorMode("markdown")}>Markdown source</Tabs.Trigger>
        </Tabs.List>
      <Tabs.Content value="rich"><div className={styles.toolbar} role="toolbar" aria-label="Text formatting" tabIndex={canEdit ? undefined : 0}>
        <IconButton disabled={!canEdit} label="Bold" aria-pressed={editor?.isActive("bold") ?? false} onClick={() => editor?.chain().focus().toggleBold().run()}>B</IconButton>
        <IconButton disabled={!canEdit} label="Italic" aria-pressed={editor?.isActive("italic") ?? false} onClick={() => editor?.chain().focus().toggleItalic().run()}>I</IconButton>
        <IconButton disabled={!canEdit} label="Heading" aria-pressed={editor?.isActive("heading", { level: 2 }) ?? false} onClick={() => editor?.chain().focus().toggleHeading({ level: 2 }).run()}>H2</IconButton>
        <IconButton disabled={!canEdit} label="Bullet list" aria-pressed={editor?.isActive("bulletList") ?? false} onClick={() => editor?.chain().focus().toggleBulletList().run()}>List</IconButton>
        <IconButton disabled={!canEdit} label="Checklist" aria-pressed={editor?.isActive("taskList") ?? false} onClick={() => editor?.chain().focus().toggleTaskList().run()}>Check</IconButton>
        <IconButton disabled={!canEdit} label="Code block" aria-pressed={editor?.isActive("codeBlock") ?? false} onClick={() => editor?.chain().focus().toggleCodeBlock().run()}>Code</IconButton>
        <IconButton disabled={!canEdit} label="Quote" aria-pressed={editor?.isActive("blockquote") ?? false} onClick={() => editor?.chain().focus().toggleBlockquote().run()}>Quote</IconButton>
        <IconButton disabled={!canEdit} label="Insert table" onClick={() => editor?.chain().focus().insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run()}>Table</IconButton>
        <IconButton disabled={!canEdit} label="Insert image" onClick={() => { const src = window.prompt("Image URL"); if (src) editor?.chain().focus().setImage({ src }).run(); }}>Image</IconButton>
        <IconButton disabled={!canEdit} label="Insert link" aria-pressed={editor?.isActive("link") ?? false} onClick={() => { const href = window.prompt("Link URL"); if (href) editor?.chain().focus().extendMarkRange("link").setLink({ href }).run(); }}>Link</IconButton>
        <IconButton disabled={!canEdit} label="Insert callout" onClick={() => editor?.chain().focus().insertContent({ type: "callout", attrs: { blockKey: crypto.randomUUID(), blockId: null, kind: "note" }, content: [{ type: "paragraph", content: [{ type: "text", text: "Callout" }] }] }).run()}>Callout</IconButton>
        <IconButton disabled={!canEdit} label="Insert Workspace Attachment" onClick={() => { const href = window.prompt("Workspace Attachment path"); if (!href?.startsWith("./attachments/")) return; const label = window.prompt("Attachment label")?.trim() || "Attachment"; editor?.chain().focus().insertContent({ type: "workspaceAttachment", attrs: { blockKey: crypto.randomUUID(), blockId: null, href, label } }).run(); }}>Attachment</IconButton>
        <IconButton disabled={!canEdit} label="Create Task from current Block" onClick={() => setTaskComposerOpen(true)}
          onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); setTaskComposerOpen(true); } }}>Task</IconButton>
        <IconButton disabled={!canEdit} label="Undo" onClick={() => editor?.chain().focus().undo().run()}>Undo</IconButton>
        <IconButton disabled={!canEdit} label="Redo" onClick={() => editor?.chain().focus().redo().run()}>Redo</IconButton>
      </div>
      <div className={styles.editor}><EditorContent editor={editor} /></div></Tabs.Content>
      <Tabs.Content value="markdown"><div ref={markdownPanelRef} className={styles.markdownPanel}>
        <label htmlFor={`markdown-source-${noteId}`}>Markdown source</label>
        <p>Portable Markdown supports headings, lists, checklists, code, quotes, links, tables, callouts, images, and Workspace Attachments.</p>
        <textarea id={`markdown-source-${noteId}`} aria-label="Markdown source" readOnly={!canEdit} spellCheck={false}
          value={markdownDraft} onChange={(event) => { const draft = event.target.value; setMarkdownDraft(draft);
            setMarkdownDraftStored(storeMarkdownDraft(markdownDraftKey, { base: markdownBase.current, draft })); setMarkdownError(""); }} />
        {markdownError ? <p className={styles.error} role="alert">{markdownError}</p> : null}
      </div></Tabs.Content>
      </Tabs.Root>
      {linkedTasks.data?.tasks?.length ? <section className={styles.linkedTasks} aria-label="Linked Tasks"><h2>Linked Tasks</h2><ul>{linkedTasks.data.tasks.map((task) => <li key={task.id}>
        <Link to={`/app/projects/${task.projectId}/tasks/${task.key}`}>{task.key} · {task.title}</Link><span>{task.status.name} · {task.relationshipState}</span></li>)}</ul></section> : null}
    </article>
    {contextVisible ? <aside className={styles.aside} aria-label="Note context"><h2>Collaboration</h2><p ref={statusRef} className={styles.status} role="status">{visibleStatus}</p>
      {error ? <><p className={styles.error} role="alert">{error}</p><Button className={styles.retry} type="button" variant="secondary" onClick={() => void synchronize()}>Retry saving</Button></> : null}
      <p>Changes merge with contributions from other Members. Offline work remains on this device until the Instance accepts it.</p>
      <h2>Linked Tasks</h2>{linkedTasks.isError ? <p role="alert">{linkedTasks.error.message}</p> : linkedTasks.data?.tasks?.length ? <ul>{linkedTasks.data.tasks.map((task) => <li key={task.id}><Link to={`/app/projects/${task.projectId}/tasks/${task.key}`}>{task.key} · {task.title}</Link><span>{task.status.name} · {task.relationshipState}</span></li>)}</ul> : <p>No Tasks are linked to this Note yet.</p>}
      {taskComposer}
    </aside> : <>{taskComposerOpen ? <aside className={styles.aside} aria-label="Linked Task composer"><h2>Create linked Task</h2>{taskComposer}</aside> : null}<p ref={statusRef} className={styles.visuallyHidden} role="status">{visibleStatus}</p>
      {error ? <p className={styles.visuallyHidden} role="alert">{error}</p> : null}</>}
  </main>;
}
