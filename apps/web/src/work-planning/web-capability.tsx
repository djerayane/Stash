import { BoardsPage } from "./boards-page";
import { ProjectBrowser } from "./project-browser";
import { TasksPage } from "./tasks-page";
import { TaskDetailPage } from "../task-detail";
import { ProjectNotificationsPage } from "../project-notifications";
import { DiscussionPanelPage } from "../knowledge-authoring/workspace-pages";
import type { WebCapability } from "../capability-registry";

export const workPlanningWebCapability: WebCapability = {
  name: "work-planning",
  primaryNavigation: [{ to: "/app/tasks", label: "Tasks", icon: "task" }],
  contextualNavigation: [{ to: "/app/projects", label: "Projects", icon: "projects" }],
  routes: ({ memberId, openProject, token, workspaceId }) => [
    { path: "/app/tasks", element: <TasksPage workspaceId={workspaceId} memberId={memberId} token={token} /> },
    { path: "/app/projects", element: <ProjectBrowser token={token} onOpenProject={openProject} /> },
    { path: "/app/projects/:projectId/boards", element: <BoardsPage token={token} /> },
    { path: "/app/projects/:projectId/boards/:boardId", element: <BoardsPage token={token} /> },
    { path: "/app/tasks/:targetId/discussions", element: <DiscussionPanelPage targetKind="task" token={token} /> },
    { path: "/app/projects/:projectId/tasks/:taskKey", element: <TaskDetailPage memberId={memberId} token={token} /> },
    { path: "/app/projects/:projectId/notifications", element: <ProjectNotificationsPage token={token} /> },
  ],
};
