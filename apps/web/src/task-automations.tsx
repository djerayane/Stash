import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import * as Dialog from "@radix-ui/react-dialog";
import { createStashApiClient } from "@stash/api-client";
import type { AutomationRecipe as Recipe, AutomationState, AutomationTransition as Transition } from "@stash/domain-types";
import { useEffect, useRef, useState } from "react";
import styles from "./task-automations.module.css";

interface Props { readonly projectId: string; readonly taskKey: string; readonly fetcher?: typeof fetch; readonly token?: string }

const triggerLabel = { branch_created: "When a branch is created", pull_request_completed: "When a pull request is completed" } as const;

export function TaskAutomations({ projectId, taskKey, fetcher = globalThis.fetch, token = "" }: Props) {
  const queryClient = useQueryClient();
  const errorRef = useRef<HTMLDivElement>(null);
  const [configuring, setConfiguring] = useState(false);
  const [trigger, setTrigger] = useState<Recipe["trigger"]>("branch_created");
  const [targetStatusId, setTargetStatusId] = useState("");
  const key = ["task-automations", projectId, taskKey];
  const api = createStashApiClient({ baseUrl: "", fetch: fetcher, memberToken: token });
  const path = `/api/projects/${encodeURIComponent(projectId)}/tasks/${encodeURIComponent(taskKey)}/automations`;
  const query = useQuery({ queryKey: key, retry: false, queryFn: async () => (await api.get<{ automation: AutomationState }>(path)).automation });
  const reverse = useMutation({ mutationFn: async (transition: Transition) => api.post(`${path}/${encodeURIComponent(transition.id)}/reverse`),
    onSuccess: async () => queryClient.invalidateQueries({ queryKey: key }) });
  const configure = useMutation({ mutationFn: async () => api.post(`/api/projects/${encodeURIComponent(projectId)}/automations`, { trigger, targetStatusId }),
    onSuccess: async () => { setConfiguring(false); await queryClient.invalidateQueries({ queryKey: key }); } });
  useEffect(() => { if (query.isError) errorRef.current?.focus(); }, [query.isError]);

  return <section className={styles.section} aria-labelledby="automation-title">
    <div className={styles.heading}><h2 id="automation-title">Automations</h2><div className={styles.headingAction}><p>Signal-driven changes remain visible, attributable, and reversible.</p><Dialog.Root open={configuring} onOpenChange={(open) => { setConfiguring(open); if (open && !targetStatusId) setTargetStatusId(query.data?.availableStatuses[0]?.id ?? ""); }}><Dialog.Trigger asChild><button type="button">Configure recipe</button></Dialog.Trigger><Dialog.Portal><Dialog.Overlay className={styles.backdrop} /><Dialog.Content className={styles.dialog}><Dialog.Title>Configure Task status Automation</Dialog.Title><Dialog.Description>Build a readable When/If/Then rule for verified development Signals in this Project.</Dialog.Description><label>When<select value={trigger} onChange={(event) => setTrigger(event.target.value as Recipe["trigger"])}><option value="branch_created">a branch is created</option><option value="pull_request_completed">a pull request is completed</option></select></label><label>Then move the Task to<select value={targetStatusId} onChange={(event) => setTargetStatusId(event.target.value)}>{query.data?.availableStatuses.map((status) => <option value={status.id} key={status.id}>{status.name}</option>)}</select></label>{configure.isError ? <p className={styles.inlineError} role="alert">{configure.error.message}</p> : null}<div className={styles.actions}><Dialog.Close asChild><button type="button" className={styles.secondary}>Cancel</button></Dialog.Close><button type="button" disabled={!targetStatusId || configure.isPending} onClick={() => configure.mutate()}>{configure.isPending ? "Enabling…" : "Enable recipe"}</button></div></Dialog.Content></Dialog.Portal></Dialog.Root></div></div>
    {query.isPending ? <p role="status">Loading Automations…</p> : null}
    {query.isError ? <div className={styles.error} role="alert" ref={errorRef} tabIndex={-1}><strong>Automations could not be loaded</strong><p>{query.error.message}</p><button type="button" onClick={() => void query.refetch()}>Try again</button></div> : null}
    {query.data ? <>
      <div className={styles.recipes}>{query.data.recipes.length ? query.data.recipes.map((recipe) => <article key={recipe.id} className={styles.recipe}>
        <span className={styles.pulse} aria-hidden="true" /><div><strong>{triggerLabel[recipe.trigger]}</strong><p>If the Signal belongs to this Task, then move it to <b>{recipe.targetStatus.name}</b>.</p></div><span className={styles.enabled}>Enabled</span>
      </article>) : <p className={styles.empty}>No status recipe is enabled for this Project.</p>}</div>
      {query.data.transitions.length ? <div className={styles.history}><h3>Recent automated changes</h3>{query.data.transitions.map((transition) => <article className={styles.transition} key={transition.id}>
        <div><strong>{transition.before.name} → {transition.after.name}</strong><p>Applied by Automation from Signal <code>{transition.signalId.slice(0, 8)}</code> on <time dateTime={transition.occurredAt}>{new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(new Date(transition.occurredAt))}</time>.</p></div>
        {transition.reversedAt ? <span className={styles.reversed}>Reversed</span> : <button type="button" disabled={reverse.isPending} onClick={() => reverse.mutate(transition)}>{reverse.isPending ? "Undoing…" : "Undo status change"}</button>}
      </article>)}{reverse.isError ? <p className={styles.inlineError} role="alert">{reverse.error.message}</p> : null}</div> : null}
    </> : null}
  </section>;
}
