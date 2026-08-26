import { useGSAP } from "@gsap/react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import gsap from "gsap";
import { useEffect, useRef, type FormEvent } from "react";
import { Link, useParams } from "react-router";
import styles from "./task-detail.module.css";

interface TaskDetail {
  readonly id: string;
  readonly key: string;
  readonly title: string;
  readonly status: { readonly name: string };
  readonly assigneeIds: readonly string[];
  readonly formerAssigneeIds?: readonly string[];
  readonly priority?: string; readonly labelNames?: readonly string[]; readonly linkedNoteIds?: readonly string[]; readonly dueDate?: string; readonly estimate?: number;
}

function isTaskDetail(value: unknown): value is TaskDetail {
  if (!value || typeof value !== "object") return false;
  const task = value as Partial<TaskDetail>;
  return typeof task.id === "string" && typeof task.key === "string" && typeof task.title === "string" && typeof task.status?.name === "string"
    && Array.isArray(task.assigneeIds) && task.assigneeIds.every((id) => typeof id === "string")
    && (task.formerAssigneeIds === undefined || Array.isArray(task.formerAssigneeIds)
      && task.formerAssigneeIds.every((id) => typeof id === "string"));
}

async function readTask(token: string, projectId: string, taskKey: string): Promise<TaskDetail> {
  const response = await fetch(`/api/projects/${encodeURIComponent(projectId)}/tasks/${encodeURIComponent(taskKey)}`, {
    headers: { authorization: `Bearer ${token}` },
  });
  if (!response.ok) throw new Error("This Task could not be loaded.");
  const payload: unknown = await response.json();
  const task = payload && typeof payload === "object" ? (payload as { task?: unknown }).task : undefined;
  if (!isTaskDetail(task)) throw new Error("The Instance returned an invalid Task.");
  return task;
}

