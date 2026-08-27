import type { CapabilityModule } from "../capability-registry.js";
import { taskRoutes } from "../task-routes.js";
import type { TaskService } from "../tasks.js";
import type { MemberAccessResolver } from "../workspaces-projects.js";
import { workspaceProjectRoutes } from "../workspace-project-routes.js";
import type { WorkspaceProjectService } from "../workspaces-projects.js";
import { projectlessTaskRoutes } from "./projectless-task-routes.js";
import type { ProjectlessTaskService } from "./projectless-tasks.js";
import { canonicalTaskRoutes } from "./canonical-task-routes.js";
import type { CanonicalTaskService } from "./canonical-tasks.js";
import { projectWorkflowRoutes } from "../project-workflow-routes.js";
import type { ProjectWorkflowService } from "../project-workflows.js";
import { boardRoutes } from "../board-routes.js";
import type { BoardService } from "../boards.js";
import { notificationRoutes } from "../notification-routes.js";
import type { NotificationService } from "../notifications.js";
import { automationRoutes } from "../automation-routes.js";
import type { AutomationService } from "../automations.js";

export function workPlanningCapability(options: {
  tasks: TaskService;
  memberAccess: MemberAccessResolver;
  workspaceProjects?: WorkspaceProjectService;
  projectlessTasks?: ProjectlessTaskService;
  canonicalTasks?: CanonicalTaskService;
  projectWorkflows?: ProjectWorkflowService;
  boards?: BoardService;
  notifications?: NotificationService;
  automations?: AutomationService;
}): CapabilityModule {
  const publicRoutes = () => [
    ...(options.workspaceProjects ? [workspaceProjectRoutes(options.workspaceProjects, options.memberAccess)] : []),
    ...(options.projectlessTasks ? [projectlessTaskRoutes(options.projectlessTasks, options.memberAccess)] : []),
    ...(options.canonicalTasks ? [canonicalTaskRoutes(options.canonicalTasks, options.memberAccess)] : []),
    taskRoutes(options.tasks, options.memberAccess),
    ...(options.projectWorkflows ? [projectWorkflowRoutes(options.projectWorkflows, options.memberAccess)] : []),
    ...(options.boards ? [boardRoutes(options.boards, options.memberAccess)] : []),
    ...(options.notifications ? [notificationRoutes(options.notifications, options.memberAccess)] : []),
    ...(options.automations ? [automationRoutes(options.automations, options.memberAccess)] : []),
  ];
  return {
    name: "work-planning",
    owns: ["tasks", ...(options.workspaceProjects ? ["workspace-projects"] : []),
      ...(options.projectlessTasks ? ["projectless-tasks"] : []), ...(options.canonicalTasks ? ["canonical-tasks"] : []),
      ...(options.projectWorkflows ? ["project-workflows"] : []), ...(options.boards ? ["boards"] : []),
      ...(options.notifications ? ["notifications"] : []), ...(options.automations ? ["automations"] : [])],
    routes: publicRoutes,
    publicRoutes,
  };
}
