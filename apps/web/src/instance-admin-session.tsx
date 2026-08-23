import { useQueryClient } from "@tanstack/react-query";
import { type FormEvent, useState } from "react";
import styles from "./instance-backup-administration.module.css";

const sessionKey = "stash.instance-admin-session";
function storedToken(): string { try { const value = JSON.parse(localStorage.getItem(sessionKey) ?? "null") as { token?: unknown }; return typeof value?.token === "string" ? value.token : ""; } catch { return ""; } }

export function useInstanceAdminSession(queryKey: string) {
  const queryClient = useQueryClient(); const [token, setToken] = useState(storedToken); const [draftToken, setDraftToken] = useState("");
  const authenticate = (event: FormEvent) => { event.preventDefault(); const next = draftToken.trim(); if (!next) return;
    localStorage.setItem(sessionKey, JSON.stringify({ token: next })); setToken(next); setDraftToken(""); };
  const signOut = () => { localStorage.removeItem(sessionKey); setToken(""); void queryClient.removeQueries({ queryKey: [queryKey] }); };
  return { token, draftToken, setDraftToken, authenticate, signOut };
}

export function InstanceAdminSignIn({ draftToken, setDraftToken, authenticate }: ReturnType<typeof useInstanceAdminSession>) {
  return <main className={styles.signIn}><section aria-labelledby="operator-title"><span className={styles.mark}>S</span><p className={styles.kicker}>Instance operations</p>
    <h1 id="operator-title">Administrator access</h1><p>Use the operator credential configured for this Instance. It never grants Workspace membership.</p>
    <form onSubmit={authenticate}><label htmlFor="operator-token">Instance Administrator token</label><input id="operator-token" type="password" autoComplete="current-password" value={draftToken} onChange={(event) => setDraftToken(event.target.value)} />
      <button type="submit" disabled={!draftToken.trim()}>Continue</button></form></section></main>;
}

export function InstanceAdminNavigation({ signOut }: { readonly signOut: () => void }) {
  return <nav className={styles.navigation} aria-label="Instance administration"><a href="/instance-admin/backups">Stash operations</a><button type="button" onClick={signOut}>Lock console</button></nav>;
}
