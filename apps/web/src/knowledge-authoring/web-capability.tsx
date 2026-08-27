import { DiscussionPanelPage, InboxPage, NoteHistoryPage, NotificationsPage, SearchPage, WorkspaceActivityPage } from "./workspace-pages";
import { NoteTree } from "./note-tree";
import type { WebCapability } from "../capability-registry";

export const knowledgeAuthoringWebCapability: WebCapability = {
  name: "knowledge-authoring",
  primaryNavigation: [
    { to: "/app/inbox", label: "Inbox", icon: "inbox" },
    { to: "/app/notes", label: "Note Tree", icon: "note" },
    { to: "/app/search", label: "Search", icon: "search" },
  ],
  contextualNavigation: [
    { to: "/app/activity", label: "Activity", icon: "pulse" },
  ],
  routes: ({ workspaceId, token }) => [
    { path: "/app/inbox", element: <InboxPage workspaceId={workspaceId} token={token} /> },
    { path: "/app/notes", element: <NoteTree token={token} variant="page" workspaceId={workspaceId} /> },
    { path: "/app/notes/:noteId/history", element: <NoteHistoryPage token={token} /> },
    { path: "/app/notes/:targetId/discussions", element: <DiscussionPanelPage targetKind="note" token={token} /> },
    { path: "/app/notes/:targetId/blocks/:blockKey/discussions", element: <DiscussionPanelPage targetKind="block" token={token} /> },
    { path: "/app/activity", element: <WorkspaceActivityPage workspaceId={workspaceId} token={token} /> },
    { path: "/app/notifications", element: <NotificationsPage token={token} /> },
    { path: "/app/search", element: <SearchPage workspaceId={workspaceId} token={token} /> },
  ],
};
