export interface ProjectlessTask {
  id: string;
  workspaceId: string;
  title: string;
  status: { id: string; name: string; category: "unstarted" | "started" | "completed" | "canceled" };
}

export interface ProjectlessTaskRepository {
  listProjectlessTasks(memberId: string, workspaceId: string): Promise<
    { status: "found"; tasks: ProjectlessTask[] } | { status: "workspace_forbidden" }
  >;
}

export class InvalidProjectlessTaskInput extends Error {}
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export class ProjectlessTaskService {
  constructor(private readonly repository: ProjectlessTaskRepository) {}
  list(memberId: string, workspaceId: string, scope: string | null) {
    if (!uuid.test(workspaceId) || scope !== "projectless") throw new InvalidProjectlessTaskInput();
    return this.repository.listProjectlessTasks(memberId, workspaceId);
  }
}
