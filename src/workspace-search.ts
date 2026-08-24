export type WorkspaceSearchKind = "note" | "task" | "discussion" | "file" | "label" | "member" | "development";

export interface WorkspaceSearchResult {
  id: string;
  kind: WorkspaceSearchKind;
  title: string;
  excerpt?: string;
  href?: string;
  projectId?: string;
  author?: string;
  assignee?: string;
  status?: string;
  occurredAt?: string;
}

export interface WorkspaceSearchFacet<T extends string = string> {
  value: T;
  count: number;
}

export interface WorkspaceSearchResponse {
  results: WorkspaceSearchResult[];
  total: number;
  facets: {
    kinds: WorkspaceSearchFacet<WorkspaceSearchKind>[];
    projects: WorkspaceSearchFacet[];
    statuses: WorkspaceSearchFacet[];
  };
}

export interface WorkspaceSearchQuery {
  q: string;
  projectId?: string;
  object?: WorkspaceSearchKind;
  author?: string;
  assignee?: string;
  status?: string;
  from?: string;
  to?: string;
}

export interface WorkspaceSearchRepository {
  searchWorkspace(memberId: string, workspaceId: string, query: WorkspaceSearchQuery): Promise<
    ({ status: "found" } & WorkspaceSearchResponse) | { status: "forbidden" }
  >;
}

export class InvalidWorkspaceSearchInput extends Error {}
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const kinds: WorkspaceSearchKind[] = ["note", "task", "discussion", "file", "label", "member", "development"];

function bounded(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !value.trim() || value.trim().length > 200) throw new InvalidWorkspaceSearchInput();
  return value.trim();
}

function dateBoundary(value: unknown, end: boolean): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new InvalidWorkspaceSearchInput();
  const date = new Date(`${value}T${end ? "23:59:59.999" : "00:00:00.000"}Z`);
  if (Number.isNaN(date.valueOf()) || date.toISOString().slice(0, 10) !== value) throw new InvalidWorkspaceSearchInput();
  return date.toISOString();
}

export class WorkspaceSearchService {
  constructor(private readonly repository: WorkspaceSearchRepository) {}

  async search(memberId: string, workspaceId: string, input: Record<string, unknown>) {
    if (!uuid.test(workspaceId)) throw new InvalidWorkspaceSearchInput();
    const q = bounded(input.q);
    if (!q) throw new InvalidWorkspaceSearchInput();
    const projectId = bounded(input.projectId);
    if (projectId && !uuid.test(projectId)) throw new InvalidWorkspaceSearchInput();
    const objectValue = bounded(input.object)?.toLowerCase();
    if (objectValue && !kinds.includes(objectValue as WorkspaceSearchKind)) throw new InvalidWorkspaceSearchInput();
    const query: WorkspaceSearchQuery = { q,
      ...(projectId ? { projectId } : {}),
      ...(objectValue ? { object: objectValue as WorkspaceSearchKind } : {}),
      ...(bounded(input.author) ? { author: bounded(input.author)! } : {}),
      ...(bounded(input.assignee) ? { assignee: bounded(input.assignee)! } : {}),
      ...(bounded(input.status) ? { status: bounded(input.status)! } : {}),
      ...(dateBoundary(input.from, false) ? { from: dateBoundary(input.from, false)! } : {}),
      ...(dateBoundary(input.to, true) ? { to: dateBoundary(input.to, true)! } : {}),
    };
    if (query.from && query.to && query.from > query.to) throw new InvalidWorkspaceSearchInput();
    return this.repository.searchWorkspace(memberId, workspaceId, query);
  }
}
