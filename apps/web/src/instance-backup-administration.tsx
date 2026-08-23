import * as Dialog from "@radix-ui/react-dialog";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useGSAP } from "@gsap/react";
import gsap from "gsap";
import { useEffect, useRef, useState } from "react";
import styles from "./instance-backup-administration.module.css";
import { InstanceAdminNavigation, InstanceAdminSignIn, useInstanceAdminSession } from "./instance-admin-session";

interface BackupSummary { readonly name: string; readonly schema?: string; readonly createdAt?: string; readonly verifiedAt?: string; readonly status?: "readable" | "invalid" }
function dateTime(value: string) {
  const date = new Date(value); return Number.isNaN(date.valueOf()) ? "Unknown time" : new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(date);
}
async function message(response: Response, fallback: string) {
  try { const value = await response.json() as { message?: unknown }; return typeof value.message === "string" ? value.message : fallback; }
  catch { return fallback; }
}

export function InstanceBackupAdministration({ fetcher = fetch }: { readonly fetcher?: typeof fetch }) {
  const session = useInstanceAdminSession("instance-backups"); const { token } = session;
  const [verified, setVerified] = useState<string>(); const [selected, setSelected] = useState<BackupSummary>(); const [confirmation, setConfirmation] = useState("");
  const pageRef = useRef<HTMLElement>(null); const feedbackRef = useRef<HTMLDivElement>(null);
  const headers = { authorization: `Bearer ${token}`, "content-type": "application/json" };
  const backups = useQuery({ queryKey: ["instance-backups", token], enabled: Boolean(token), retry: false, queryFn: async () => {
    const response = await fetcher("/api/instance/backups", { headers });
    if (!response.ok) throw new Error(await message(response, "Instance Backups could not be loaded."));
    const value = await response.json() as { backups?: unknown }; if (!Array.isArray(value.backups)) throw new Error("The Instance returned an invalid backup list.");
    return value.backups as BackupSummary[];
  } });
  const operation = useMutation({ mutationFn: async ({ backup, dryRun }: { backup: BackupSummary; dryRun: boolean }) => {
    const response = await fetcher(`/api/instance/backups/${encodeURIComponent(backup.name)}/restore`, { method: "POST", headers,
      body: JSON.stringify(dryRun ? { dryRun: true } : { dryRun: false, confirmation }) });
    if (!response.ok) throw new Error(await message(response, dryRun ? "Verification failed. No Instance data was changed." : "Restore failed."));
    return { backup, dryRun };
  }, onSuccess: ({ backup, dryRun }) => { if (dryRun) setVerified(backup.name); else { setSelected(undefined); setConfirmation(""); } },
  onError: () => { setSelected(undefined); setConfirmation(""); } });
  useEffect(() => { if (backups.isError || operation.isSuccess || operation.isError) feedbackRef.current?.focus(); },
    [backups.isError, operation.isSuccess, operation.isError]);
  useGSAP(() => { if (!backups.data?.length || window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) return;
    gsap.from(`.${styles.backup}`, { opacity: 0, y: 12, duration: .4, stagger: .06, ease: "power2.out", clearProps: "all" });
  }, { scope: pageRef, dependencies: [backups.data?.length] });
  if (!token) return <InstanceAdminSignIn {...session} />;
  return <main className={styles.page} ref={pageRef}>
    <InstanceAdminNavigation signOut={session.signOut} />
    <header className={styles.header}><div><p className={styles.kicker}>Disaster recovery</p><h1>Restore with evidence, not hope.</h1></div>
      <p>Verification reads every signed manifest entry, checksum, master-key requirement, and runtime constraint. Only a passing dry-run unlocks restore in this console.</p></header>
    <section className={styles.safety} aria-labelledby="safety-title"><div><h2 id="safety-title">The safe sequence</h2><p>Verify, inspect the result, then type the exact backup name. Restore snapshots the current database and stages Attachments before changing either.</p></div>
      <dl><div><dt>Database</dt><dd>Single transaction</dd></div><div><dt>Attachments</dt><dd>Atomic swap</dd></div><div><dt>Failure</dt><dd>Rollback attempted</dd></div></dl></section>
    {backups.isPending ? <p className={styles.loading} aria-live="polite">Reading backup manifests…</p> : null}
    {backups.isError ? <div className={styles.error} role="alert" tabIndex={-1} ref={feedbackRef}><p>{backups.error.message}</p><button type="button" onClick={() => void backups.refetch()}>Try again</button></div> : null}
    {operation.isError ? <div className={styles.error} role="alert" tabIndex={-1} ref={feedbackRef}>{operation.error.message}</div> : null}
    {operation.isSuccess ? <div className={styles.success} role="status" tabIndex={-1} ref={feedbackRef}>{operation.data.dryRun
      ? <><strong>{operation.data.backup.name}</strong> passed every preflight check. Restore is now available for this verified selection.</>
      : <><strong>{operation.data.backup.name}</strong> restored successfully. Re-authenticate and validate the Instance before reopening access.</>}</div> : null}
    {backups.data?.length === 0 ? <section className={styles.empty}><h2>No published backups</h2><p>Create a coordinated Instance Backup or check the configured backup directory.</p></section> : null}
    {backups.data?.length ? <section className={styles.inventory} aria-labelledby="inventory-title"><div className={styles.inventoryHeading}><h2 id="inventory-title">Available restore points</h2><p>Select deliberately. Newer is not always the correct recovery point.</p></div><ul>{backups.data.map((backup) => <li className={styles.backup} key={backup.name}>
      <div><h3>{backup.name}</h3><p>{backup.createdAt ? `Created ${dateTime(backup.createdAt)}` : "Manifest details unavailable"}</p><small>{backup.verifiedAt ? `Last verified ${dateTime(backup.verifiedAt)}` : "Not yet verified"}{backup.schema ? ` · ${backup.schema}` : " · Select Verify for a precise diagnosis"}</small></div>
      <div className={styles.actions}><button type="button" disabled={operation.isPending} onClick={() => { operation.reset(); setVerified(undefined); operation.mutate({ backup, dryRun: true }); }}>Verify {backup.name}</button>
        <button className={styles.danger} type="button" disabled={verified !== backup.name || operation.isPending} onClick={() => { setSelected(backup); setConfirmation(""); operation.reset(); }}>Restore {backup.name}</button></div>
    </li>)}</ul></section> : null}
    <Dialog.Root open={Boolean(selected)} onOpenChange={(open) => { if (!open) { setSelected(undefined); setConfirmation(""); } }}><Dialog.Portal><Dialog.Overlay className={styles.overlay} /><Dialog.Content className={styles.dialog}>
      <Dialog.Title>Replace the current Instance state?</Dialog.Title><Dialog.Description>This changes accounts, identity links, permissions, configuration, audit history, credentials, Workspaces, and Attachments. Active sessions may stop working.</Dialog.Description>
      <label htmlFor="restore-confirmation">Type {selected?.name} to confirm</label><input id="restore-confirmation" autoComplete="off" value={confirmation} onChange={(event) => setConfirmation(event.target.value)} />
      <div className={styles.dialogActions}><Dialog.Close asChild><button type="button">Cancel</button></Dialog.Close><button className={styles.danger} type="button" disabled={!selected || confirmation !== selected.name || operation.isPending} onClick={() => selected && operation.mutate({ backup: selected, dryRun: false })}>Restore Instance</button></div>
    </Dialog.Content></Dialog.Portal></Dialog.Root>
  </main>;
}
