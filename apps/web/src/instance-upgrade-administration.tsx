import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { type FormEvent, useEffect, useRef, useState } from "react";
import styles from "./instance-backup-administration.module.css";

interface Plan { status: "ready" | "blocked" | "current"; currentVersion: string; targetVersion: string; checks: Array<{ id: string; status: "pass" | "fail"; message: string }> }
const sessionKey = "stash.instance-admin-session";
function storedToken(): string { try { const value = JSON.parse(localStorage.getItem(sessionKey) ?? "null") as { token?: unknown }; return typeof value?.token === "string" ? value.token : ""; } catch { return ""; } }
async function request<T>(fetcher: typeof fetch, token: string, method = "GET", body?: unknown): Promise<T> { const response = await fetcher("/api/instance/upgrade", { method, headers: { authorization: `Bearer ${token}`, ...(body ? { "content-type": "application/json" } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
  const value = await response.json() as T & { message?: string }; if (!response.ok) throw new Error(value.message ?? "Upgrade operation failed."); return value; }

export function InstanceUpgradeAdministration({ fetcher = fetch }: { fetcher?: typeof fetch }) {
  const queryClient = useQueryClient(); const [token, setToken] = useState(storedToken); const [draftToken, setDraftToken] = useState("");
  const [confirmation, setConfirmation] = useState(""); const feedback = useRef<HTMLDivElement>(null);
  const plan = useQuery({ queryKey: ["instance-upgrade-plan", token], enabled: Boolean(token), retry: false, queryFn: () => request<Plan>(fetcher, token) });
  const upgrade = useMutation({ mutationFn: (targetVersion: string) => request<{ status: string; restartRequired: boolean }>(fetcher, token, "POST", { confirmation: targetVersion }) });
  useEffect(() => { if (upgrade.isError || upgrade.isSuccess || plan.isError) feedback.current?.focus(); }, [upgrade.isError, upgrade.isSuccess, plan.isError]);
  const authenticate = (event: FormEvent) => { event.preventDefault(); const next = draftToken.trim(); if (!next) return;
    localStorage.setItem(sessionKey, JSON.stringify({ token: next })); setToken(next); setDraftToken(""); };
  if (!token) return <main className={styles.signIn}><section aria-labelledby="operator-title"><span className={styles.mark}>S</span><p className={styles.kicker}>Instance operations</p>
    <h1 id="operator-title">Administrator access</h1><p>Use the operator credential configured for this Instance. It never grants Workspace membership.</p>
    <form onSubmit={authenticate}><label htmlFor="operator-token">Instance Administrator token</label><input id="operator-token" type="password" autoComplete="current-password" value={draftToken} onChange={(event) => setDraftToken(event.target.value)} />
      <button type="submit" disabled={!draftToken.trim()}>Continue</button></form></section></main>;
  const signOut = () => { localStorage.removeItem(sessionKey); setToken(""); void queryClient.removeQueries({ queryKey: ["instance-upgrade-plan"] }); };
  const ready = plan.data?.status === "ready"; const target = plan.data?.targetVersion ?? "the target version";
  return <main className={styles.page}><nav className={styles.navigation} aria-label="Instance administration"><a href="/instance-admin/backups">Stash operations</a><button type="button" onClick={signOut}>Lock console</button></nav>
    <header className={styles.header}><p className={styles.eyebrow}>Instance administration</p><h1>Upgrade with a way back.</h1><p>Stash verifies requirements and publishes a coordinated rollback point before any migration changes Instance data.</p></header>
    {plan.isPending ? <p className={styles.loading} aria-live="polite">Running upgrade preflight…</p> : null}
    {plan.isError ? <div className={styles.error} role="alert" tabIndex={-1} ref={feedback}>{plan.error.message}</div> : null}
    {plan.data ? <section className={styles.inventory} aria-labelledby="readiness-title"><div className={styles.inventoryHeading}><h2 id="readiness-title">{plan.data.currentVersion} → {plan.data.targetVersion}</h2><p>{ready ? "Every requirement passed. A verified backup will be created next." : plan.data.status === "current" ? "This Instance already runs the current format." : "Resolve every failed requirement before upgrading."}</p></div>
      <ul>{plan.data.checks.map((check) => <li className={styles.backup} key={check.id}><div><h3>{check.status === "pass" ? "Ready" : "Blocked"}</h3><p role={check.status === "fail" ? "alert" : undefined}>{check.message}</p></div></li>)}</ul></section> : null}
    {upgrade.isError ? <div className={styles.error} role="alert" tabIndex={-1} ref={feedback}>{upgrade.error.message}</div> : null}
    {upgrade.isSuccess ? <div className={styles.success} role="status" tabIndex={-1} ref={feedback}>Upgrade applied. Restart the Instance before reopening access.</div> : null}
    <section className={styles.safety} aria-labelledby="upgrade-action"><div><h2 id="upgrade-action">Confirm the target version</h2><p>The upgrade remains unavailable until preflight passes and the exact version is entered.</p></div><div><label htmlFor="upgrade-confirmation">Type {target} to confirm</label><input id="upgrade-confirmation" value={confirmation} onChange={(event) => setConfirmation(event.target.value)} /></div>
      <button type="button" disabled={!ready || confirmation !== plan.data?.targetVersion || upgrade.isPending} onClick={() => plan.data && upgrade.mutate(plan.data.targetVersion)}>{ready ? `Upgrade to ${plan.data?.targetVersion}` : "Upgrade unavailable"}</button></section>
  </main>;
}