export function TaskDetailPage({ memberId, token }: { readonly memberId?: string; readonly token?: string }) {
  const { projectId = "", taskKey = "" } = useParams();
  const queryClient = useQueryClient();
  const markerRef = useRef<HTMLLIElement>(null);
  const planErrorRef = useRef<HTMLParagraphElement>(null);
  const queryKey = ["task", projectId, taskKey, token] as const;
  const taskQuery = useQuery({ queryKey, enabled: Boolean(token && projectId && taskKey), retry: false,
    queryFn: () => readTask(token!, projectId, taskKey) });
  const task = taskQuery.data;
  const departed = task?.formerAssigneeIds ?? [];
  const clearAssignment = useMutation({
    mutationFn: async () => {
      const response = await fetch(`/api/projects/${encodeURIComponent(projectId)}/tasks/${encodeURIComponent(taskKey)}`, {
        method: "PATCH", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify({ assigneeIds: [...new Set([
          ...task!.assigneeIds.filter((id) => !departed.includes(id)), memberId!,
        ])] }),
      });
      if (!response.ok) throw new Error("The Task could not be reassigned. Try again.");
      const payload = await response.json() as { task?: unknown };
      if (!isTaskDetail(payload.task)) throw new Error("The Instance returned an invalid Task.");
      return payload.task;
    },
    onSuccess: (nextTask) => queryClient.setQueryData(queryKey, nextTask),
  });
  const sourceBlocks = useQuery({ queryKey: ["task-source-blocks", task?.id], enabled: Boolean(task?.id), retry: false, queryFn: async () => { const response = await fetch(`/api/tasks/${encodeURIComponent(task!.id)}/source-blocks`, { headers: { authorization: `Bearer ${token}` } }); if (!response.ok) throw new Error("Source Notes could not be loaded."); return response.json() as Promise<{ sourceBlocks: Array<{ noteId: string; blockId: string; state: string }> }>; } });
  const plan = useMutation({ mutationFn: async (changes: Record<string, unknown>) => { const response = await fetch(`/api/projects/${encodeURIComponent(projectId)}/tasks/${encodeURIComponent(taskKey)}`, { method: "PATCH", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify(changes) }); const body = await response.json() as { task?: unknown; message?: string }; if (!response.ok || !isTaskDetail(body.task)) throw new Error(body.message || "The Task plan could not be saved."); return body.task; }, onSuccess: (nextTask) => queryClient.setQueryData(queryKey, nextTask) });
  useEffect(() => { if (plan.isError) planErrorRef.current?.focus(); }, [plan.isError]);
  const submitPlan = (event: FormEvent<HTMLFormElement>) => { event.preventDefault(); const data = new FormData(event.currentTarget); const list = (name: string) => String(data.get(name) || "").split(",").map((value) => value.trim()).filter(Boolean); const estimate = String(data.get("estimate") || ""); plan.mutate({ title: String(data.get("title") || ""), priority: String(data.get("priority") || "none"), labelNames: list("labels"), assigneeIds: list("assignees"), linkedNoteIds: list("notes"), dueDate: String(data.get("dueDate") || "") || null, estimate: estimate ? Number(estimate) : null }); };
  useGSAP(() => {
    if (!markerRef.current || window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) return;
    gsap.from(markerRef.current, { opacity: 0, y: 8, duration: .35, ease: "power2.out", clearProps: "all" });
  }, { dependencies: [departed.join(":")] });

  if (!token || taskQuery.isPending) return <div className={styles.taskPage} aria-busy="true"><p>Loading Task…</p></div>;
  if (taskQuery.isError || !task) return <div className={styles.taskPage}><p className={styles.error} role="alert">{taskQuery.error?.message ?? "This Task could not be loaded."}</p></div>;
  return <article className={styles.taskPage} aria-labelledby="task-title">
    <header className={styles.taskHeader}>
      <div><p className={styles.taskKey}>{task.key}</p><h1 id="task-title">{task.title}</h1></div>
      <div><span className={styles.status}>{task.status.name}</span><Link to={`/app/projects/${encodeURIComponent(projectId)}/notifications`}>Notification settings</Link></div>
    </header>
    <section className={styles.assignmentPanel} aria-labelledby="assignment-title">
      <div><h2 id="assignment-title">Assignment</h2><p>Ownership stays visible when a Member leaves, so responsibility never disappears silently.</p></div>
      <div>
        {departed.length ? <ul className={styles.assigneeList}>{departed.map((id, index) => <li className={styles.departedMarker} key={id} ref={index === 0 ? markerRef : undefined}>
          <span role="status"><strong>Departed Member — assignment needs attention</strong><small>Former assignee · {id}</small></span>
          <button className={styles.clearButton} type="button" disabled={!memberId || clearAssignment.isPending} onClick={() => clearAssignment.mutate()}>Assign to me</button>
        </li>)}</ul> : <p>{memberId && task.assigneeIds.includes(memberId) ? "Assigned to you" : "No assignee"}</p>}
        {clearAssignment.isError ? <p className={styles.error} role="alert">{clearAssignment.error.message}</p> : null}
      </div>
    </section>
    <section className={styles.assignmentPanel} aria-labelledby="planning-title"><div><h2 id="planning-title">Plan this Task</h2><p>Canonical properties stay synchronized with Boards, Notes, and development work.</p></div><form className={styles.planningForm} onSubmit={submitPlan}><label>Title<input name="title" required defaultValue={task.title} /></label><label>Priority<select name="priority" defaultValue={task.priority || "none"}>{["none", "low", "medium", "high", "urgent"].map((value) => <option key={value}>{value}</option>)}</select></label><label>Labels<input name="labels" defaultValue={task.labelNames?.join(", ")} /></label><label>Assignee IDs<input name="assignees" defaultValue={task.assigneeIds.join(", ")} /></label><label>Linked Note IDs<input name="notes" defaultValue={task.linkedNoteIds?.join(", ")} /></label><label>Due date<input name="dueDate" type="date" defaultValue={task.dueDate} /></label><label>Estimate<input name="estimate" defaultValue={task.estimate} /></label><button className={styles.clearButton} disabled={plan.isPending} type="submit">{plan.isPending ? "Saving…" : "Save Task plan"}</button>{plan.isError ? <p className={styles.error} ref={planErrorRef} role="alert" tabIndex={-1}>{plan.error.message}</p> : null}</form></section>
    <section className={styles.assignmentPanel} aria-labelledby="sources-title"><div><h2 id="sources-title">Source Notes</h2><p>Durable Block relationships remain visible even when a source needs repair.</p></div>{sourceBlocks.isError ? <p className={styles.error} role="alert">{sourceBlocks.error.message}</p> : sourceBlocks.data?.sourceBlocks.length ? <ul>{sourceBlocks.data.sourceBlocks.map((source) => <li key={`${source.noteId}:${source.blockId}`}><Link to={`/app/notes/${source.noteId}`}>Note {source.noteId}</Link> · {source.state}</li>)}</ul> : <p>No source Blocks are linked.</p>}</section>
  </article>;
}
