import * as Dialog from "@radix-ui/react-dialog";
import { useGSAP } from "@gsap/react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import gsap from "gsap";
import { useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import { Link, useParams, useSearchParams } from "react-router";
import type { ActivityCause, ActivityRecord, NotificationDelivery } from "@stash/domain-types";

import { DiscussionPanel } from "./discussion-panel";
import styles from "../core-workflows.module.css";
import { Button, StatusNotice } from "../ui/control";

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

function Loading() { return <StatusNotice className={styles.loading}>Loading Workspace data…</StatusNotice>; }
function Failure({ error, retry, recovery }: { readonly error: Error; readonly retry: () => void; readonly recovery?: string }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => { ref.current?.querySelector<HTMLElement>('[role="alert"]')?.focus(); }, []);
  return <div ref={ref}><StatusNotice className={styles.failure} tone="error" tabIndex={-1}><strong>That view could not be loaded</strong><p>{error.message}</p>{recovery ? <p>{recovery}</p> : null}<Button type="button" variant="secondary" onClick={retry}>Try again</Button></StatusNotice></div>;
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
  return <div className={styles.page}><Header title="Inbox" lede="Capture first. Add shape only when the thought earns it." action={<Dialog.Root open={captureOpen} onOpenChange={setCaptureOpen}><Dialog.Trigger asChild><Button type="button">Capture Note</Button></Dialog.Trigger><Dialog.Portal><Dialog.Overlay className={styles.overlay} /><Dialog.Content className={styles.dialog}><Dialog.Title>Capture a Note</Dialog.Title><Dialog.Description>Write the thought as it arrived. You can organize it from the Inbox.</Dialog.Description><textarea autoFocus value={content} onChange={(event) => setContent(event.target.value)} aria-label="Note content" /><div className={styles.actions}><Dialog.Close asChild><Button type="button" variant="secondary">Cancel</Button></Dialog.Close><Button disabled={!content.trim()} onClick={() => capture.mutate()} pending={capture.isPending} pendingLabel="Capturing…" type="button">Capture</Button></div>{capture.isError ? <StatusNotice tone="error">{capture.error.message} Your draft is preserved.</StatusNotice> : null}</Dialog.Content></Dialog.Portal></Dialog.Root>} />
    {inbox.isPending ? <Loading /> : inbox.isError ? <Failure error={inbox.error} retry={() => void inbox.refetch()} recovery="Your Inbox state is preserved. Try loading it again." /> : inbox.data.length === 0 ? <Empty title="Your Inbox is clear" body="New Notes will wait here until you organize or archive them." /> : <section className={styles.list} aria-label="Inbox Notes">{inbox.data.map((note) => <article key={note.id}><div><h2>{note.content.split("\n")[0] || "Untitled Note"}</h2><p>{note.content}</p></div><Button type="button" variant="secondary" onClick={() => setSelected(note)}>Triage</Button></article>)}</section>}
    <Dialog.Root open={Boolean(selected)} onOpenChange={(open) => !open && setSelected(undefined)}><Dialog.Portal><Dialog.Overlay className={styles.overlay} /><Dialog.Content className={styles.dialog}><Dialog.Title>Organize this Note</Dialog.Title><Dialog.Description>Assign it to a Project, or archive it from active views.</Dialog.Description><label>Project ID<input value={projectId} onChange={(event) => setProjectId(event.target.value)} /></label><div className={styles.actions}><Button type="button" variant="secondary" onClick={() => selected && triage.mutate({ note: selected, action: "archive" })}>Archive</Button><Button disabled={!projectId.trim()} type="button" onClick={() => selected && triage.mutate({ note: selected, action: "organize" })}>Organize</Button></div>{triage.isError ? <StatusNotice tone="error">{triage.error.message} Your triage choice is preserved.</StatusNotice> : null}</Dialog.Content></Dialog.Portal></Dialog.Root>
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
  return <div className={styles.page}><Header title="Notifications" lede="Relevant updates only, with a clear path back to the work." />{query.isPending ? <Loading /> : query.isError ? <Failure error={query.error} retry={() => void query.refetch()} recovery="No notification state changed. Try loading the same list again." /> : query.data.notifications.length ? <div className={styles.list}>{query.data.notifications.map((item) => <article key={item.id}><div><h2>{item.summary}</h2><p>{words(item.trigger)} · {words(item.activity.action)}</p><p>{item.activity.actor.displayName} · {causeLabel(item.activity.cause)}</p></div>{item.readAt ? <span>Read</span> : <Button type="button" variant="secondary" onClick={() => read.mutate(item.id)}>Mark read</Button>}</article>)}</div> : <Empty title="You are caught up" body="New assignments, mentions, and relevant changes will appear here." />}{read.isError ? <StatusNotice tone="error">{read.error.message} The notification remains unread.</StatusNotice> : null}</div>;
}

