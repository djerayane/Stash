import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState, type FormEvent } from "react";

export interface DiscussionPanelClasses {
  actions?: string;
  empty?: string;
  failure?: string;
  list?: string;
  loading?: string;
  primary?: string;
  reply?: string;
}

type DiscussionTarget =
  | { kind: "note"; noteId: string }
  | { kind: "task"; taskId: string }
  | { kind: "block"; noteId: string; blockKey: string };

interface Discussion {
  id: string;
  resolvedAt?: string;
  target: { kind: "note" | "task" | "block"; state?: string };
  messages: Array<{ id: string; content: string; author: { displayName?: string } }>;
}

function request(fetcher: typeof fetch, token: string, path: string, init?: RequestInit) {
  return fetcher(path, { ...init, headers: { authorization: `Bearer ${token}`,
    ...(init?.body ? { "content-type": "application/json" } : {}), ...init?.headers } }).then(async (response) => {
    const body = await response.json().catch(() => ({})) as { message?: string };
    if (!response.ok) throw new Error(body.message || "The Instance could not complete this request.");
    return body;
  });
}

function targetDetails(target: DiscussionTarget) {
  if (target.kind === "note") return {
    key: ["discussions", "note", target.noteId],
    path: `/api/notes/${encodeURIComponent(target.noteId)}/discussions`,
    body: { kind: "note", noteId: target.noteId },
  } as const;
  if (target.kind === "task") return {
    key: ["discussions", "task", target.taskId],
    path: `/api/tasks/${encodeURIComponent(target.taskId)}/discussions`,
    body: { kind: "task", taskId: target.taskId },
  } as const;
  return {
    key: ["discussions", "block", target.noteId, target.blockKey],
    path: `/api/notes/${encodeURIComponent(target.noteId)}/blocks/${encodeURIComponent(target.blockKey)}/discussions`,
    body: { kind: "block", noteId: target.noteId, blockKey: target.blockKey },
  } as const;
}

