import { useMutation, useQuery } from "@tanstack/react-query";
import { useGSAP } from "@gsap/react";
import gsap from "gsap";
import { useEffect, useRef, useState } from "react";
import styles from "./instance-backup-administration.module.css";
import { InstanceAdminNavigation, InstanceAdminSignIn, useInstanceAdminSession } from "./instance-admin-session";

interface Plan { status: "ready" | "blocked" | "current"; currentVersion: string; targetVersion: string; checks: Array<{ id: string; status: "pass" | "fail"; message: string }> }
async function request<T>(fetcher: typeof fetch, token: string, method = "GET", body?: unknown): Promise<T> { const response = await fetcher("/api/instance/upgrade", { method, headers: { authorization: `Bearer ${token}`, ...(body ? { "content-type": "application/json" } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
  const value = await response.json() as T & { message?: string }; if (!response.ok) throw new Error(value.message ?? "Upgrade operation failed."); return value; }

export function InstanceUpgradeAdministration({ fetcher = fetch }: { fetcher?: typeof fetch }) {
  const session = useInstanceAdminSession("instance-upgrade-plan"); const { token } = session;
  const [confirmation, setConfirmation] = useState(""); const feedback = useRef<HTMLDivElement>(null);
  const page = useRef<HTMLElement>(null);
  const plan = useQuery({ queryKey: ["instance-upgrade-plan", token], enabled: Boolean(token), retry: false, queryFn: () => request<Plan>(fetcher, token) });
  const upgrade = useMutation({ mutationFn: (targetVersion: string) => request<{ status: string; restartRequired: boolean }>(fetcher, token, "POST", { confirmation: targetVersion }) });
  useEffect(() => { if (upgrade.isError || upgrade.isSuccess || plan.isError) feedback.current?.focus(); }, [upgrade.isError, upgrade.isSuccess, plan.isError]);
  useGSAP(() => { if (!plan.data || window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) return;
    gsap.from(`.${styles.inventory}, .${styles.safety}`, { opacity: 0, y: 12, duration: .4, stagger: .08, ease: "power2.out", clearProps: "all" });
  }, { scope: page, dependencies: [plan.data?.status] });
  if (!token) return <InstanceAdminSignIn {...session} />;
  const ready = plan.data?.status === "ready"; const target = plan.data?.targetVersion ?? "the target version";
  return <main className={styles.page} ref={page}><InstanceAdminNavigation signOut={session.signOut} />
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
