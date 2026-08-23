import { directAuthorityConfirmation, type CreateAgentGrantRequest } from "@stash/domain-types";
import { useEffect, useRef, useState } from "react";
import { useGSAP } from "@gsap/react";
import gsap from "gsap";
import { DirectAuthorityDialog, expiry, GrantComposer, GrantList, ProposalQueue } from "./agent-grant-components";
import styles from "./agent-grants.module.css";
import { useAgentGrants } from "./use-agent-grants";

export function AgentGrantsPage({ organizationId: initialOrganizationId, token }: { readonly organizationId?: string; readonly token?: string }) {
  const [input, setInput] = useState<CreateAgentGrantRequest>({ organizationId: initialOrganizationId ?? "", name: "", expiresAt: expiry(7), scopes: [{ capability: "note.read", mode: "direct" }] });
  const [credential, setCredential] = useState<string>(); const [confirming, setConfirming] = useState(false); const [copyStatus, setCopyStatus] = useState<"success" | "error">();
  const pageRef = useRef<HTMLElement>(null); const credentialRef = useRef<HTMLElement>(null); const feedbackRef = useRef<HTMLParagraphElement>(null); const api = useAgentGrants(token, input.organizationId);
  useEffect(() => { const first = api.options.data?.organizations[0]; if (!input.organizationId && first) setInput((current) => ({ ...current, organizationId: first.organizationId })); }, [api.options.data, input.organizationId]);
  const organization = api.options.data?.organizations.find((candidate) => candidate.organizationId === input.organizationId);
  const error = api.options.error ?? api.grants.error ?? api.proposals.error ?? api.create.error ?? api.revoke.error;
  useEffect(() => { if (credential) credentialRef.current?.focus(); }, [credential]); useEffect(() => { if (error || copyStatus) feedbackRef.current?.focus(); }, [error, copyStatus]);
  useGSAP(() => { if (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) return;
    gsap.from("header > *, section", { opacity: 0, y: 7, duration: .32, stagger: .025, ease: "power2.out", clearProps: "all" });
  }, { scope: pageRef, dependencies: [Boolean(credential), api.proposals.data?.proposals.length ?? -1] });
  if (!token) return <p className={styles.alert} role="alert">Agent Grants require an authenticated Organization Member.</p>;
  const hasDirectAuthority = input.scopes.some(({ mode }) => mode === "direct");
  const issue = (confirmed = false) => api.create.mutate({ ...input, ...(confirmed ? { directAuthorityConfirmation } : {}) }, { onSuccess: ({ token: newToken }) => { setCredential(newToken); setInput((current) => ({ ...current, name: "" })); setConfirming(false); } });
  return <article className={styles.page} ref={pageRef} aria-labelledby="agent-grants-title"><header className={styles.header}><p className={styles.kicker}>External agents</p><h1 id="agent-grants-title">Agent access, kept deliberate</h1><p>Choose the exact Organization, Project, capabilities, write policy, and lifetime. Propose mode keeps writes behind your review.</p></header>
    <GrantComposer input={input} organizations={api.options.data?.organizations ?? []} projects={organization?.projects ?? []} pending={api.create.isPending} confirmDirect={hasDirectAuthority} onChange={setInput} onSubmit={() => hasDirectAuthority ? setConfirming(true) : issue()} />
    <DirectAuthorityDialog open={confirming} scopes={input.scopes} onOpenChange={setConfirming} onConfirm={() => issue(true)} />
    {credential ? <section className={styles.credential} ref={credentialRef} tabIndex={-1} aria-labelledby="credential-title"><h2 id="credential-title">Copy this credential now</h2><p>It cannot be shown again. The credential remains selectable below for manual copy.</p><code>{credential}</code><button type="button" onClick={async () => { setCopyStatus(undefined); try { if (!navigator.clipboard?.writeText) throw new Error(); await navigator.clipboard.writeText(credential); setCopyStatus("success"); } catch { setCopyStatus("error"); } }}>Copy credential</button>{copyStatus ? <p className={copyStatus === "error" ? styles.copyError : styles.copySuccess} ref={feedbackRef} role={copyStatus === "error" ? "alert" : "status"} tabIndex={-1}>{copyStatus === "success" ? "Credential copied." : "Clipboard access was denied. Select the credential above and copy it manually."}</p> : null}</section> : null}
    {error ? <p className={styles.alert} ref={feedbackRef} role="alert" tabIndex={-1}>{error.message} <button type="button" onClick={() => { api.create.reset(); api.revoke.reset(); void api.options.refetch(); void api.grants.refetch(); void api.proposals.refetch(); }}>Try again</button></p> : null}
    <ProposalQueue proposals={api.proposals.data?.proposals} loading={api.proposals.isPending} /><GrantList grants={api.grants.data?.grants} pending={api.grants.isPending || api.revoke.isPending} onRevoke={(id) => api.revoke.mutate(id)} />
  </article>;
}
