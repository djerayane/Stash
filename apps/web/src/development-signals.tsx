import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import * as Dialog from "@radix-ui/react-dialog";
import { createStashApiClient } from "@stash/api-client";
import { useEffect, useRef, useState } from "react";
import { Link, useParams } from "react-router";

import styles from "./development-signals.module.css";
import { DevelopmentArtifacts } from "./development-artifacts";
import { TaskAutomations } from "./task-automations";

interface Signal { readonly id: string; readonly kind: "branch" | "commit" | "pull_request"; readonly url: string; readonly label: string; readonly occurredAt: string }
interface Suggestion { readonly id: string; readonly taskKey: string; readonly taskTitle: string; readonly matchedKey: string; readonly status: "confirmed" | "pending_confirmation" }
interface SignalEntry { readonly signal: Signal; readonly suggestions: readonly Suggestion[] }

export interface DevelopmentSignalsPageProps {
  readonly projectId: string;
  readonly taskKey: string;
  readonly fetcher?: typeof fetch;
  readonly token?: string;
}

function storedToken() {
  try { const value = JSON.parse(window.localStorage.getItem("stash.member-session") ?? "null") as { token?: unknown } | null; return typeof value?.token === "string" ? value.token : ""; } catch { return ""; }
}

export function DevelopmentSignalsRoute() {
  const { projectId = "", taskKey = "" } = useParams();
  return <DevelopmentSignalsPage projectId={projectId} taskKey={taskKey} />;
}

export function DevelopmentSignalsPage({ projectId, taskKey, fetcher = globalThis.fetch, token = storedToken() }: DevelopmentSignalsPageProps) {
  const client = useQueryClient();
  const [reviewing, setReviewing] = useState<Suggestion>();
  const errorRef = useRef<HTMLDivElement>(null);
  const key = ["development-signals", projectId, taskKey];
  const api = createStashApiClient({ baseUrl: "", fetch: fetcher, memberToken: token });
  const query = useQuery({ queryKey: key, retry: false, queryFn: async () => {
    return (await api.get<{ signals: SignalEntry[] }>(`/api/projects/${encodeURIComponent(projectId)}/tasks/${encodeURIComponent(taskKey)}/development-signals`)).signals;
  } });
  const confirm = useMutation({ mutationFn: async (suggestion: Suggestion) => {
    await api.post(`/api/projects/${encodeURIComponent(projectId)}/tasks/${encodeURIComponent(taskKey)}/development-signals/suggestions/${encodeURIComponent(suggestion.id)}/confirm`);
  }, onSuccess: async () => { setReviewing(undefined); await client.invalidateQueries({ queryKey: key }); } });
  useEffect(() => { if (query.isError) errorRef.current?.focus(); }, [query.isError]);

  return <div className={styles.page}>
    <header className={styles.header}>
      <div><p className={styles.eyebrow}>{taskKey}</p><h1>Development Signals</h1><p>Verified GitHub activity stays separate from Task status and keeps every proposed relationship explicit.</p></div>
      <Link className={styles.backLink} to="/app/tasks">Back to Tasks</Link>
    </header>
    {query.isPending ? <div className={styles.loading} role="status">Loading development activity…</div> : null}
    {query.isError ? <div className={styles.error} ref={errorRef} role="alert" tabIndex={-1}><strong>Signals could not be loaded</strong><p>{query.error.message}</p><button type="button" onClick={() => void query.refetch()}>Try again</button></div> : null}
    {query.data?.length === 0 ? <section className={styles.empty}><span aria-hidden="true" /><h2>No development activity yet</h2><p>Branches, commits, and pull requests from the connected repository will appear here after GitHub verifies their delivery.</p></section> : null}
    {query.data?.length ? <section className={styles.grid} aria-label="GitHub activity">
      {query.data.map(({ signal, suggestions }) => <article className={styles.signal} key={signal.id}>
        <div className={styles.signalHeading}><span className={styles.kind}>{signal.kind.replace("_", " ")}</span><time dateTime={signal.occurredAt}>{new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(new Date(signal.occurredAt))}</time></div>
        <h2><a href={signal.url} rel="noreferrer" target="_blank">{signal.label}</a></h2>
        <div className={styles.relations}>{suggestions.map((suggestion) => <div className={styles.relation} key={suggestion.id}>
          <div><strong>{suggestion.taskKey}</strong><span>{suggestion.taskTitle}</span><small>Matched from {suggestion.matchedKey}</small></div>
          {suggestion.status === "confirmed" ? <span className={styles.confirmed}>Relationship confirmed</span> : <Dialog.Root open={reviewing?.id === suggestion.id} onOpenChange={(open) => setReviewing(open ? suggestion : undefined)}><Dialog.Trigger asChild><button type="button">Review match</button></Dialog.Trigger>
            <Dialog.Portal><Dialog.Overlay className={styles.backdrop} /><Dialog.Content className={styles.dialog}>
              <p className={styles.eyebrow}>Ambiguous Task key</p><Dialog.Title>Confirm Task relationship</Dialog.Title>
              <Dialog.Description>GitHub mentioned <strong>{suggestion.matchedKey}</strong>, which can identify more than one Task. Confirm only if this activity belongs to <strong>{suggestion.taskKey}</strong>.</Dialog.Description>
              {confirm.isError ? <p className={styles.inlineError} role="alert">{confirm.error.message}</p> : null}
              <div className={styles.actions}><Dialog.Close asChild><button type="button" className={styles.secondary}>Cancel</button></Dialog.Close><button type="button" disabled={confirm.isPending} onClick={() => confirm.mutate(suggestion)}>{confirm.isPending ? "Confirming…" : "Confirm relationship"}</button></div>
            </Dialog.Content></Dialog.Portal>
          </Dialog.Root>}
        </div>)}</div>
      </article>)}
    </section> : null}
    <DevelopmentArtifacts projectId={projectId} taskKey={taskKey} fetcher={fetcher} token={token} />
    <TaskAutomations projectId={projectId} taskKey={taskKey} fetcher={fetcher} token={token} />
  </div>;
}
