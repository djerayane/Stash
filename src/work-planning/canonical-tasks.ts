export type StatusCategory = "unstarted" | "started" | "completed";
export interface WorkspaceWorkflow { schema: "stash.workspace-workflow.v1"; workspaceId: string;
  statuses: Array<{ id: string; name: string; category: StatusCategory; position: number }> }
export interface CanonicalTask {
  schema: "stash.task.v1"; id: string; workspaceId: string; title: string; description: string;
  status: WorkspaceWorkflow["statuses"][number]; assigneeIds: string[]; parentTaskId?: string;
  projectAssociations: string[]; projectKeys: Array<{ projectId: string; key: string }>;
  keyAliases: Array<{ projectId: string; key: string }>; sourceNoteIds: string[];
  sourceBlocks: Array<{ noteId: string; blockId: string }>;
  createdBy: { localAccountId: string; displayName: string }; createdAt: string;
}
export type TaskResult = { status: "created" | "updated"; task: CanonicalTask; audienceBroadenedProjectIds?: string[] }
  | { status: "audience_broadening"; projectIds: string[]; memberIds: string[]; impactToken: string }
  | { status: "workspace_not_found" | "task_not_found" | "invalid_reference" | "cycle" | "forbidden" };
export interface CanonicalTaskRepository {
  createTask(memberId: string, workspaceId: string, input: { title: string; description: string; parentTaskId?: string; projectIds: string[] }): Promise<TaskResult>;
  updateTask(memberId: string, taskId: string, input: { title?: string; description?: string; statusId?: string }): Promise<TaskResult>;
  associateTask(memberId: string, taskId: string, projectIds: string[], impactToken?: string): Promise<TaskResult>;
  setTaskParent(memberId: string, taskId: string, parentTaskId?: string): Promise<TaskResult>;
  resolveTaskKey(memberId: string, projectId: string, key: string): Promise<{ status: "found"; task: CanonicalTask } | { status: "task_not_found" }>;
  workspaceWorkflow(memberId: string, workspaceId: string): Promise<{ status: "found"; workflow: WorkspaceWorkflow } | { status: "workspace_not_found" }>;
  configureWorkflow(memberId: string, workspaceId: string, statuses: WorkspaceWorkflow["statuses"]): Promise<{ status: "updated"; workflow: WorkspaceWorkflow } | { status: "workspace_not_found" | "invalid_reference" }>;
  setProjectParent(memberId: string, projectId: string, parentProjectId?: string): Promise<{ status: "updated" } | { status: "project_not_found" | "invalid_reference" | "cycle" }>;
  listProjectTasks(memberId: string, projectId: string): Promise<{ status: "found"; tasks: CanonicalTask[] } | { status: "project_not_found" }>;
  listTasks(memberId: string, workspaceId: string): Promise<{ status: "found"; tasks: CanonicalTask[]; workflow: WorkspaceWorkflow } | { status: "workspace_not_found" }>;
}

export class InvalidCanonicalTaskInput extends Error {}
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const object = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === "object" && !Array.isArray(value);
function projects(value: unknown): string[] | undefined {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 100 || value.some((id) => typeof id !== "string" || !uuid.test(id))
    || new Set(value).size !== value.length) return undefined;
  return value;
}

