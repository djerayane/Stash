import type { CapabilityModule } from "../capability-registry.js";
import { noteRoutes } from "../note-routes.js";
import type { NoteService } from "../notes.js";
import type { MemberAccessResolver } from "../workspaces-projects.js";
import type { NoteTreeService } from "./note-tree.js";
import { noteTreeRoutes } from "./note-tree-routes.js";
import { starterTutorialRoutes } from "./starter-tutorial-routes.js";
import type { TutorialContributionService } from "./collections.js";
import type { RelationshipQueryService } from "./relationship-query.js";
import { relationshipRoutes } from "./relationship-routes.js";
import type { VisualizationBlockService } from "./visualization-block.js";
import { visualizationRoutes } from "./visualization-routes.js";

export type { Collection, CollectionProperty, CollectionRecord, TutorialContribution, ViewBlock } from "./collections.js";
export { PostgresTutorialContributionRepository } from "./postgres-tutorial-contribution-repository.js";

export function knowledgeAuthoringCapability(options: {
  notes: NoteService;
  noteTree?: NoteTreeService;
  starterTutorials?: TutorialContributionService;
  relationships?: RelationshipQueryService;
  visualizations?: VisualizationBlockService;
  memberAccess: MemberAccessResolver;
}): CapabilityModule {
  return {
    name: "knowledge-authoring",
    routes: () => [noteRoutes(options.notes, options.memberAccess),
      ...(options.noteTree ? [noteTreeRoutes(options.noteTree, options.memberAccess)] : []),
      ...(options.relationships ? [relationshipRoutes(options.relationships, options.memberAccess)] : []),
      ...(options.visualizations ? [visualizationRoutes(options.visualizations, options.memberAccess)] : []),
      ...(options.starterTutorials ? [starterTutorialRoutes(options.starterTutorials, options.memberAccess)] : [])],
  };
}
