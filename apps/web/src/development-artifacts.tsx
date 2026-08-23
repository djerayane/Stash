import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createStashApiClient } from "@stash/api-client";
import { useState } from "react";

import styles from "./development-signals.module.css";

interface Connection { readonly id: string; readonly repositoryUrl: string }
interface Artifact { readonly kind: "branch" | "commit" | "pull_request"; readonly providerId: string; readonly url: string; readonly label: string }

export function DevelopmentArtifacts({ projectId, taskKey, fetcher, token }: { readonly projectId: string; readonly taskKey: string; readonly fetcher: typeof fetch; readonly token: string }) {
  const client = useQueryClient();
  const api = createStashApiClient({ baseUrl: "", fetch: fetcher, memberToken: token });
  const artifactsKey = ["development-artifacts", projectId, taskKey];
  const [connectionId, setConnectionId] = useState("");
  const [branchName, setBranchName] = useState("");
  const [kind, setKind] = useState<Artifact["kind"]>("branch");
  const [reference, setReference] = useState("");
  const connections = useQuery({ queryKey: ["repository-connections", projectId], retry: false, queryFn: async () =>
    (await api.get<{ repositoryConnections: Connection[] }>(`/api/projects/${encodeURIComponent(projectId)}/repository-connections`)).repositoryConnections });
  const artifacts = useQuery({ queryKey: artifactsKey, retry: false, queryFn: async () =>
    (await api.get<{ artifacts: Artifact[] }>(`/api/projects/${encodeURIComponent(projectId)}/tasks/${encodeURIComponent(taskKey)}/development-artifacts`)).artifacts });
  const create = useMutation({ mutationFn: async (selectedConnectionId: string) => api.post(`/api/projects/${encodeURIComponent(projectId)}/tasks/${encodeURIComponent(taskKey)}/development-artifacts`,
    { action: "create_branch", connectionId: selectedConnectionId, ...(branchName ? { branchName } : {}) }), onSuccess: async () => { setBranchName(""); await client.invalidateQueries({ queryKey: artifactsKey }); } });
  const link = useMutation({ mutationFn: async (selectedConnectionId: string) => api.post(`/api/projects/${encodeURIComponent(projectId)}/tasks/${encodeURIComponent(taskKey)}/development-artifacts`,
    { action: "link", connectionId: selectedConnectionId, kind, reference }), onSuccess: async () => { setReference(""); await client.invalidateQueries({ queryKey: artifactsKey }); } });
  const selected = connectionId || connections.data?.[0]?.id || "";

  return <section className={styles.artifacts} aria-labelledby="development-artifacts-title">
    <div className={styles.sectionHeading}><div><p className={styles.eyebrow}>GitHub artifacts</p><h2 id="development-artifacts-title">Build from this Task</h2></div><p>Create a traceable branch or link existing GitHub work without changing Task status.</p></div>
    {connections.isError || artifacts.isError ? <div className={styles.inlineError} role="alert">{connections.error?.message ?? artifacts.error?.message}<button type="button" onClick={() => { void connections.refetch(); void artifacts.refetch(); }}>Try again</button></div> : null}
    {connections.isPending || artifacts.isPending ? <p role="status">Loading GitHub artifacts…</p> : null}
    {connections.data?.length === 0 ? <div className={styles.artifactEmpty}><strong>No repository is attached to this Project.</strong><p>Ask an Organization administrator to attach an active Repository Connection.</p></div> : null}
    {connections.data?.length ? <>
      <label className={styles.field}>Repository<select aria-label="Repository" value={selected} onChange={(event) => setConnectionId(event.target.value)}>{connections.data.map((connection) => <option value={connection.id} key={connection.id}>{connection.repositoryUrl.replace(/^https:\/\/github\.com\//, "")}</option>)}</select></label>
      <div className={styles.artifactForms}>
        <form onSubmit={(event) => { event.preventDefault(); create.mutate(selected); }}><h3>Create a branch</h3><p>Leave the name blank to use a safe name derived from the Task.</p><label className={styles.field}>Branch name (optional)<input value={branchName} onChange={(event) => setBranchName(event.target.value)} placeholder={`${taskKey.toLowerCase()}-task-name`} /></label>{create.isError ? <p className={styles.inlineError} role="alert">{create.error.message}</p> : null}<button disabled={create.isPending || !selected} type="submit">{create.isPending ? "Creating…" : "Create branch"}</button></form>
        <form onSubmit={(event) => { event.preventDefault(); link.mutate(selected); }}><h3>Link existing work</h3><label className={styles.field}>Artifact type<select value={kind} onChange={(event) => setKind(event.target.value as Artifact["kind"])}><option value="branch">Branch</option><option value="commit">Commit</option><option value="pull_request">Pull request</option></select></label><label className={styles.field}>{kind === "pull_request" ? "Pull request number" : kind === "commit" ? "Commit SHA" : "Branch name"}<input required value={reference} onChange={(event) => setReference(event.target.value)} /></label>{link.isError ? <p className={styles.inlineError} role="alert">{link.error.message}</p> : null}<button disabled={link.isPending || !selected} type="submit">{link.isPending ? "Linking…" : "Link artifact"}</button></form>
      </div>
      <div className={styles.artifactList}><h3>Linked work</h3>{artifacts.data?.length ? <ul>{artifacts.data.map((artifact) => <li key={`${artifact.kind}:${artifact.providerId}`}><span>{artifact.kind.replace("_", " ")}</span><a href={artifact.url} target="_blank" rel="noreferrer">{artifact.label}</a></li>)}</ul> : <p>No GitHub artifacts are linked yet.</p>}</div>
    </> : null}
  </section>;
}
