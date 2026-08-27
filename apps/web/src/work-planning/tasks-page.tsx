import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";
import styles from "./tasks-page.module.css";
import { TaskView } from "../shared/task-view";

type Task = { id: string; title: string; status: { id: string; name: string; category: string }; assigneeIds: string[];
  projectKeys: Array<{ projectId: string; key: string }>; projectAssociations: string[]; parentTaskId?: string };
type Workflow = { statuses: Array<{ id: string; name: string; category: string; position: number }> };
async function request(fetcher: typeof fetch, token: string, path: string, init?: RequestInit) {
  const response = await fetcher(path, { ...init, headers: { authorization: `Bearer ${token}`, ...(init?.body ? { "content-type": "application/json" } : {}) } });
  const body = await response.json() as any; if (!response.ok) throw new Error(body.message || "Tasks could not be loaded."); return body;
}
export function TasksPage({ workspaceId, memberId, token, fetcher = globalThis.fetch }: { workspaceId: string; memberId: string; token: string; fetcher?: typeof fetch }) {
  const client = useQueryClient(); const [title, setTitle] = useState("");
  const storage=typeof localStorage!=="undefined"&&typeof localStorage.getItem==="function"?localStorage:undefined;
  const saved=storage?.getItem(`stash.tasks.definition.${workspaceId}.${memberId}`); let savedDefinition:any;
  try{savedDefinition=saved?JSON.parse(saved):undefined;}catch{savedDefinition=undefined;}
  const [view, setView] = useState<"list" | "board" | "table" | "calendar">(
    ["list","board","table","calendar"].includes(savedDefinition?.presentation)?savedDefinition.presentation:"list");
  const [mine, setMine] = useState<boolean>(savedDefinition?.filters?.some((filter:any)=>filter.propertyId==="task:assignee")??true);
  const query = useQuery({ queryKey: ["canonical-tasks", workspaceId], retry: false,
    queryFn: () => request(fetcher, token, `/api/workspaces/${encodeURIComponent(workspaceId)}/canonical-tasks`) as Promise<{ tasks: Task[]; workflow: Workflow }> });
  const create = useMutation({ mutationFn: () => request(fetcher, token, `/api/workspaces/${encodeURIComponent(workspaceId)}/canonical-tasks`,
    { method: "POST", body: JSON.stringify({ title }) }), onSuccess: async () => { setTitle(""); await client.invalidateQueries({ queryKey: ["canonical-tasks", workspaceId] }); } });
  const move = useMutation({ mutationFn: ({ id, statusId }: { id: string; statusId: string }) => request(fetcher, token,
    `/api/canonical-tasks/${encodeURIComponent(id)}`, { method: "PATCH", body: JSON.stringify({ statusId }) }),
    onSuccess: async () => client.invalidateQueries({ queryKey: ["canonical-tasks", workspaceId] }) });
  const definition = useMemo(() => ({ source: { kind: "tasks" as const,workspaceId,projectScope:"none" as const },presentation:view,
    filters: mine ? [{propertyId:"task:assignee",operator:"equals" as const,value:memberId}] : [],sorts:[],layout:{},
    ...(view === "board" ? {groupBy:"task:status"} : {}) }),[memberId,mine,view,workspaceId]);
  useEffect(()=>{storage?.setItem(`stash.tasks.definition.${workspaceId}.${memberId}`,JSON.stringify(definition));},[definition,memberId,storage,workspaceId]);
  return <div className={styles.page}><header><div><p className={styles.eyebrow}>Workspace work</p><h1>Tasks</h1>
    <p>One truthful list of action, whether work belongs to no Project, one Project, or several.</p></div>
    <form onSubmit={(event) => { event.preventDefault(); if (title.trim()) create.mutate(); }}><label htmlFor="new-task">New Task</label>
      <div><input id="new-task" maxLength={500} onChange={(event) => setTitle(event.target.value)} placeholder="What needs doing?" required value={title} />
      <button disabled={create.isPending}>{create.isPending ? "Creating…" : "Create Task"}</button></div></form></header>
    <nav aria-label="Task view"><button aria-pressed={mine} onClick={() => setMine((value) => !value)} type="button">{mine ? "My Tasks" : "All Tasks"}</button><span>View</span>{(["list", "board", "table", "calendar"] as const).map((item) => <button
      aria-pressed={view === item} key={item} onClick={() => setView(item)} type="button">{item[0]!.toUpperCase() + item.slice(1)}</button>)}</nav>
    {query.isPending ? <p role="status">Loading Tasks…</p> : query.isError ? <p role="alert">{query.error.message}</p>
      : <section aria-label={`${view} Task view`} className={styles.tasks} data-view={view}><TaskView tasks={query.data.tasks} definition={definition}
        statuses={query.data.workflow.statuses} onStatusChange={(task,statusId)=>move.mutate({id:task.id,statusId})}
        empty={<div className={styles.empty}><h2>A quiet place for action.</h2><p>Create a Projectless Task now; add execution contexts only when they help.</p></div>}/></section>}
    <p className={styles.srOnly} role="status">{move.isSuccess ? "Task status updated everywhere." : create.isSuccess ? "Task created." : ""}</p>
    {create.isError || move.isError ? <p role="alert">{(create.error || move.error)?.message}</p> : null}</div>;
}
