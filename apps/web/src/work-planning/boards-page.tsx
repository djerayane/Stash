import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Link, useParams } from "react-router";

import styles from "../core-workflows.module.css";

type Fetcher = typeof fetch;
interface Task { readonly id: string; readonly key: string; readonly title: string }
interface BoardColumn { readonly id: string; readonly name: string; readonly archived: boolean; readonly tasks: readonly Task[] }
interface BoardResponse { readonly board: { readonly id: string; readonly name: string }; readonly columns: readonly BoardColumn[] }

async function request(fetcher: Fetcher, token: string, path: string, init?: RequestInit) {
  const response = await fetcher(path, { ...init, headers: { authorization: `Bearer ${token}`,
    ...(init?.body ? { "content-type": "application/json" } : {}), ...init?.headers } });
  const body = await response.json().catch(() => ({})) as { message?: string };
  if (!response.ok) throw new Error(body.message || "The Instance could not complete this request.");
  return body;
}

export function BoardsPage({ token, fetcher = globalThis.fetch }: { readonly token: string; readonly fetcher?: Fetcher }) {
  const { projectId = "", boardId } = useParams();
  const client = useQueryClient();
  const [moveStatus, setMoveStatus] = useState("");
  const boards = useQuery({ queryKey: ["boards", projectId], enabled: !boardId, retry: false,
    queryFn: () => request(fetcher, token, `/api/projects/${encodeURIComponent(projectId)}/boards`) as Promise<{ boards: { id: string; name: string }[] }> });
  const board = useQuery({ queryKey: ["board", projectId, boardId], enabled: Boolean(boardId), retry: false,
    queryFn: () => request(fetcher, token, `/api/projects/${encodeURIComponent(projectId)}/boards/${encodeURIComponent(boardId!)}`) as Promise<BoardResponse> });
  const move = useMutation({ mutationFn: ({ task, statusId }: { task: Task; statusId: string }) => request(fetcher, token,
    `/api/projects/${encodeURIComponent(projectId)}/boards/${encodeURIComponent(boardId!)}/tasks/${encodeURIComponent(task.key)}`,
    { method: "PATCH", body: JSON.stringify({ statusId }) }), onSuccess: async (_result, { task }) => {
      await client.invalidateQueries({ queryKey: ["board", projectId, boardId] });
      setMoveStatus(`${task.key} moved.`);
      requestAnimationFrame(() => document.querySelector<HTMLElement>(`[data-task-key="${CSS.escape(task.key)}"]`)?.focus());
    } });
  if (!boardId) return <div className={styles.page}><header className={styles.header}><div><h1>Workflow Boards</h1><p>Boards are views over the Project Workflow; Tasks remain canonical.</p></div></header>
    {boards.isPending ? <p role="status">Loading Boards…</p> : boards.isError ? <p role="alert">{boards.error.message}</p>
      : <div className={styles.boardIndex}>{boards.data.boards.map((item) => <Link key={item.id} to={`/app/projects/${projectId}/boards/${item.id}`}>{item.name}</Link>)}</div>}</div>;
  return <div className={styles.page}><header className={styles.header}><div><h1>{board.data?.board.name || "Workflow Board"}</h1><p>Move Tasks without changing their canonical identity.</p></div></header>
    {board.isPending ? <p role="status">Loading Board…</p> : board.isError ? <p role="alert">{board.error.message}</p> : <div className={styles.board}>{board.data.columns.map((column) => <section key={column.id}><h2>{column.name}<span>{column.tasks.length}</span></h2>{column.tasks.map((task) => <article key={task.id}><Link to={`/app/projects/${projectId}/tasks/${task.key}`}>{task.key}</Link><strong>{task.title}</strong><label>Move Task<span className={styles.srOnly}> {task.key}</span><select data-task-key={task.key} disabled={move.isPending} value={column.id} onChange={(event) => move.mutate({ task, statusId: event.target.value })}>{board.data.columns.filter((target) => !target.archived).map((target) => <option key={target.id} value={target.id}>{target.name}</option>)}</select></label></article>)}</section>)}</div>}
    <p className={styles.srOnly} role="status">{moveStatus}</p>{move.isError ? <p role="alert">{move.error.message}</p> : null}</div>;
}
