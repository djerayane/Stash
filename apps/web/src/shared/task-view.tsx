import type { ViewDefinition } from "@stash/domain-types";
import type { ReactNode } from "react";

export interface TaskViewRecord { id:string;title:string;status:{id:string;name:string};assigneeIds:string[];projectKeys?:Array<{key:string}> }
export function evaluateTaskView<T extends TaskViewRecord>(tasks:readonly T[],definition:ViewDefinition){
  if(definition.source.kind!=="tasks")throw new Error("view_source_mismatch");
  const records=tasks.filter((task)=>definition.filters.every((filter)=>filter.propertyId!=="task:assignee"||
    filter.operator==="equals"&&task.assigneeIds.includes(String(filter.value))));
  return {records};
}
export function TaskView<T extends TaskViewRecord>({tasks,definition,statuses,onStatusChange,empty}:{tasks:readonly T[];definition:ViewDefinition;
  statuses?:readonly {id:string;name:string}[];onStatusChange?:(task:T,statusId:string)=>void;empty?:ReactNode}){
  const {records}=evaluateTaskView(tasks,definition);
  if(!records.length)return <>{empty??null}</>;
  const groups=statuses??[...new Map(records.map((task)=>[task.status.id,task.status])).values()];
  const row=(task:T)=><article data-task-row key={task.id}><span aria-hidden="true" data-task-check /><div><strong>{task.title}</strong><span>{task.projectKeys?.map(({key})=>key).join(" · ")||"No Project"}</span></div>
    {statuses&&onStatusChange?<label data-status-control><span>Status for {task.title}</span><i aria-hidden="true" /><select aria-label={`Status for ${task.title}`} value={task.status.id}
      onChange={(event)=>onStatusChange(task,event.target.value)}>{statuses.map((status)=><option key={status.id} value={status.id}>{status.name}</option>)}</select></label>
      :<span>{task.status.name}</span>}</article>;
  if(definition.presentation==="table")return <table><thead><tr><th>Task</th><th>Project</th><th>Status</th></tr></thead><tbody>{records.map((task)=><tr key={task.id}><td>{task.title}</td><td>{task.projectKeys?.map(({key})=>key).join(" · ")||"No Project"}</td><td>{statuses&&onStatusChange?<select aria-label={`Status for ${task.title}`} value={task.status.id} onChange={(event)=>onStatusChange(task,event.target.value)}>{statuses.map((status)=><option key={status.id} value={status.id}>{status.name}</option>)}</select>:task.status.name}</td></tr>)}</tbody></table>;
  if(definition.presentation==="board")return <div>{groups.map((status)=><section key={status.id}><h2>{status.name}</h2>{records.filter((task)=>task.status.id===status.id).map(row)}</section>)}</div>;
  if(definition.presentation==="calendar")return <div><h2>Unscheduled</h2>{records.map(row)}</div>;
  return <>{records.map(row)}</>;
}
