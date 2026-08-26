import type { CapabilityModule } from "../capability-registry.js";
import { taskRoutes } from "../task-routes.js";
import type { TaskService } from "../tasks.js";
import type { MemberAccessResolver } from "../workspaces-projects.js";
import { workspaceProjectRoutes } from "../workspace-project-routes.js";
import type { WorkspaceProjectService } from "../workspaces-projects.js";

export function workPlanningCapability(options: {
  tasks: TaskService;
  memberAccess: MemberAccessResolver;
  workspaceProjects?: WorkspaceProjectService;
}): CapabilityModule {
  return {
    name: "work-planning",
    routes: () => [
      ...(options.workspaceProjects ? [workspaceProjectRoutes(options.workspaceProjects, options.memberAccess)] : []),
      taskRoutes(options.tasks, options.memberAccess),
    ],
  };
}