export class CanonicalTaskService {
  constructor(private readonly repository: CanonicalTaskRepository) {}
  create(memberId: string, workspaceId: string, value: unknown) {
    if (!uuid.test(workspaceId) || !object(value) || typeof value.title !== "string" || !value.title.trim()
      || value.title.trim().length > 500 || value.description !== undefined && typeof value.description !== "string"
      || String(value.description ?? "").length > 20_000 || value.parentTaskId !== undefined && !uuid.test(String(value.parentTaskId))
      || projects(value.projectIds) === undefined || Object.keys(value).some((key) => !["title", "description", "parentTaskId", "projectIds"].includes(key)))
      throw new InvalidCanonicalTaskInput();
    return this.repository.createTask(memberId, workspaceId, { title: value.title.trim(), description: String(value.description ?? ""),
      ...(typeof value.parentTaskId === "string" ? { parentTaskId: value.parentTaskId } : {}), projectIds: projects(value.projectIds)! });
  }
  update(memberId: string, taskId: string, value: unknown) {
    if (!uuid.test(taskId) || !object(value) || !Object.keys(value).length
      || Object.keys(value).some((key) => !["title", "description", "statusId"].includes(key))
      || value.title !== undefined && (typeof value.title !== "string" || !value.title.trim() || value.title.trim().length > 500)
      || value.description !== undefined && (typeof value.description !== "string" || value.description.length > 20_000)
      || value.statusId !== undefined && !uuid.test(String(value.statusId))) throw new InvalidCanonicalTaskInput();
    return this.repository.updateTask(memberId, taskId, { ...(typeof value.title === "string" ? { title: value.title.trim() } : {}),
      ...(typeof value.description === "string" ? { description: value.description } : {}),
      ...(typeof value.statusId === "string" ? { statusId: value.statusId } : {}) });
  }
  associate(memberId: string, taskId: string, value: unknown) {
    if (!uuid.test(taskId) || !object(value) || Object.keys(value).some((key) => !["projectIds","impactToken"].includes(key))
      || value.impactToken !== undefined && typeof value.impactToken !== "string" || projects(value.projectIds) === undefined)
      throw new InvalidCanonicalTaskInput();
    return this.repository.associateTask(memberId, taskId, projects(value.projectIds)!, typeof value.impactToken === "string" ? value.impactToken : undefined);
  }
  setParent(memberId: string, taskId: string, value: unknown) {
    if (!uuid.test(taskId) || !object(value) || Object.keys(value).length !== 1
      || value.parentTaskId !== null && !uuid.test(String(value.parentTaskId))) throw new InvalidCanonicalTaskInput();
    return this.repository.setTaskParent(memberId, taskId, typeof value.parentTaskId === "string" ? value.parentTaskId : undefined);
  }
  resolveKey(memberId: string, projectId: string, key: string) {
    if (!uuid.test(projectId) || !/^[A-Za-z][A-Za-z0-9-]{1,19}-[1-9][0-9]*$/.test(key)) throw new InvalidCanonicalTaskInput();
    return this.repository.resolveTaskKey(memberId, projectId, key.toUpperCase());
  }
  workflow(memberId: string, workspaceId: string) {
    if (!uuid.test(workspaceId)) throw new InvalidCanonicalTaskInput(); return this.repository.workspaceWorkflow(memberId, workspaceId);
  }
  configureWorkflow(memberId: string, workspaceId: string, value: unknown) {
    if (!uuid.test(workspaceId) || !object(value) || Object.keys(value).length !== 1 || !Array.isArray(value.statuses)
      || value.statuses.length < 3 || value.statuses.some((status) => !object(status) || !uuid.test(String(status.id))
        || typeof status.name !== "string" || !status.name.trim() || !["unstarted","started","completed","canceled"].includes(String(status.category))
        || !Number.isInteger(status.position) || Number(status.position) < 1)) throw new InvalidCanonicalTaskInput();
    const statuses=value.statuses as Record<string,unknown>[];
    if (!["unstarted","started","completed"].every((category)=>statuses.some((status)=>status.category===category)))
      throw new InvalidCanonicalTaskInput();
    return this.repository.configureWorkflow(memberId, workspaceId, statuses.map((status: any) =>
      ({ id: status.id, name: status.name.trim(), category: status.category, position: status.position })));
  }
  setProjectParent(memberId: string, projectId: string, value: unknown) {
    if (!uuid.test(projectId) || !object(value) || Object.keys(value).length !== 1
      || value.parentProjectId !== null && !uuid.test(String(value.parentProjectId))) throw new InvalidCanonicalTaskInput();
    return this.repository.setProjectParent(memberId, projectId, typeof value.parentProjectId === "string" ? value.parentProjectId : undefined);
  }
  listProject(memberId: string, projectId: string) {
    if (!uuid.test(projectId)) throw new InvalidCanonicalTaskInput(); return this.repository.listProjectTasks(memberId, projectId);
  }
  list(memberId: string, workspaceId: string) {
    if (!uuid.test(workspaceId)) throw new InvalidCanonicalTaskInput(); return this.repository.listTasks(memberId, workspaceId);
  }
}
