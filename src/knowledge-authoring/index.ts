import type { CapabilityModule } from "../capability-registry.js";
import { noteRoutes } from "../note-routes.js";
import type { NoteService } from "../notes.js";
import type { MemberAccessResolver } from "../workspaces-projects.js";
import type { NoteTreeService } from "./note-tree.js";
import { noteTreeRoutes } from "./note-tree-routes.js";

export function knowledgeAuthoringCapability(options: {
  notes: NoteService;
  noteTree?: NoteTreeService;
  memberAccess: MemberAccessResolver;
}): CapabilityModule {
  return {
    name: "knowledge-authoring",
    routes: () => [noteRoutes(options.notes, options.memberAccess),
      ...(options.noteTree ? [noteTreeRoutes(options.noteTree, options.memberAccess)] : [])],
  };
}
