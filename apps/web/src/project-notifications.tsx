import * as RadioGroup from "@radix-ui/react-radio-group";
import { useGSAP } from "@gsap/react";
import { createStashApiClient } from "@stash/api-client";
import { projectFollowState, projectNotificationSettings, type NotificationDigestCadence,
  type ProjectActivityPreference, type ProjectNotificationSettings } from "@stash/validation";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import gsap from "gsap";
import { useParams } from "react-router";
import styles from "./project-notifications.module.css";

interface State extends ProjectNotificationSettings { readonly followed: boolean }
const choices: readonly { value: ProjectActivityPreference; title: string; description: string }[] = [
  { value: "all", title: "All Project Activity", description: "See every meaningful change made by another Member." },
  { value: "followed", title: "Followed Projects", description: "Only notify you when this Project is followed." },
  { value: "muted", title: "Muted", description: "Keep Activity available without sending notifications." },
];

async function readSettings(token: string, projectId: string): Promise<State> {
  const client = createStashApiClient({ baseUrl: "", memberToken: token });
  const [settingsPayload, followPayload] = await Promise.all([
    client.get<unknown>(`/api/projects/${encodeURIComponent(projectId)}/notification-settings`),
    client.get<unknown>(`/api/projects/${encodeURIComponent(projectId)}/follow`),
  ]);
  const settingsBody = settingsPayload && typeof settingsPayload === "object" ? (settingsPayload as { settings?: unknown }).settings : undefined;
  const settings = projectNotificationSettings(settingsBody); const follow = projectFollowState(followPayload);
  if (!settings.ok || !settings.value || !follow.ok || follow.value === undefined) throw new Error("The Instance returned invalid notification settings.");
  return { ...settings.value, followed: follow.value };
}

export function ProjectNotificationsPage({ token }: { readonly token?: string }) {
  const { projectId = "" } = useParams(); const queryClient = useQueryClient(); const alertRef = useRef<HTMLDivElement>(null); const pageRef = useRef<HTMLElement>(null);
  const key = ["project-notifications", projectId, token] as const;
  const query = useQuery({ queryKey: key, enabled: Boolean(token && projectId), retry: false, queryFn: () => readSettings(token!, projectId) });
  const [draft, setDraft] = useState<State>(); useEffect(() => { if (query.data) setDraft(query.data); }, [query.data]);
  const save = useMutation({ mutationFn: async (next: State) => { const client = createStashApiClient({ baseUrl: "", memberToken: token });
    await Promise.all([client.put(`/api/projects/${encodeURIComponent(projectId)}/notification-settings`, { activity: next.activity, digest: next.digest,
      ...(next.quietHours ? { quietHours: next.quietHours } : {}) }), client.put(`/api/projects/${encodeURIComponent(projectId)}/follow`, { followed: next.followed })]); return next;
  }, onSuccess: (next) => queryClient.setQueryData(key, next) });
  useEffect(() => { if (query.isError || save.isError) alertRef.current?.focus(); }, [query.isError, save.isError]);
  useGSAP(() => {
    if (!draft || window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) return;
    gsap.from("header > *, form > *", { opacity: 0, y: 8, duration: .36, stagger: .035, ease: "power2.out", clearProps: "all" });
  }, { scope: pageRef, dependencies: [Boolean(draft)] });
  if (!token || query.isPending) return <section className={styles.page} aria-busy="true"><p>Loading notification settings…</p></section>;
  if (query.isError || !draft) return <section className={styles.page}><div className={styles.error} ref={alertRef} role="alert" tabIndex={-1}>
    <p>{query.error?.message ?? "Project notification settings are unavailable."}</p><button type="button" onClick={() => query.refetch()}>Try again</button></div></section>;
  const quiet = draft.quietHours;
  return <section className={styles.page} aria-labelledby="notification-title" ref={pageRef}><header><p className={styles.eyebrow}>Project preferences</p>
    <h1 id="notification-title">Choose what reaches you.</h1><p className={styles.lede}>Activity stays trustworthy and attributed. Notifications only interrupt you at the level you choose.</p></header>
    <form className={styles.panel} onSubmit={(event) => { event.preventDefault(); save.mutate(draft); }}>
      <RadioGroup.Root className={styles.options} aria-label="Project Activity notifications" value={draft.activity}
        onValueChange={(activity) => setDraft({ ...draft, activity: activity as ProjectActivityPreference })} disabled={save.isPending}>
        {choices.map((choice) => <label className={styles.option} key={choice.value}><RadioGroup.Item className={styles.radio} value={choice.value}>
          <RadioGroup.Indicator className={styles.indicator} /></RadioGroup.Item><span><strong>{choice.title}</strong><small>{choice.description}</small></span></label>)}</RadioGroup.Root>
      <label className={styles.follow}><input type="checkbox" checked={draft.followed} disabled={save.isPending}
        onChange={(event) => setDraft({ ...draft, followed: event.target.checked })} /><span><strong>Follow this Project</strong><small>Use with “Followed Projects” to receive its meaningful changes.</small></span></label>
      <div className={styles.delivery}><label><strong>Digest cadence</strong><select value={draft.digest} disabled={save.isPending}
        onChange={(event) => setDraft({ ...draft, digest: event.target.value as NotificationDigestCadence })}><option value="off">Off</option><option value="daily">Daily</option><option value="weekly">Weekly</option></select></label>
        <label className={styles.follow}><input type="checkbox" checked={Boolean(quiet)} disabled={save.isPending}
          onChange={(event) => setDraft({ ...draft, quietHours: event.target.checked
            ? { start: "22:00", end: "07:00", timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone } : undefined })} />
          <span><strong>Quiet hours</strong><small>Defer interruptions during a daily window.</small></span></label>
        {quiet ? <fieldset><legend>Quiet-hour window</legend><label>Start<input aria-label="Quiet hours start" type="time" value={quiet.start}
          onChange={(event) => setDraft({ ...draft, quietHours: { ...quiet, start: event.target.value } })} /></label>
          <label>End<input aria-label="Quiet hours end" type="time" value={quiet.end} onChange={(event) => setDraft({ ...draft, quietHours: { ...quiet, end: event.target.value } })} /></label>
          <label>Time zone<input aria-label="Quiet hours time zone" value={quiet.timeZone} onChange={(event) => setDraft({ ...draft, quietHours: { ...quiet, timeZone: event.target.value } })} /></label></fieldset> : null}</div>
      <button className={styles.save} type="submit" disabled={save.isPending}>Save preferences</button></form>
    <p className={styles.status} role="status" aria-live="polite">{save.isPending ? "Saving…" : save.isSuccess ? "Preferences saved." : "Review your choices, then save."}</p>
    {save.isError ? <div className={styles.error} ref={alertRef} role="alert" tabIndex={-1}><p>{save.error.message}</p><button type="button" onClick={() => save.mutate(draft)}>Try again</button></div> : null}
  </section>;
}