export function NoteHistoryPage({ token, fetcher = globalThis.fetch }: Omit<CoreProps, "workspaceId">) {
  const { noteId = "" } = useParams(); const client = useQueryClient(); const [selected, setSelected] = useState<NoteHistoryRevision>(); const [status, setStatus] = useState(""); const statusRef = useRef<HTMLDivElement>(null); const restoreErrorRef = useRef<HTMLDivElement>(null);
  const key = ["note-history", noteId];
  const query = useQuery({ queryKey: key, retry: false, queryFn: () => request(fetcher, token, `/api/notes/${encodeURIComponent(noteId)}/history`) as Promise<{
    access: "edit" | "read"; revisions: NoteHistoryRevision[];
  }> });
  const canRestore = query.data?.access === "edit";
  const latest = query.data?.revisions.reduce((value, revision) => Math.max(value, revision.revision), 0) ?? 0;
  const restore = useMutation({ mutationFn: (revision: NoteHistoryRevision) => request(fetcher, token, `/api/notes/${encodeURIComponent(noteId)}/history/${revision.revision}/restore`, { method: "POST", body: JSON.stringify({ expectedRevision: latest, idempotencyKey: crypto.randomUUID() }) }), onSuccess: async (_value, revision) => { setSelected(undefined); setStatus(`Revision ${revision.revision} restored.`); await client.invalidateQueries({ queryKey: key }); requestAnimationFrame(() => statusRef.current?.querySelector<HTMLElement>('[role="status"]')?.focus()); } });
  useEffect(() => { if (restore.isError) restoreErrorRef.current?.querySelector<HTMLElement>('[role="alert"]')?.focus(); }, [restore.isError]);
  return <div className={styles.page}><Header title="Note history" lede={query.data?.access === "read"
    ? "Inspect earlier authored states without changing the Note."
    : "Inspect earlier authored states and deliberately restore one without losing the audit trail."} action={<Link to={`/app/notes/${encodeURIComponent(noteId)}`}>Back to Note</Link>} />
    {query.data?.access === "read" ? <p role="note"><strong>Read-only history.</strong> You can inspect revision content, but only Workspace Members can restore it.</p> : null}
    {status ? <div ref={statusRef}><StatusNotice tabIndex={-1} tone="success">{status}</StatusNotice></div> : null}{query.isPending ? <Loading /> : query.isError ? <Failure error={query.error} retry={() => void query.refetch()} recovery="No Note revision was changed. Try loading history again." /> : query.data.revisions.length ? <ol className={styles.timeline}>{query.data.revisions.map((revision) => <li key={revision.revision}><span aria-hidden="true" /><div><strong>Revision {revision.revision}</strong><p>{revision.actor.displayName} · {new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(new Date(revision.recordedAt))}</p><p>{causeLabel(revision.cause)}</p><Button type="button" variant="secondary" onClick={() => { restore.reset(); setSelected(revision); }}>Review revision</Button></div></li>)}</ol> : <Empty title="No earlier revisions" body="Committed changes to this Note will appear here." />}
    <Dialog.Root open={Boolean(selected)} onOpenChange={(open) => { if (!open && !restore.isPending) setSelected(undefined); }}><Dialog.Portal><Dialog.Overlay className={styles.overlay} /><Dialog.Content className={styles.dialog}><Dialog.Title>{canRestore ? "Restore revision" : "Revision"} {selected?.revision}</Dialog.Title><Dialog.Description>{canRestore
      ? "Review this saved content. Restoring creates a new revision and preserves the current history."
      : "Review this saved content. Read-only access does not allow restoring it."}</Dialog.Description><pre>{selected?.content}</pre>{restore.isError ? <div ref={restoreErrorRef}><StatusNotice tabIndex={-1} tone="error">{restore.error.message} The current Note and selected revision are preserved.</StatusNotice></div> : null}<div className={styles.actions}><Dialog.Close asChild><Button disabled={restore.isPending} type="button" variant="secondary">{canRestore ? "Cancel" : "Close"}</Button></Dialog.Close>{canRestore ? <Button pending={restore.isPending} pendingLabel="Restoring…" type="button" onClick={() => selected && restore.mutate(selected)}>{restore.isError ? "Try restore again" : "Confirm restore"}</Button> : null}</div></Dialog.Content></Dialog.Portal></Dialog.Root>
  </div>;
}

