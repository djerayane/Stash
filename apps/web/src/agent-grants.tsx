import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import styles from "./agent-grants.module.css";

type Mode = "direct" | "propose" | "deny";
interface Grant { id: string; name: string; scopes: Array<{ capability: string; mode: Mode }>; expiresAt: string; revokedAt?: string }

async function request<T>(url: string, token: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, { ...init, headers: { authorization: `Bearer ${token}`, ...(init?.body ? { "content-type": "application/json" } : {}) } });
  const body = await response.json() as T & { message?: string };
  if (!response.ok) throw new Error(body.message ?? "Agent Grants are temporarily unavailable.");
  return body;
}

export function AgentGrantsPage({ organizationId, token }: { readonly organizationId?: string; readonly token?: string }) {
  const queryClient = useQueryClient(); const [name, setName] = useState(""); const [mode, setMode] = useState<Mode>("propose");
  const [credential, setCredential] = useState<string>(); const credentialRef = useRef<HTMLDivElement>(null); const errorRef = useRef<HTMLParagraphElement>(null);
  const endpoint = `/api/organizations/${encodeURIComponent(organizationId ?? "")}/agent-grants`;
  const grants = useQuery({ queryKey: ["agent-grants", organizationId], enabled: Boolean(organizationId && token), retry: false,
    queryFn: () => request<{ grants: Grant[] }>(endpoint, token!) });
  const create = useMutation({ mutationFn: () => request<{ token: string }>(endpoint, token!, { method: "POST", body: JSON.stringify({ organizationId, name,
      expiresAt: new Date(Date.now() + 30 * 86_400_000).toISOString(), scopes: [{ capability: "workspace.read", mode: "direct" }, { capability: "note.write", mode }] }) }),
    onSuccess: async ({ token: newToken }) => { setCredential(newToken); setName(""); await queryClient.invalidateQueries({ queryKey: ["agent-grants", organizationId] }); } });
  const revoke = useMutation({ mutationFn: (id: string) => request(`${endpoint}/${encodeURIComponent(id)}`, token!, { method: "DELETE" }),
    onSuccess: async () => { await queryClient.invalidateQueries({ queryKey: ["agent-grants", organizationId] }); } });
  useEffect(() => { if (credential) credentialRef.current?.focus(); }, [credential]);
  useEffect(() => { if (grants.isError || create.isError || revoke.isError) errorRef.current?.focus(); }, [grants.isError, create.isError, revoke.isError]);
  if (!organizationId || !token) return <p className={styles.alert} role="alert">Agent Grants require an Organization membership.</p>;
  const error = grants.error ?? create.error ?? revoke.error;
  return <article className={styles.page} aria-labelledby="agent-grants-title">
    <header className={styles.header}><p className={styles.kicker}>External agents</p><h1 id="agent-grants-title">Agent access, kept deliberate</h1>
      <p>Issue a short-lived, revocable credential. Propose mode keeps every write behind your review.</p></header>
    <section className={styles.composer} aria-labelledby="new-grant"><div><h2 id="new-grant">Pair an agent</h2><p>The credential appears once. Store it in the agent client, never in a Note.</p></div>
      <form onSubmit={(event) => { event.preventDefault(); setCredential(undefined); create.mutate(); }}>
        <label>Agent name<input required maxLength={80} value={name} onChange={(event) => setName(event.target.value)} placeholder="Research assistant" /></label>
        <label>Write policy<select value={mode} onChange={(event) => setMode(event.target.value as Mode)}><option value="propose">Propose for review</option><option value="direct">Apply directly</option><option value="deny">Read only</option></select></label>
        <button type="submit" disabled={create.isPending}>{create.isPending ? "Issuing…" : "Issue Agent Grant"}</button>
      </form>
    </section>
    {credential ? <section className={styles.credential} ref={credentialRef} tabIndex={-1} aria-labelledby="credential-title"><h2 id="credential-title">Copy this credential now</h2>
      <p>It cannot be shown again.</p><code>{credential}</code><button type="button" onClick={() => navigator.clipboard.writeText(credential)}>Copy credential</button></section> : null}
    {error ? <p className={styles.alert} ref={errorRef} role="alert" tabIndex={-1}>{error.message} <button type="button" onClick={() => { create.reset(); revoke.reset(); void grants.refetch(); }}>Try again</button></p> : null}
    <section className={styles.list} aria-labelledby="active-grants"><div><h2 id="active-grants">Your Agent Grants</h2><p>Revocation takes effect before the next MCP request.</p></div>
      {grants.isPending ? <p aria-live="polite">Loading Agent Grants…</p> : grants.data?.grants.length ? <ul>{grants.data.grants.map((grant) => <li key={grant.id}>
        <div><strong>{grant.name}</strong><small>{grant.scopes.map(({ capability, mode: scopeMode }) => `${capability}: ${scopeMode}`).join(" · ")}</small><small>Expires {new Date(grant.expiresAt).toLocaleDateString()}</small></div>
        <button type="button" disabled={Boolean(grant.revokedAt) || revoke.isPending} onClick={() => revoke.mutate(grant.id)}>{grant.revokedAt ? "Revoked" : "Revoke"}</button></li>)}</ul>
      : <p>No agents can access this Organization.</p>}
    </section>
  </article>;
}
