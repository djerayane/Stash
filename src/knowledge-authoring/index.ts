import type { CapabilityModule } from "../capability-registry.js";
import { noteRoutes } from "../note-routes.js";
import type { NoteService } from "../notes.js";
import type { MemberAccessResolver } from "../workspaces-projects.js";

export function knowledgeAuthoringCapability(options: {
  notes: NoteService;
  memberAccess: MemberAccessResolver;
}): CapabilityModule {
  return {
    name: "knowledge-authoring",
    routes: () => [noteRoutes(options.notes, options.memberAccess)],
  };
}
