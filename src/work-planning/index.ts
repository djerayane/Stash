import type { CapabilityModule } from "../capability-registry.js";
import { taskRoutes } from "../task-routes.js";
import type { TaskService } from "../tasks.js";
import type { MemberAccessResolver } from "../workspaces-projects.js";

export function workPlanningCapability(options: {
  tasks: TaskService;
  memberAccess: MemberAccessResolver;
}): CapabilityModule {
  return {
    name: "work-planning",
    routes: () => [taskRoutes(options.tasks, options.memberAccess)],
  };
}
