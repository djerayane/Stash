import * as Dialog from "@radix-ui/react-dialog";
import { useGSAP } from "@gsap/react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import gsap from "gsap";
import { useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import { Link, useParams, useSearchParams } from "react-router";
import type { ActivityCause, ActivityRecord, NotificationDelivery } from "@stash/domain-types";

import { DiscussionPanel } from "./discussion-panel";
import styles from "../core-workflows.module.css";

type Fetcher = typeof fetch;
interface CoreProps { readonly workspaceId: string; readonly token: string; readonly fetcher?: Fetcher }
interface Note { readonly id: string; readonly content: string; readonly createdAt?: string; readonly projectId?: string }
interface NoteHistoryRevision { readonly noteId: string; readonly revision: number; readonly content: string; readonly recordedAt: string; readonly actor: ActivityRecord["actor"]; readonly cause: ActivityCause }
interface SearchResult { readonly id: string; readonly kind: string; readonly title: string; readonly excerpt?: string; readonly href?: string; readonly projectId?: string; readonly author?: string; readonly assignee?: string; readonly status?: string; readonly occurredAt?: string }
interface SearchFacet { readonly value: string; readonly count: number }
interface SearchResponse { readonly results: SearchResult[]; readonly total: number; readonly facets: { readonly kinds: SearchFacet[]; readonly projects: SearchFacet[]; readonly statuses: SearchFacet[] } }

function request(fetcher: Fetcher, token: string, path: string, init?: RequestInit) {
  return fetcher(path, { ...init, headers: { authorization: `Bearer ${token}`, ...(init?.body ? { "content-type": "application/json" } : {}), ...init?.headers } }).then(async (response) => {
    const body = await response.json().catch(() => ({})) as { message?: string };
    if (!response.ok) throw new Error(body.message || "The Instance could not complete this request.");
    return body;
  });
}

function Loading() { return <p className={styles.loading} role="status">Loading Workspace data…</p>; }
function Failure({ error, retry }: { readonly error: Error; readonly retry: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => { ref.current?.focus(); }, []);
  return <div className={styles.failure} ref={ref} role="alert" tabIndex={-1}><strong>That view could not be loaded</strong><p>{error.message}</p><button type="button" onClick={retry}>Try again</button></div>;
}
function Header({ title, lede, action }: { readonly title: string; readonly lede: string; readonly action?: ReactNode }) {
  return <header className={styles.header}><div><h1>{title}</h1><p>{lede}</p></div>{action}</header>;
}
function Empty({ title, body }: { readonly title: string; readonly body: string }) { return <section className={styles.empty}><span aria-hidden="true" /><h2>{title}</h2><p>{body}</p></section>; }
const words = (value: string) => value.replaceAll("_", " ");
const facts = (value: Record<string, unknown>) => Object.entries(value).map(([key, entry]) => `${words(key)}: ${typeof entry === "string" ? entry : JSON.stringify(entry)}`).join(", ") || "none";
const causeLabel = (cause: ActivityCause) => cause.kind === "member" && cause.restorationOfRevision
  ? `Member restoration of revision ${cause.restorationOfRevision}`
  : cause.kind === "agent" ? `Agent ${cause.agentName}` : words(cause.kind);

export function InboxPage({ workspaceId, token, fetcher = globalThis.fetch }: CoreProps) {
  const client = useQueryClient(); const [content, setContent] = useState(""); const [captureOpen, setCaptureOpen] = useState(false); const [selected, setSelected] = useState<Note>(); const [projectId, setProjectId] = useState("");
  const key = ["inbox", workspaceId];
  const inbox = useQuery({ queryKey: key, retry: false, queryFn: async () => (await request(fetcher, token, `/api/workspaces/${encodeURIComponent(workspaceId)}/inbox`) as { notes: Note[] }).notes });
  const capture = useMutation({ mutationFn: () => request(fetcher, token, `/api/workspaces/${encodeURIComponent(workspaceId)}/notes`, { method: "POST", body: JSON.stringify({ content }) }), onSuccess: async () => { setContent(""); setCaptureOpen(false); await client.invalidateQueries({ queryKey: key }); } });
  const triage = useMutation({ mutationFn: ({ note, action }: { note: Note; action: "archive" | "organize" }) => request(fetcher, token, `/api/workspaces/${encodeURIComponent(workspaceId)}/inbox/${encodeURIComponent(note.id)}/triage`, { method: "POST", body: JSON.stringify(action === "archive" ? { action } : { action, projectId }) }), onSuccess: async () => { setSelected(undefined); setProjectId(""); await client.invalidateQueries({ queryKey: key }); } });
  return <div className={styles.page}><Header title="Inbox" lede="Capture first. Add shape only when the thought earns it." action={<Dialog.Root open={captureOpen} onOpenChange={setCaptureOpen}><Dialog.Trigger asChild><button className={styles.primary} type="button">Capture Note</button></Dialog.Trigger><Dialog.Portal><Dialog.Overlay className={styles.overlay} /><Dialog.Content className={styles.dialog}><Dialog.Title>Capture a Note</Dialog.Title><Dialog.Description>Write the thought as it arrived. You can organize it from the Inbox.</Dialog.Description><textarea autoFocus value={content} onChange={(event) => setContent(event.target.value)} aria-label="Note content" /><div className={styles.actions}><Dialog.Close asChild><button type="button">Cancel</button></Dialog.Close><button className={styles.primary} disabled={!content.trim() || capture.isPending} onClick={() => capture.mutate()} type="button">{capture.isPending ? "Capturing…" : "Capture"}</button></div>{capture.isError ? <p role="alert">{capture.error.message}</p> : null}</Dialog.Content></Dialog.Portal></Dialog.Root>} />
    {inbox.isPending ? <Loading /> : inbox.isError ? <Failure error={inbox.error} retry={() => void inbox.refetch()} /> : inbox.data.length === 0 ? <Empty title="Your Inbox is clear" body="New Notes will wait here until you organize or archive them." /> : <section className={styles.list} aria-label="Inbox Notes">{inbox.data.map((note) => <article key={note.id}><div><h2>{note.content.split("\n")[0] || "Untitled Note"}</h2><p>{note.content}</p></div><button type="button" onClick={() => setSelected(note)}>Triage</button></article>)}</section>}
    <Dialog.Root open={Boolean(selected)} onOpenChange={(open) => !open && setSelected(undefined)}><Dialog.Portal><Dialog.Overlay className={styles.overlay} /><Dialog.Content className={styles.dialog}><Dialog.Title>Organize this Note</Dialog.Title><Dialog.Description>Assign it to a Project, or archive it from active views.</Dialog.Description><label>Project ID<input value={projectId} onChange={(event) => setProjectId(event.target.value)} /></label><div className={styles.actions}><button type="button" onClick={() => selected && triage.mutate({ note: selected, action: "archive" })}>Archive</button><button className={styles.primary} disabled={!projectId.trim()} type="button" onClick={() => selected && triage.mutate({ note: selected, action: "organize" })}>Organize</button></div>{triage.isError ? <p role="alert">{triage.error.message}</p> : null}</Dialog.Content></Dialog.Portal></Dialog.Root>
  </div>;
}


export function DiscussionsPage({ token, targetKind, fetcher = globalThis.fetch }: Omit<CoreProps, "workspaceId"> & { readonly targetKind: "note" | "task" | "block" }) {
  const { targetId = "", blockKey = "" } = useParams();
  const target = targetKind === "note" ? { kind: "note" as const, noteId: targetId }
    : targetKind === "task" ? { kind: "task" as const, taskId: targetId }
    : { kind: "block" as const, noteId: targetId, blockKey };
  const targetType = targetKind === "task" ? "tasks" : "notes";
  const discussionPath = targetKind === "block" ? `/api/notes/${encodeURIComponent(targetId)}/blocks/${encodeURIComponent(blockKey)}/discussions`
    : `/api/${targetType}/${encodeURIComponent(targetId)}/discussions`;
  const key = ["discussions", targetKind, targetId, ...(targetKind === "block" ? [blockKey] : [])];
  const access = useQuery({ queryKey: key, retry: false, queryFn: () => request(fetcher, token, discussionPath) as Promise<{
    access: "edit" | "read"; discussions: unknown[];
  }> });
  return <div className={styles.page}><Header title="Discussions" lede="Keep conversation portable and distinct from authored knowledge." />
    {access.isPending ? <Loading /> : access.isError ? <Failure error={access.error} retry={() => void access.refetch()} /> : <DiscussionPanel canWrite={access.data.access === "edit"}
      classes={{ actions: styles.actions, empty: styles.empty, failure: styles.failure, list: styles.list,
      loading: styles.loading, primary: styles.primary, reply: styles.reply }} fetcher={fetcher} showWorkActions target={target} token={token} />
    }
  </div>;
}

export function ActivityPage({ workspaceId, token, fetcher = globalThis.fetch }: CoreProps) {
  const query = useQuery({ queryKey: ["activity", workspaceId], retry: false, queryFn: () => request(fetcher, token, `/api/workspaces/${encodeURIComponent(workspaceId)}/activity`) as Promise<{ activities: ActivityRecord[] }> });
  return <div className={styles.page}><Header title="Activity" lede="Meaningful changes with enough history to understand who changed what." />{query.isPending ? <Loading /> : query.isError ? <Failure error={query.error} retry={() => void query.refetch()} /> : query.data.activities.length ? <ol className={styles.timeline}>{query.data.activities.map((item) => <li key={item.id}><span aria-hidden="true" /><div><strong>{words(item.action)}</strong><p>{item.actor.displayName} · {new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(new Date(item.occurredAt))}</p><p>Cause: {causeLabel(item.cause)}</p><p><b>Before:</b> {facts(item.before)} <b>After:</b> {facts(item.after)}</p></div></li>)}</ol> : <Empty title="No Activity yet" body="Changes to Notes, Tasks, and Automations will be explained here." />}</div>;
}

export function NotificationsPage({ token, fetcher = globalThis.fetch }: Omit<CoreProps, "workspaceId">) {
  const client = useQueryClient(); const key = ["notifications"];
  const query = useQuery({ queryKey: key, retry: false, queryFn: () => request(fetcher, token, "/api/notifications") as Promise<{ notifications: NotificationDelivery[] }> });
  const read = useMutation({ mutationFn: (id: string) => request(fetcher, token, `/api/notifications/${encodeURIComponent(id)}/read`, { method: "POST" }), onSuccess: () => client.invalidateQueries({ queryKey: key }) });
  return <div className={styles.page}><Header title="Notifications" lede="Relevant updates only, with a clear path back to the work." />{query.isPending ? <Loading /> : query.isError ? <Failure error={query.error} retry={() => void query.refetch()} /> : query.data.notifications.length ? <div className={styles.list}>{query.data.notifications.map((item) => <article key={item.id}><div><h2>{item.summary}</h2><p>{words(item.trigger)} · {words(item.activity.action)}</p><p>{item.activity.actor.displayName} · {causeLabel(item.activity.cause)}</p></div>{item.readAt ? <span>Read</span> : <button type="button" onClick={() => read.mutate(item.id)}>Mark read</button>}</article>)}</div> : <Empty title="You are caught up" body="New assignments, mentions, and relevant changes will appear here." />}{read.isError ? <p role="alert">{read.error.message}</p> : null}</div>;
}

export function NoteHistoryPage({ token, fetcher = globalThis.fetch }: Omit<CoreProps, "workspaceId">) {
  const { noteId = "" } = useParams(); const client = useQueryClient(); const [selected, setSelected] = useState<NoteHistoryRevision>(); const [status, setStatus] = useState(""); const statusRef = useRef<HTMLParagraphElement>(null); const restoreErrorRef = useRef<HTMLParagraphElement>(null);
  const key = ["note-history", noteId];
  const query = useQuery({ queryKey: key, retry: false, queryFn: () => request(fetcher, token, `/api/notes/${encodeURIComponent(noteId)}/history`) as Promise<{
    access: "edit" | "read"; revisions: NoteHistoryRevision[];
  }> });
  const canRestore = query.data?.access === "edit";
  const latest = query.data?.revisions.reduce((value, revision) => Math.max(value, revision.revision), 0) ?? 0;
  const restore = useMutation({ mutationFn: (revision: NoteHistoryRevision) => request(fetcher, token, `/api/notes/${encodeURIComponent(noteId)}/history/${revision.revision}/restore`, { method: "POST", body: JSON.stringify({ expectedRevision: latest, idempotencyKey: crypto.randomUUID() }) }), onSuccess: async (_value, revision) => { setSelected(undefined); setStatus(`Revision ${revision.revision} restored.`); await client.invalidateQueries({ queryKey: key }); requestAnimationFrame(() => statusRef.current?.focus()); } });
  useEffect(() => { if (restore.isError) restoreErrorRef.current?.focus(); }, [restore.isError]);
  return <div className={styles.page}><Header title="Note history" lede={query.data?.access === "read"
    ? "Inspect earlier authored states without changing the Note."
    : "Inspect earlier authored states and deliberately restore one without losing the audit trail."} action={<Link to={`/app/notes/${encodeURIComponent(noteId)}`}>Back to Note</Link>} />
    {query.data?.access === "read" ? <p role="note"><strong>Read-only history.</strong> You can inspect revision content, but only Workspace Members can restore it.</p> : null}
    {status ? <p ref={statusRef} tabIndex={-1} role="status">{status}</p> : null}{query.isPending ? <Loading /> : query.isError ? <Failure error={query.error} retry={() => void query.refetch()} /> : query.data.revisions.length ? <ol className={styles.timeline}>{query.data.revisions.map((revision) => <li key={revision.revision}><span aria-hidden="true" /><div><strong>Revision {revision.revision}</strong><p>{revision.actor.displayName} · {new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(new Date(revision.recordedAt))}</p><p>{causeLabel(revision.cause)}</p><button type="button" onClick={() => { restore.reset(); setSelected(revision); }}>Review revision</button></div></li>)}</ol> : <Empty title="No earlier revisions" body="Committed changes to this Note will appear here." />}
    <Dialog.Root open={Boolean(selected)} onOpenChange={(open) => { if (!open && !restore.isPending) setSelected(undefined); }}><Dialog.Portal><Dialog.Overlay className={styles.overlay} /><Dialog.Content className={styles.dialog}><Dialog.Title>{canRestore ? "Restore revision" : "Revision"} {selected?.revision}</Dialog.Title><Dialog.Description>{canRestore
      ? "Review this saved content. Restoring creates a new revision and preserves the current history."
      : "Review this saved content. Read-only access does not allow restoring it."}</Dialog.Description><pre>{selected?.content}</pre>{restore.isError ? <p ref={restoreErrorRef} tabIndex={-1} role="alert">{restore.error.message}</p> : null}<div className={styles.actions}><Dialog.Close asChild><button disabled={restore.isPending} type="button">{canRestore ? "Cancel" : "Close"}</button></Dialog.Close>{canRestore ? <button className={styles.primary} disabled={restore.isPending} type="button" onClick={() => selected && restore.mutate(selected)}>{restore.isPending ? "Restoring…" : restore.isError ? "Try restore again" : "Confirm restore"}</button> : null}</div></Dialog.Content></Dialog.Portal></Dialog.Root>
  </div>;
}

export function SearchPage({ workspaceId, token, fetcher = globalThis.fetch }: CoreProps) {
  const [params, setParams] = useSearchParams(); const term = params.get("q")?.trim() || ""; const filterNames = ["projectId", "object", "author", "assignee", "status", "from", "to"] as const; const resultsRef = useRef<HTMLDivElement>(null);
  const queryString = new URLSearchParams([...params.entries()].filter(([, value]) => value.trim())).toString();
  const query = useQuery({ queryKey: ["search", workspaceId, queryString], enabled: Boolean(term), retry: false, queryFn: async () => await request(fetcher, token, `/api/workspaces/${encodeURIComponent(workspaceId)}/search?${queryString}`) as SearchResponse });
  const updateFilter = (name: typeof filterNames[number], value: string) => { const next = new URLSearchParams(params); if (value) next.set(name, value); else next.delete(name); setParams(next); };
  useGSAP(() => { if (!resultsRef.current || !query.data?.results.length || window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) return; gsap.from(resultsRef.current.children, { opacity: 0, y: 12, duration: .38, stagger: .05, ease: "power2.out", clearProps: "all" }); }, { scope: resultsRef, dependencies: [query.data] });
  const clearFilters = () => setParams(term ? { q: term } : {});
  const resultBody = (result: SearchResult) => <><div className={styles.searchResultHeading}><strong>{result.title}</strong><span>{words(result.kind)}</span></div>{result.excerpt ? <p>{result.excerpt}</p> : null}<dl className={styles.searchMetadata}>{result.author ? <><dt>Author</dt><dd>{result.author}</dd></> : null}{result.assignee ? <><dt>Assignee</dt><dd>{result.assignee}</dd></> : null}{result.status ? <><dt>Status</dt><dd>{result.status}</dd></> : null}{result.occurredAt ? <><dt>Date</dt><dd>{new Intl.DateTimeFormat(undefined, { dateStyle: "medium" }).format(new Date(result.occurredAt))}</dd></> : null}</dl></>;
  return <div className={styles.page}><Header title="Workspace Search" lede={term ? `Results for “${term}”` : "Find permitted knowledge and work across this Workspace."} /><section className={styles.searchFilters} aria-label="Search filters"><label>Project<input value={params.get("projectId") || ""} onChange={(event) => updateFilter("projectId", event.target.value)} /></label><label>Object type<select value={params.get("object") || ""} onChange={(event) => updateFilter("object", event.target.value)}><option value="">All objects</option>{["note", "task", "discussion", "file", "label", "member", "development"].map((kind) => <option key={kind} value={kind}>{words(kind)}</option>)}</select></label><label>Author<input value={params.get("author") || ""} onChange={(event) => updateFilter("author", event.target.value)} /></label><label>Assignee<input value={params.get("assignee") || ""} onChange={(event) => updateFilter("assignee", event.target.value)} /></label><label>Status<input value={params.get("status") || ""} onChange={(event) => updateFilter("status", event.target.value)} /></label><label>From<input type="date" value={params.get("from") || ""} onChange={(event) => updateFilter("from", event.target.value)} /></label><label>To<input type="date" value={params.get("to") || ""} onChange={(event) => updateFilter("to", event.target.value)} /></label><button type="button" onClick={clearFilters}>Clear filters</button></section>{!term ? <Empty title="Search your Workspace" body="Use the search field above to find Notes, Tasks, Discussions, files, labels, Members, and development data." /> : query.isPending ? <Loading /> : query.isError ? <Failure error={query.error} retry={() => void query.refetch()} /> : query.data.results.length ? <><aside aria-label="Permitted search summary"><p>{query.data.total} permitted {query.data.total === 1 ? "match" : "matches"}</p><ul>{query.data.facets.kinds.map((facet) => <li key={facet.value}>{words(facet.value)} {facet.count}</li>)}</ul></aside><div className={styles.searchResults} ref={resultsRef}>{query.data.results.map((result) => result.href ? <Link key={`${result.kind}-${result.id}`} to={result.href}>{resultBody(result)}</Link> : <article key={`${result.kind}-${result.id}`}>{resultBody(result)}</article>)}</div></> : <Empty title="No permitted matches" body="Try another phrase or remove a filter." />}</div>;
}
