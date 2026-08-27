import type { CapabilityModule } from "../capability-registry.js";
import { taskRoutes } from "../task-routes.js";
import type { TaskService } from "../tasks.js";
import type { MemberAccessResolver } from "../workspaces-projects.js";
import { workspaceProjectRoutes } from "../workspace-project-routes.js";
import type { WorkspaceProjectService } from "../workspaces-projects.js";
import { projectlessTaskRoutes } from "./projectless-task-routes.js";
import type { ProjectlessTaskService } from "./projectless-tasks.js";

export function workPlanningCapability(options: {
  tasks: TaskService;
  memberAccess: MemberAccessResolver;
  workspaceProjects?: WorkspaceProjectService;
  projectlessTasks?: ProjectlessTaskService;
}): CapabilityModule {
  return {
    name: "work-planning",
    routes: () => [
      ...(options.workspaceProjects ? [workspaceProjectRoutes(options.workspaceProjects, options.memberAccess)] : []),
      ...(options.projectlessTasks ? [projectlessTaskRoutes(options.projectlessTasks, options.memberAccess)] : []),
      taskRoutes(options.tasks, options.memberAccess),
    ],
  };
}