export function SearchPage({ workspaceId, token, fetcher = globalThis.fetch }: CoreProps) {
  const [params, setParams] = useSearchParams(); const term = params.get("q")?.trim() || ""; const filterNames = ["q", "projectId", "object", "author", "assignee", "status", "from", "to"] as const; const resultsRef = useRef<HTMLDivElement>(null);
  const queryString = new URLSearchParams([...params.entries()].filter(([, value]) => value.trim())).toString();
  const query = useQuery({ queryKey: ["search", workspaceId, queryString], enabled: Boolean(term), retry: false, queryFn: async () => await request(fetcher, token, `/api/workspaces/${encodeURIComponent(workspaceId)}/search?${queryString}`) as SearchResponse });
  const updateFilter = (name: typeof filterNames[number], value: string) => { const next = new URLSearchParams(params); if (value) next.set(name, value); else next.delete(name); setParams(next, { replace: true }); };
  useGSAP(() => { if (!resultsRef.current || !query.data?.results.length || window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) return; gsap.from(resultsRef.current.children, { opacity: 0, y: 12, duration: .38, stagger: .05, ease: "power2.out", clearProps: "all" }); }, { scope: resultsRef, dependencies: [query.data] });
  const clearFilters = () => setParams(term ? { q: term } : {});
  const resultBody = (result: SearchResult) => <><div className={styles.searchResultHeading}><strong>{result.title}</strong><span>{words(result.kind)}</span></div>{result.excerpt ? <p>{result.excerpt}</p> : null}<dl className={styles.searchMetadata}>{result.author ? <><dt>Author</dt><dd>{result.author}</dd></> : null}{result.assignee ? <><dt>Assignee</dt><dd>{result.assignee}</dd></> : null}{result.status ? <><dt>Status</dt><dd>{result.status}</dd></> : null}{result.occurredAt ? <><dt>Date</dt><dd>{new Intl.DateTimeFormat(undefined, { dateStyle: "medium" }).format(new Date(result.occurredAt))}</dd></> : null}</dl></>;
  return <div className={styles.page}><Header title="Search" lede="Find permitted Notes, Tasks, Projects, and activity across this Workspace." /><label className={styles.searchQuery}><span className={styles.srOnly}>Search this view</span><input autoFocus type="search" value={term} placeholder="Search Notes, Tasks, and Projects" onChange={(event) => updateFilter("q", event.target.value)} /></label><details aria-label="Filters" className={styles.filterDisclosure} open role="group"><summary>Filters</summary><section className={styles.searchFilters} aria-label="Search filters"><label>Project<input value={params.get("projectId") || ""} onChange={(event) => updateFilter("projectId", event.target.value)} /></label><label>Object type<select value={params.get("object") || ""} onChange={(event) => updateFilter("object", event.target.value)}><option value="">All objects</option>{["note", "task", "discussion", "file", "label", "member", "development"].map((kind) => <option key={kind} value={kind}>{words(kind)}</option>)}</select></label><label>Author<input value={params.get("author") || ""} onChange={(event) => updateFilter("author", event.target.value)} /></label><label>Assignee<input value={params.get("assignee") || ""} onChange={(event) => updateFilter("assignee", event.target.value)} /></label><label>Status<input value={params.get("status") || ""} onChange={(event) => updateFilter("status", event.target.value)} /></label><label>From<input type="date" value={params.get("from") || ""} onChange={(event) => updateFilter("from", event.target.value)} /></label><label>To<input type="date" value={params.get("to") || ""} onChange={(event) => updateFilter("to", event.target.value)} /></label><Button type="button" variant="secondary" onClick={clearFilters}>Clear filters</Button></section></details>{!term ? <Empty title="Search your Workspace" body="Use the search field above to find Notes, Tasks, Discussions, files, labels, Members, and development data." /> : query.isPending ? <Loading /> : query.isError ? <Failure error={query.error} retry={() => void query.refetch()} recovery="Your search and filters are preserved. Try the same query again." /> : query.data.results.length ? <><aside aria-label="Permitted search summary"><p>{query.data.total} permitted {query.data.total === 1 ? "match" : "matches"}</p><ul>{query.data.facets.kinds.map((facet) => <li key={facet.value}>{words(facet.value)} {facet.count}</li>)}</ul></aside><div className={styles.searchResults} ref={resultsRef}>{query.data.results.map((result) => result.href ? <Link key={`${result.kind}-${result.id}`} to={result.href}>{resultBody(result)}</Link> : <article key={`${result.kind}-${result.id}`}>{resultBody(result)}</article>)}</div></> : <Empty title="No permitted matches" body="Try another phrase or remove a filter." />}</div>;
}
