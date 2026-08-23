import { useGSAP } from "@gsap/react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import gsap from "gsap";
import { useRef } from "react";
import { Link, useParams } from "react-router";
import styles from "./task-detail.module.css";

interface TaskDetail {
  readonly key: string;
  readonly title: string;
  readonly status: { readonly name: string };
  readonly assigneeIds: readonly string[];
  readonly formerAssigneeIds?: readonly string[];
}

function isTaskDetail(value: unknown): value is TaskDetail {
  if (!value || typeof value !== "object") return false;
  const task = value as Partial<TaskDetail>;
  return typeof task.key === "string" && typeof task.title === "string" && typeof task.status?.name === "string"
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
  </article>;
}
