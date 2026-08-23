import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import type { OrganizationAdministration } from "./member-administration";
import styles from "./imported-identities.module.css";

interface ImportedIdentity { readonly importId: string; readonly workspaceId: string; readonly workspaceName: string; readonly sourceAccountId: string; readonly displayName: string }

export function ImportedIdentitiesPage({ token, administrations }: { readonly token?: string; readonly administrations?: readonly OrganizationAdministration[] }) {
  const queryClient = useQueryClient();
  const [selection, setSelection] = useState<Record<string, string>>({});
  const statusRef = useRef<HTMLDivElement>(null);
  const query = useQuery({
    queryKey: ["imported-identities", token], enabled: Boolean(token), retry: false,
    queryFn: async () => {
      const response = await fetch("/api/imported-identities", { headers: { authorization: `Bearer ${token}` } });
      if (!response.ok) throw new Error(response.status === 403 ? "Import administration permission is required." : "Imported identities could not be loaded.");
      return (await response.json() as { identities: ImportedIdentity[] }).identities;
    },
  });
  const members = [...new Map((administrations ?? []).flatMap(({ members }) => members).map((member) => [member.id, member])).values()];
  const mapping = useMutation({
    mutationFn: async (identity: ImportedIdentity) => {
      const localAccountId = selection[identity.sourceAccountId];
      if (!localAccountId) throw new Error("Choose a local Member before confirming the mapping.");
      const response = await fetch("/api/imported-identity-mappings", { method: "POST", headers: {
        authorization: `Bearer ${token}`, "content-type": "application/json", "idempotency-key": crypto.randomUUID(),
      }, body: JSON.stringify({ importId: identity.importId, sourceAccountId: identity.sourceAccountId, localAccountId }) });
      if (!response.ok) throw new Error(response.status === 409 ? "This Identity Stub was already mapped differently. Reload before trying again."
        : response.status === 403 ? "Import administration permission is required." : "The mapping could not be completed. No attribution was changed.");
      return { identity, member: members.find(({ id }) => id === localAccountId)! };
    },
    onSuccess: async () => { await queryClient.invalidateQueries({ queryKey: ["imported-identities", token] }); },
  });
  useEffect(() => { if (mapping.isSuccess || mapping.isError) statusRef.current?.focus(); }, [mapping.isSuccess, mapping.isError]);
  if (!token || !administrations?.length) return <div className={styles.page}><p className={styles.error} role="alert">Import administration is unavailable for this account.</p></div>;
  return <article className={styles.page} aria-labelledby="identity-title">
    <header className={styles.header}><p className={styles.kicker}>Portable attribution</p><h1 id="identity-title">Reconnect imported people.</h1>
      <p>Identity Stubs preserve the name recorded by another Instance. Map one only when you can verify the matching local Member.</p></header>
    {query.isPending ? <p className={styles.loading} aria-live="polite">Loading unresolved identities…</p> : null}
    {query.isError ? <div className={styles.error} role="alert" tabIndex={-1} ref={statusRef}><p>{query.error.message}</p><button type="button" onClick={() => void query.refetch()}>Try again</button></div> : null}
    {mapping.isSuccess ? <div className={styles.success} role="status" tabIndex={-1} ref={statusRef}><strong>{mapping.data.identity.displayName}</strong> now resolves to {mapping.data.member.name}. Original imported provenance remains preserved.</div> : null}
    {mapping.isError ? <div className={styles.error} role="alert" tabIndex={-1} ref={statusRef}>{mapping.error.message}</div> : null}
    {query.data?.length === 0 ? <section className={styles.empty}><h2>No unresolved Identity Stubs</h2><p>Every imported person visible to you has been reviewed.</p></section> : null}
    {query.data?.length ? <ul className={styles.identities}>{query.data.map((identity) => <li key={`${identity.importId}:${identity.sourceAccountId}`}>
      <div><small>{identity.workspaceName}</small><h2>{identity.displayName}</h2><p>Imported attribution remains attached to this Identity Stub until you confirm a local match.</p></div>
      <form onSubmit={(event) => { event.preventDefault(); mapping.reset(); mapping.mutate(identity); }}>
        <label htmlFor={`member-${identity.sourceAccountId}`}>Local Member</label>
        <select id={`member-${identity.sourceAccountId}`} value={selection[identity.sourceAccountId] ?? ""} onChange={(event) => setSelection((current) => ({ ...current, [identity.sourceAccountId]: event.target.value }))}>
          <option value="">Choose a verified Member</option>{members.map((member) => <option key={member.id} value={member.id}>{member.name} · {member.email}</option>)}
        </select>
        <button type="submit" disabled={mapping.isPending || !selection[identity.sourceAccountId]}>{mapping.isPending ? "Mapping…" : "Confirm mapping"}</button>
      </form>
    </li>)}</ul> : null}
  </article>;
}