export function DiscussionPanel({ target, token, canWrite, enabled = true, showWorkActions = false,
  fetcher = globalThis.fetch, classes = {} }: {
  target: DiscussionTarget;
  token: string;
  canWrite?: boolean;
  enabled?: boolean;
  showWorkActions?: boolean;
  fetcher?: typeof fetch;
  classes?: DiscussionPanelClasses;
}) {
  const details = targetDetails(target);
  const client = useQueryClient();
  const [body, setBody] = useState("");
  const [replies, setReplies] = useState<Record<string, string>>({});
  const [selected, setSelected] = useState<Record<string, Record<string, boolean>>>({});
  const [projectId, setProjectId] = useState("");
  const [taskTitle, setTaskTitle] = useState("");
  const feedbackRef = useRef<HTMLParagraphElement>(null);
  const queryErrorRef = useRef<HTMLDivElement>(null);
  const query = useQuery({ queryKey: details.key, enabled, retry: false, queryFn: () => request(fetcher, token, details.path) as Promise<{ access: "edit" | "read"; discussions: Discussion[] }> });
  const refresh = () => client.invalidateQueries({ queryKey: details.key });
  const create = useMutation({ mutationFn: () => request(fetcher, token, "/api/discussions", { method: "POST",
    body: JSON.stringify({ target: details.body, message: body }) }),
  onSuccess: async () => { setBody(""); await refresh(); } });
  const reply = useMutation({ mutationFn: ({ id, content }: { id: string; content: string }) => request(fetcher, token,
    `/api/discussions/${encodeURIComponent(id)}/messages`, { method: "POST", body: JSON.stringify({ content }) }),
  onSuccess: async (_value, variables) => { setReplies((current) => ({ ...current, [variables.id]: "" })); await refresh(); } });
  const resolve = useMutation({ mutationFn: (id: string) => request(fetcher, token,
    `/api/discussions/${encodeURIComponent(id)}/resolution`, { method: "PUT", body: JSON.stringify({}) }), onSuccess: refresh });
  const createWork = useMutation({ mutationFn: ({ discussionId, kind }: { discussionId: string; kind: "note" | "task" }) => {
    const messageIds = Object.entries(selected[discussionId] ?? {}).filter(([, checked]) => checked).map(([id]) => id);
    return request(fetcher, token, `/api/discussions/${encodeURIComponent(discussionId)}/work`, { method: "POST",
      body: JSON.stringify({ kind, messageIds, idempotencyKey: crypto.randomUUID(),
        ...(kind === "task" ? { projectId, title: taskTitle } : {}) }) });
  }, onSuccess: (_value, { discussionId }) => { setSelected((current) => ({ ...current, [discussionId]: {} })); setProjectId(""); setTaskTitle(""); } });
  const mutationError = create.error || reply.error || resolve.error || createWork.error;
  useEffect(() => { if (mutationError || createWork.isSuccess) feedbackRef.current?.focus(); }, [mutationError, createWork.isSuccess]);
  useEffect(() => { if (query.isError) queryErrorRef.current?.focus(); }, [query.isError]);

  return <>
    {canWrite ? <form className={classes.reply} onSubmit={(event: FormEvent) => { event.preventDefault(); create.mutate(); }}>
      <label>Start a Discussion<textarea value={body} onChange={(event) => setBody(event.target.value)} /></label>
      <button className={classes.primary} disabled={!body.trim() || create.isPending}>Start Discussion</button>
    </form> : <p role="note"><strong>Read-only access.</strong> You can follow this Discussion, but only Workspace Members can contribute or resolve it.</p>}
    {mutationError ? <p ref={feedbackRef} role="alert" tabIndex={-1}>{mutationError.message}</p>
      : createWork.isSuccess ? <p aria-label="Discussion work result" ref={feedbackRef} role="status" tabIndex={-1}>Selected Discussion messages created a {createWork.variables.kind === "note" ? "Note" : "Task"}.</p> : null}
    {query.isPending ? <p className={classes.loading} role="status">Opening Discussions…</p>
      : query.isError ? <div className={classes.failure} ref={queryErrorRef} role="alert" tabIndex={-1}><strong>Discussions could not be opened</strong><p>{query.error.message}</p><button type="button" onClick={() => void query.refetch()}>Try again</button></div>
      : query.data.discussions.length ? <div className={classes.list}>{query.data.discussions.map((item) => <article key={item.id}>
        <h2>{item.target.kind === "block" ? `Block Discussion · ${item.target.state || "attached"}` : "Discussion"}</h2>
        <span role="status">{item.resolvedAt ? "Resolved" : "Open"}</span>
        <ol aria-live="polite">{item.messages.map((message) => <li key={message.id}>{showWorkActions && canWrite ? <label>
          <input aria-label={`Select ${message.content}`} type="checkbox" checked={Boolean(selected[item.id]?.[message.id])}
            onChange={(event) => setSelected((current) => ({ ...current, [item.id]: { ...current[item.id], [message.id]: event.target.checked } }))} />{message.content}</label> : message.content}
          <small>{message.author.displayName || "Member"}</small></li>)}</ol>
        {!item.resolvedAt && canWrite ? <><form onSubmit={(event) => { event.preventDefault(); reply.mutate({ id: item.id, content: replies[item.id] || "" }); }}>
          <label>Reply<textarea value={replies[item.id] || ""} onChange={(event) => setReplies((current) => ({ ...current, [item.id]: event.target.value }))} /></label>
          <button disabled={!replies[item.id]?.trim() || reply.isPending}>Reply</button></form>
          <button disabled={resolve.isPending} type="button" onClick={() => resolve.mutate(item.id)}>Resolve Discussion</button></> : null}
        {showWorkActions && canWrite ? <div className={classes.actions}><button type="button"
          disabled={!item.messages.some((message) => selected[item.id]?.[message.id])}
          onClick={() => createWork.mutate({ discussionId: item.id, kind: "note" })}>Create Note from selection</button>
          <label>Project ID<input value={projectId} onChange={(event) => setProjectId(event.target.value)} /></label>
          <label>Task title<input value={taskTitle} onChange={(event) => setTaskTitle(event.target.value)} /></label>
          <button type="button" disabled={!item.messages.some((message) => selected[item.id]?.[message.id]) || !projectId.trim() || !taskTitle.trim()}
            onClick={() => createWork.mutate({ discussionId: item.id, kind: "task" })}>Create Task from selection</button></div> : null}
      </article>)}</div>
      : <section className={classes.empty}><span aria-hidden="true" /><h2>No Discussion yet</h2><p>{canWrite
        ? "Start one when a Note, Task, or Block needs focused conversation."
        : "Workspace Members can start a Discussion when this Note needs focused conversation."}</p></section>}
  </>;
}
