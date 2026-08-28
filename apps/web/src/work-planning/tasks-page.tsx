import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";
import styles from "./tasks-page.module.css";
import { TaskView } from "../shared/task-view";
import { Button, Field, StatusNotice } from "../ui/control";

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
  return <div className={styles.page}><header><div><h1>Tasks</h1>
    <p>One truthful list of action, whether work belongs to no Project, one Project, or several.</p></div>
    <form onSubmit={(event) => { event.preventDefault(); if (title.trim()) create.mutate(); }}><Field label="New Task">
      <input id="new-task" maxLength={500} onChange={(event) => setTitle(event.target.value)} placeholder="What needs doing?" required value={title} />
      </Field><Button pending={create.isPending} pendingLabel="Creating Task">Create Task</Button></form></header>
    <nav aria-label="Task controls"><details aria-label="Filters" className={styles.filterDisclosure} open role="group"><summary>Filters</summary><div className={styles.filters}><Button aria-pressed={mine} onClick={() => setMine((value) => !value)} type="button" variant="secondary">{mine ? "My Tasks" : "All Tasks"}</Button></div></details>
      <div aria-label="View" className={styles.viewControls} role="group"><span>View</span>{(["list", "board", "table", "calendar"] as const).map((item) => <Button
      aria-pressed={view === item} key={item} onClick={() => setView(item)} type="button" variant="secondary">{item[0]!.toUpperCase() + item.slice(1)}</Button>)}</div></nav>
    {query.isPending ? <StatusNotice>Loading Tasks…</StatusNotice> : query.isError ? <StatusNotice tone="error"><strong>Tasks are unavailable.</strong><p>{query.error.message}</p><p>Your Task view and draft are preserved. Try loading the same view again.</p><Button type="button" variant="secondary" onClick={() => void query.refetch()}>Try again</Button></StatusNotice>
      : <section aria-label={`${view} Task view`} className={styles.tasks} data-view={view}><TaskView tasks={query.data.tasks} definition={definition}
        statuses={query.data.workflow.statuses} onStatusChange={(task,statusId)=>move.mutate({id:task.id,statusId})}
        empty={<div className={styles.empty}><h2>A quiet place for action.</h2><p>Create a Projectless Task now; add execution contexts only when they help.</p></div>}/></section>}
    <p className={styles.srOnly} role="status">{move.isSuccess ? "Task status updated everywhere." : create.isSuccess ? "Task created." : ""}</p>
    {create.isError || move.isError ? <StatusNotice tone="error"><strong>{(create.error || move.error)?.message}</strong><p>Your Task view and draft are preserved. Try the action again.</p></StatusNotice> : null}</div>;
}
