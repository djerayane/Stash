import type { CapabilityModule } from "../capability-registry.js";
import { noteRoutes } from "../note-routes.js";
import type { NoteService } from "../notes.js";
import type { MemberAccessResolver } from "../workspaces-projects.js";
import type { NoteTreeService } from "./note-tree.js";
import { noteTreeRoutes } from "./note-tree-routes.js";
import { starterTutorialRoutes } from "./starter-tutorial-routes.js";
import type { TutorialContributionService } from "./collections.js";
import type { CollectionService } from "./collections.js";
import { collectionRoutes } from "./collection-routes.js";
import type { RelationshipQueryService } from "./relationship-query.js";
import { relationshipRoutes } from "./relationship-routes.js";
import type { VisualizationBlockService } from "./visualization-block.js";
import { visualizationRoutes } from "./visualization-routes.js";
import { noteCollaborationRoutes } from "../note-collaboration-routes.js";
import type { NoteCollaborationService } from "../note-collaboration.js";
import { noteLinkRoutes } from "../note-link-routes.js";
import type { NoteLinkService } from "../note-links.js";
import { attachmentRoutes } from "../attachment-routes.js";
import type { AttachmentService } from "../attachments.js";
import { discussionRoutes } from "../discussion-routes.js";
import type { DiscussionService } from "../discussions.js";
import { activityRoutes } from "../activity-routes.js";
import type { ActivityService } from "../activity.js";
import { workspaceSearchRoutes } from "../workspace-search-routes.js";
import type { WorkspaceSearchService } from "../workspace-search.js";
import { portableWorkspaceExportRoute } from "../portable-workspace-export-route.js";
import type { PortableWorkspaceExportService } from "../portable-workspace-export.js";
import { markdownWorkspaceImportRoute } from "../portable-workspace-import-route.js";
import type { PortableWorkspaceImportService } from "../portable-workspace-import.js";
import { mobileCaptureRoutes } from "../mobile-capture-routes.js";
import type { MobileCaptureService } from "../mobile-captures.js";

export type { Collection, CollectionProperty, CollectionRecord, TutorialContribution, ViewBlock } from "./collections.js";
export { PostgresTutorialContributionRepository } from "./postgres-tutorial-contribution-repository.js";
export { PostgresCollectionRepository } from "./postgres-collection-repository.js";

export function knowledgeAuthoringCapability(options: {
  notes: NoteService;
  noteTree?: NoteTreeService;
  starterTutorials?: TutorialContributionService;
  collections?: CollectionService;
  relationships?: RelationshipQueryService;
  visualizations?: VisualizationBlockService;
  noteCollaboration?: NoteCollaborationService;
  noteLinks?: NoteLinkService;
  attachments?: AttachmentService;
  discussions?: DiscussionService;
  activities?: ActivityService;
  searches?: WorkspaceSearchService;
  portableWorkspaceExports?: PortableWorkspaceExportService;
  portableWorkspaceImports?: PortableWorkspaceImportService;
  mobileCaptures?: MobileCaptureService;
  memberAccess: MemberAccessResolver;
}): CapabilityModule {
  const publicRoutes = () => [noteRoutes(options.notes, options.memberAccess),
    ...(options.noteTree ? [noteTreeRoutes(options.noteTree, options.memberAccess)] : []),
    ...(options.relationships ? [relationshipRoutes(options.relationships, options.memberAccess)] : []),
    ...(options.visualizations ? [visualizationRoutes(options.visualizations, options.memberAccess)] : []),
    ...(options.collections ? [collectionRoutes(options.collections, options.memberAccess)] : []),
    ...(options.starterTutorials ? [starterTutorialRoutes(options.starterTutorials, options.memberAccess)] : []),
    ...(options.noteCollaboration ? [noteCollaborationRoutes(options.noteCollaboration, options.memberAccess)] : []),
    ...(options.noteLinks ? [noteLinkRoutes(options.noteLinks, options.memberAccess)] : []),
    ...(options.attachments ? [attachmentRoutes(options.attachments, options.memberAccess)] : []),
    ...(options.discussions ? [discussionRoutes(options.discussions, options.memberAccess)] : []),
    ...(options.activities ? [activityRoutes(options.activities, options.memberAccess)] : []),
    ...(options.searches ? [workspaceSearchRoutes(options.searches, options.memberAccess)] : []),
    ...(options.portableWorkspaceExports ? [portableWorkspaceExportRoute(options.portableWorkspaceExports, options.memberAccess)] : []),
    ...(options.portableWorkspaceImports ? [markdownWorkspaceImportRoute(options.portableWorkspaceImports, options.memberAccess)] : []),
    ...(options.mobileCaptures ? [mobileCaptureRoutes(options.mobileCaptures, options.memberAccess)] : [])];
  return {
    name: "knowledge-authoring",
    owns: ["notes", ...(options.noteTree ? ["note-tree"] : []), ...(options.relationships ? ["relationships"] : []),
      ...(options.visualizations ? ["visualizations"] : []), ...(options.collections ? ["collections"] : []),
      ...(options.starterTutorials ? ["starter-tutorials"] : []), ...(options.noteCollaboration ? ["note-collaboration"] : []),
      ...(options.noteLinks ? ["note-links"] : []), ...(options.attachments ? ["attachments"] : []),
      ...(options.discussions ? ["discussions"] : []), ...(options.activities ? ["activities"] : []),
      ...(options.searches ? ["search"] : []), ...(options.portableWorkspaceExports ? ["portable-export"] : []),
      ...(options.portableWorkspaceImports ? ["markdown-import"] : []), ...(options.mobileCaptures ? ["mobile-capture"] : [])],
    routes: publicRoutes,
    publicRoutes,
  };
}
