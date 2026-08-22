import { randomUUID } from "node:crypto";

export type StatusCategory = "unstarted" | "started" | "completed";
export interface WorkflowStatus {
  id: string;
  name: string;
  category: StatusCategory;
  position: number;
  archived: boolean;
}
export interface ProjectWorkflow {
  schema: "stash.workflow.v1";
  projectId: string;
  revision: number;
  statuses: WorkflowStatus[];
}
export interface ProjectWorkflowRepository {
  findWorkflow(memberId: string, projectId: string): Promise<
    | { status: "found"; workflow: ProjectWorkflow }
    | { status: "forbidden" | "not_found" }
  >;
  replaceWorkflow(memberId: string, projectId: string, expectedRevision: number, statuses: WorkflowStatus[], newStatusIds: ReadonlySet<string>): Promise<
    | { status: "updated"; workflow: ProjectWorkflow }
    | { status: "forbidden" | "not_found" | "stale_status" }
  >;
}

export class InvalidProjectWorkflowInput extends Error {}
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export class ProjectWorkflowService {
  constructor(private readonly workflows: ProjectWorkflowRepository) {}

  async find(memberId: string, projectId: string) {
    if (!uuid.test(projectId)) throw new InvalidProjectWorkflowInput();
    return this.workflows.findWorkflow(memberId, projectId);
  }

  async replace(memberId: string, projectId: string, value: unknown) {
    if (!uuid.test(projectId) || !isObject(value) || Object.keys(value).length !== 2
      || !Number.isSafeInteger(value.expectedRevision) || (value.expectedRevision as number) < 1 || !Array.isArray(value.statuses)
      || value.statuses.length === 0 || value.statuses.length > 100) throw new InvalidProjectWorkflowInput();
    const names = new Set<string>();
    const ids = new Set<string>();
    const newStatusIds = new Set<string>();
    const statuses: WorkflowStatus[] = [];
    for (const [position, raw] of value.statuses.entries()) {
      if (!isObject(raw) || typeof raw.name !== "string" || !raw.name.trim() || raw.name.trim().length > 100
        || !["unstarted", "started", "completed"].includes(raw.category as string)
        || raw.id !== undefined && (typeof raw.id !== "string" || !uuid.test(raw.id))
        || raw.archived !== undefined && typeof raw.archived !== "boolean"
        || Object.keys(raw).some((key) => !["id", "name", "category", "archived"].includes(key)))
        throw new InvalidProjectWorkflowInput();
      const normalizedName = raw.name.trim();
      const foldedName = normalizedName.toLocaleLowerCase("en-US");
      if (names.has(foldedName) || typeof raw.id === "string" && ids.has(raw.id)) throw new InvalidProjectWorkflowInput();
      names.add(foldedName);
      const id = typeof raw.id === "string" ? raw.id : randomUUID();
      if (raw.id === undefined) newStatusIds.add(id);
      ids.add(id);
      statuses.push({ id, name: normalizedName, category: raw.category as StatusCategory, position, archived: raw.archived ?? false });
    }
    if (!statuses.some(({ archived, category }) => !archived && category === "unstarted")) throw new InvalidProjectWorkflowInput();
    return this.workflows.replaceWorkflow(memberId, projectId, value.expectedRevision as number, statuses, newStatusIds);
  }
}

export function initialWorkflowStatus(workflow: ProjectWorkflow): WorkflowStatus {
  const status = workflow.statuses.find(({ archived, category }) => !archived && category === "unstarted");
  if (!status) throw new Error("workflow_has_no_initial_status");
  return status;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
