import { useMutation, useQuery } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";

import styles from "./project-browser.module.css";
import { Button, Field, StatusNotice } from "../ui/control";

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
  }, onSuccess: (projectId) => onOpenProject(projectId), onError: () => requestAnimationFrame(() => dialogRef.current?.querySelector<HTMLButtonElement>('button[type="submit"]')?.focus()) });

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
      <div><h1 id="projects-title">Projects</h1></div>
      <p>Add a Project when related Tasks need an optional execution context and shared Workflow.</p>
    </header>
    {workspaces.isPending ? <StatusNotice className={styles.state}>Loading Projects…</StatusNotice>
      : workspaces.isError ? <StatusNotice className={styles.state} tone="error"><strong>Projects are unavailable.</strong><p>{workspaces.error.message}</p><p>No Projects or drafts were changed. Try loading the list again.</p><Button type="button" variant="secondary" onClick={() => void workspaces.refetch()}>Try again</Button></StatusNotice>
      : visibleWorkspaces?.length ? <div className={styles.workspaceGrid}>{visibleWorkspaces.map((workspace) => {
        const reasonId = `project-creation-${workspace.id}`;
        return <article className={styles.workspace} key={workspace.id}>
          <div className={styles.workspaceHeading}><div><h2>{workspace.name}</h2></div>
            <Button aria-describedby={workspace.projectCreation.allowed ? undefined : reasonId}
              disabled={!workspace.projectCreation.allowed} type="button" variant="secondary"
              onClick={(event) => { triggerRef.current = event.currentTarget; setCreatingIn(workspace); create.reset(); }}>
              Create a Project in {workspace.name}
            </Button></div>
          {!workspace.projectCreation.allowed ? <StatusNotice className={styles.denial} id={reasonId} tone="attention">{workspace.projectCreation.reason}</StatusNotice> : null}
          {workspace.projects.length ? <ul className={styles.projects}>{workspace.projects.map((project) => <li key={project.id}>
            <Button type="button" variant="secondary" onClick={() => onOpenProject(project.id)}><strong>{project.name}</strong><span>{project.key}</span><span aria-hidden="true">Open →</span></Button>
          </li>)}</ul> : <p className={styles.empty}>No Projects yet. {workspace.projectCreation.allowed ? "Create one when a body of work needs its own Workflow." : "Projects shared with you will appear here."}</p>}
        </article>;
      })}</div> : <p className={styles.state}>No accessible Workspaces.</p>}
    {creatingIn ? <div className={styles.backdrop} onMouseDown={(event) => { if (event.target === event.currentTarget) close(); }}>
      <section aria-describedby="create-project-description" aria-labelledby="create-project-title" aria-modal="true" className={styles.dialog}
        onKeyDown={keepDialogFocus} ref={dialogRef} role="dialog" tabIndex={-1}>
        <h2 id="create-project-title">Create a Project</h2>
        <p id="create-project-description">Create it in {creatingIn.name}. Name the work and choose a short key for Tasks, such as STASH-12.</p>
        <form onSubmit={(event) => { event.preventDefault(); create.mutate(); }}>
          <Field label="Project name"><input maxLength={200} ref={nameRef} required value={name} onChange={(event) => setName(event.target.value)} /></Field>
          <Field label="Project key"><input autoCapitalize="characters" maxLength={20} minLength={2} pattern="[A-Za-z][A-Za-z0-9]*" required value={key} onChange={(event) => setKey(event.target.value.toUpperCase())} /></Field>
          {create.isError ? <StatusNotice tone="error"><strong>{create.error.message}</strong><p>Your Project name and key are preserved. Review the message and try again.</p></StatusNotice> : null}
          <div className={styles.actions}><Button disabled={create.isPending} type="button" variant="secondary" onClick={close}>Cancel</Button><Button pending={create.isPending} pendingLabel="Creating…" type="submit">Create Project</Button></div>
        </form>
      </section>
    </div> : null}
  </section>;
}
