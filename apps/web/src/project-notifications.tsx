import * as RadioGroup from "@radix-ui/react-radio-group";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useParams } from "react-router";
import styles from "./project-notifications.module.css";

type ActivityPreference = "all" | "followed" | "muted";
interface ProjectNotificationState { readonly activity: ActivityPreference; readonly digest: "off" | "daily" | "weekly"; readonly followed: boolean }

async function requestJson(token: string, path: string, init?: RequestInit): Promise<unknown> {
  const response = await fetch(path, { ...init, headers: { authorization: `Bearer ${token}`, "content-type": "application/json", ...init?.headers } });
  if (!response.ok) throw new Error("Project notification settings could not be saved. Try again.");
  return response.json();
}

function isActivityPreference(value: string): value is ActivityPreference { return ["all", "followed", "muted"].includes(value); }

async function readSettings(token: string, projectId: string): Promise<ProjectNotificationState> {
  const [settingsPayload, followPayload] = await Promise.all([
    requestJson(token, `/api/projects/${encodeURIComponent(projectId)}/notification-settings`),
    requestJson(token, `/api/projects/${encodeURIComponent(projectId)}/follow`),
  ]);
  const settings = (settingsPayload as { settings?: Partial<ProjectNotificationState> }).settings;
  const followed = (followPayload as { followed?: unknown }).followed;
  if (!settings || typeof settings.activity !== "string" || !isActivityPreference(settings.activity)
    || !["off", "daily", "weekly"].includes(settings.digest ?? "") || typeof followed !== "boolean") throw new Error("The Instance returned invalid notification settings.");
  return { activity: settings.activity, digest: settings.digest!, followed };
}

const choices: readonly { value: ActivityPreference; title: string; description: string }[] = [
  { value: "all", title: "All Project Activity", description: "See every meaningful change made by another Member." },
  { value: "followed", title: "Followed Projects", description: "Only notify you when this Project is followed." },
  { value: "muted", title: "Muted", description: "Keep Activity available without sending notifications." },
];

export function ProjectNotificationsPage({ token }: { readonly token?: string }) {
  const { projectId = "" } = useParams(); const queryClient = useQueryClient();
  const key = ["project-notifications", projectId, token] as const;
  const query = useQuery({ queryKey: key, enabled: Boolean(token && projectId), retry: false, queryFn: () => readSettings(token!, projectId) });
  const save = useMutation({ mutationFn: async (next: ProjectNotificationState) => {
    await Promise.all([
      requestJson(token!, `/api/projects/${encodeURIComponent(projectId)}/notification-settings`, { method: "PUT", body: JSON.stringify({ activity: next.activity, digest: next.digest }) }),
      requestJson(token!, `/api/projects/${encodeURIComponent(projectId)}/follow`, { method: "PUT", body: JSON.stringify({ followed: next.followed }) }),
    ]); return next;
  }, onSuccess: (next) => queryClient.setQueryData(key, next) });
  if (!token || query.isPending) return <section className={styles.page} aria-busy="true"><p>Loading notification settings…</p></section>;
  if (query.isError || !query.data) return <section className={styles.page}><p role="alert">{query.error?.message ?? "Project notification settings are unavailable."}</p></section>;
  const state = query.data;
  const update = (next: Partial<ProjectNotificationState>) => save.mutate({ ...state, ...next });
  return <section className={styles.page} aria-labelledby="notification-title">
    <header><p className={styles.eyebrow}>Project preferences</p><h1 id="notification-title">Choose what reaches you.</h1>
      <p className={styles.lede}>Activity stays trustworthy and attributed. Notifications only interrupt you at the level you choose.</p></header>
    <div className={styles.panel}>
      <RadioGroup.Root className={styles.options} aria-label="Project Activity notifications" value={state.activity}
        onValueChange={(value) => { if (isActivityPreference(value)) update({ activity: value }); }} disabled={save.isPending}>
        {choices.map((choice) => <label className={styles.option} key={choice.value}>
          <RadioGroup.Item className={styles.radio} value={choice.value}><RadioGroup.Indicator className={styles.indicator} /></RadioGroup.Item>
          <span><strong>{choice.title}</strong><small>{choice.description}</small></span>
        </label>)}
      </RadioGroup.Root>
      <label className={styles.follow}><input type="checkbox" checked={state.followed} disabled={save.isPending}
        onChange={(event) => update({ followed: event.target.checked })} /><span><strong>Follow this Project</strong><small>Use with “Followed Projects” to receive its meaningful changes.</small></span></label>
    </div>
    <p className={styles.status} role="status" aria-live="polite">{save.isPending ? "Saving…" : save.isSuccess ? "Preferences saved." : "Changes save automatically."}</p>
    {save.isError ? <p className={styles.error} role="alert">{save.error.message}</p> : null}
  </section>;
}
