import { useMutation, useQuery } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";

import styles from "./project-browser.module.css";

interface ProjectSummary { readonly id: string; readonly name: string; readonly key: string }
interface ProjectCreationAllowed { readonly allowed: true }
interface ProjectCreationDenied { readonly allowed: false; readonly reason: string }
interface WorkspaceSummary {
  readonly id: string;
  readonly name: string;
  readonly projects: readonly ProjectSummary[];
  readonly projectCreation: ProjectCreationAllowed | ProjectCreationDenied;
}

interface ProjectBrowserProps {
  readonly token: string;
  readonly workspaceId?: string;
  readonly fetcher?: typeof fetch;
  readonly onOpenProject: (projectId: string) => void;
}

async function responseBody(response: Response) {
  return response.json().catch(() => ({})) as Promise<Record<string, unknown>>;
}

export function ProjectBrowser({ token, workspaceId, fetcher = fetch, onOpenProject }: ProjectBrowserProps) {
  const [creatingIn, setCreatingIn] = useState<WorkspaceSummary>();
  const [name, setName] = useState("");
  const [key, setKey] = useState("");
  const submitRef = useRef<HTMLButtonElement>(null);
  const nameRef = useRef<HTMLInputElement>(null);
  const dialogRef = useRef<HTMLElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const headers = { authorization: `Bearer ${token}` };
  const workspaces = useQuery({ queryKey: ["project-browser"], retry: false, queryFn: async () => {
    const response = await fetcher("/api/workspaces", { headers });
    const body = await responseBody(response) as { workspaces?: WorkspaceSummary[]; message?: string };
    if (!response.ok || !Array.isArray(body.workspaces)) throw new Error(body.message || "Projects could not be loaded.");
    return body.workspaces;
  } });
  const visibleWorkspaces = workspaceId
    ? workspaces.data?.filter((workspace) => workspace.id === workspaceId)
    : workspaces.data;
  const create = useMutation({ mutationFn: async () => {
    if (!creatingIn) throw new Error("Choose a Workspace first.");
    const response = await fetcher(`/api/workspaces/${encodeURIComponent(creatingIn.id)}/projects`, {
      method: "POST", headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify({ name: name.trim(), key: key.trim().toUpperCase() }),
    });
    const body = await responseBody(response) as { id?: string; message?: string };
    if (!response.ok || !body.id) throw new Error(body.message || "The Project could not be created.");
    return body.id;
  }, onSuccess: (projectId) => onOpenProject(projectId), onError: () => requestAnimationFrame(() => submitRef.current?.focus()) });

  useEffect(() => { if (creatingIn) requestAnimationFrame(() => nameRef.current?.focus()); }, [creatingIn]);
  const close = () => {
    if (create.isPending) return;
    const trigger = triggerRef.current;
    setCreatingIn(undefined); setName(""); setKey(""); create.reset();
    requestAnimationFrame(() => trigger?.focus());
  };
  const keepDialogFocus = (event: React.KeyboardEvent<HTMLElement>) => {
    if (event.key === "Escape") { event.preventDefault(); close(); return; }
    if (event.key !== "Tab") return;
    const focusable = [...(dialogRef.current?.querySelectorAll<HTMLElement>(
      'button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
    ) ?? [])].filter((element) => !element.hidden);
    const first = focusable[0]; const last = focusable.at(-1);
    if (!first || !last) { event.preventDefault(); dialogRef.current?.focus(); }
    else if (event.shiftKey && event.target === first) { event.preventDefault(); last.focus(); }
    else if (!event.shiftKey && event.target === last) { event.preventDefault(); first.focus(); }
  };

  return <section className={styles.page} aria-labelledby="projects-title">
    <header className={styles.header}>
      <div><p>Work planning</p><h1 id="projects-title">Projects</h1></div>
      <p>Add a Project when related Tasks need an optional execution context and shared Workflow.</p>
    </header>
    {workspaces.isPending ? <p className={styles.state} aria-live="polite">Loading Projects…</p>
      : workspaces.isError ? <div className={styles.state} role="alert"><strong>Projects are unavailable.</strong><p>{workspaces.error.message}</p><button type="button" onClick={() => void workspaces.refetch()}>Try again</button></div>
      : visibleWorkspaces?.length ? <div className={styles.workspaceGrid}>{visibleWorkspaces.map((workspace) => {
        const reasonId = `project-creation-${workspace.id}`;
        return <article className={styles.workspace} key={workspace.id}>
          <div className={styles.workspaceHeading}><div><span>Workspace</span><h2>{workspace.name}</h2></div>
            <button aria-describedby={workspace.projectCreation.allowed ? undefined : reasonId}
              disabled={!workspace.projectCreation.allowed} type="button"
              onClick={(event) => { triggerRef.current = event.currentTarget; setCreatingIn(workspace); create.reset(); }}>
              Create a Project in {workspace.name}
            </button></div>
          {!workspace.projectCreation.allowed ? <p className={styles.denial} id={reasonId}>{workspace.projectCreation.reason}</p> : null}
          {workspace.projects.length ? <ul className={styles.projects}>{workspace.projects.map((project) => <li key={project.id}>
            <button type="button" onClick={() => onOpenProject(project.id)}><strong>{project.name}</strong><span>{project.key}</span><span aria-hidden="true">Open →</span></button>
          </li>)}</ul> : <p className={styles.empty}>No Projects yet. {workspace.projectCreation.allowed ? "Create one when a body of work needs its own Workflow." : "Projects shared with you will appear here."}</p>}
        </article>;
      })}</div> : <p className={styles.state}>No accessible Workspaces.</p>}
    {creatingIn ? <div className={styles.backdrop} onMouseDown={(event) => { if (event.target === event.currentTarget) close(); }}>
      <section aria-describedby="create-project-description" aria-labelledby="create-project-title" aria-modal="true" className={styles.dialog}
        onKeyDown={keepDialogFocus} ref={dialogRef} role="dialog" tabIndex={-1}>
        <p className={styles.eyebrow}>{creatingIn.name}</p><h2 id="create-project-title">Create a Project</h2>
        <p id="create-project-description">Name the work and choose a short key for Tasks, such as STASH-12.</p>
        <form onSubmit={(event) => { event.preventDefault(); create.mutate(); }}>
          <label>Project name<input maxLength={200} ref={nameRef} required value={name} onChange={(event) => setName(event.target.value)} /></label>
          <label>Project key<input autoCapitalize="characters" maxLength={20} minLength={2} pattern="[A-Za-z][A-Za-z0-9]*" required value={key} onChange={(event) => setKey(event.target.value.toUpperCase())} /></label>
          {create.isError ? <p className={styles.error} role="alert">{create.error.message}</p> : null}
          <div className={styles.actions}><button disabled={create.isPending} type="button" onClick={close}>Cancel</button><button className={styles.primary} disabled={create.isPending} ref={submitRef} type="submit">{create.isPending ? "Creating…" : "Create Project"}</button></div>
        </form>
      </section>
    </div> : null}
  </section>;
}
