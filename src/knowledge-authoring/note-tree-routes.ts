import { json, readJson, type HttpRoute } from "../http-routing.js";
import { InvalidNoteTreeInput, type NoteTreeService } from "./note-tree.js";
import type { MemberAccessResolver } from "../workspaces-projects.js";

const workspaceTree = /^\/api\/workspaces\/[^/]+\/note-tree$/;
const removedTree = /^\/api\/workspaces\/[^/]+\/note-tree\/removed$/;
const noteTreeAction = /^\/api\/notes\/[^/]+\/(?:move|context|branch-preview|archive|trash|restore)$/;
const contextLinks = /^\/api\/notes\/[^/]+\/context\/links$/;

export function noteTreeRoutes(service: NoteTreeService, access: MemberAccessResolver): HttpRoute {
  return {
    matches(request, url) {
      return workspaceTree.test(url.pathname)
        || removedTree.test(url.pathname)
        || contextLinks.test(url.pathname)
        || noteTreeAction.test(url.pathname);
    },
    async handle(request, response, url) {
      const preflightAction = noteTreeAction.test(url.pathname) ? url.pathname.split("/")[4] : undefined;
      const allowedMethods = workspaceTree.test(url.pathname) ? ["GET", "POST"]
        : removedTree.test(url.pathname) || preflightAction === "context" ? ["GET"]
          : ["POST"];
      if (!allowedMethods.includes(request.method ?? "")) {
        response.setHeader("allow", allowedMethods.join(", "));
        json(response, 405, { error: "method_not_allowed", message: `Use ${allowedMethods.join(" or ")} for this Note Tree operation.` });
        return true;
      }
      const member = await access.authenticateBearer(request.headers.authorization);
      if (!member) { json(response, 401, { error: "unauthorized", message: "A valid Member session is required." }); return true; }
      try {
        const segments = url.pathname.split("/");
        if (removedTree.test(url.pathname)) {
          const result = await service.removed(member.accountId, decodeURIComponent(segments[3]!));
          if (result.status === "found") json(response, 200, { branches: result.branches });
          else json(response, 403, { error: result.status, message: "This Workspace is unavailable." });
          return true;
        }
        if (workspaceTree.test(url.pathname)) {
          const workspaceId = decodeURIComponent(segments[3]!);
          if (request.method === "GET") {
            const result = await service.list(member.accountId, workspaceId);
            if (result.status === "found") json(response, 200, { nodes: result.nodes });
            else json(response, 403, { error: result.status, message: "This Workspace is unavailable." });
          } else {
            const result = await service.create(member.accountId, workspaceId, await readJson(request));
            if (result.status === "created") json(response, 201, { node: result.node });
            else if (result.status === "workspace_forbidden") json(response, 403, { error: result.status, message: "This Workspace is unavailable." });
            else json(response, 404, { error: result.status, message: "The selected Note Tree destination is unavailable." });
          }
          return true;
        }
        const noteId = decodeURIComponent(segments[3]!);
        const action = segments[4]!;
        if (contextLinks.test(url.pathname)) {
          const result = await service.createContextLink(member.accountId, noteId, await readJson(request));
          if (result.status === "created") json(response, 201, { link: result.link });
          else if (result.status === "already_linked") json(response, 409, { error: result.status, message: "These Notes are already linked." });
          else json(response, 404, { error: result.status, message: result.status === "target_not_found"
            ? "The target Note is unavailable." : "This Note is unavailable." });
          return true;
        }
        if (action === "context") {
          const result = await service.context(member.accountId, noteId);
          if (result.status === "found") json(response, 200, result.context);
          else json(response, 404, { error: result.status, message: "This Note is unavailable." });
          return true;
        }
        if (action === "move") {
          const result = await service.moveNoteBranch(noteId, await readJson(request), member.accountId);
          if (result.status === "moved" || result.status === "unchanged") json(response, 200, result);
          else if (result.status === "cycle") json(response, 409, { error: "note_tree_cycle", message: "A Note cannot move inside its own branch." });
          else json(response, 404, { error: result.status, message: "The selected Note Tree destination is unavailable." });
          return true;
        }
        if (action === "branch-preview") {
          const result = await service.preview(member.accountId, noteId, await readJson(request));
          if (result.status === "found") json(response, 200, { impact: result.impact });
          else if (result.status === "cycle") json(response, 409, { error: "note_tree_cycle", message: "A Note cannot move inside its own branch." });
          else json(response, 404, { error: result.status, message: "The selected Note branch is unavailable." });
          return true;
        }
        if (action === "restore") {
          const result = await service.restore(member.accountId, noteId);
          if (result.status === "restored") json(response, 200, result);
          else json(response, 404, { error: result.status, message: "This Note branch is unavailable." });
          return true;
        }
        const result = await service.remove(member.accountId, noteId, action === "archive" ? "archived" : "trashed");
        if (result.status === "updated") json(response, 200, result);
        else if (result.status === "collection_owner_requires_relocation") json(response, 409, { error: result.status,
          message: "Move or remove the owned Collection before removing this Note branch, or remove the complete starter tutorial." });
        else json(response, 404, { error: result.status, message: "This Note branch is unavailable." });
      } catch (error) {
        if (error instanceof InvalidNoteTreeInput || error instanceof URIError) json(response, 422,
          { error: "invalid_input", message: "Use valid Note identities, a concise title, and one valid destination." });
        else if (error instanceof SyntaxError || error instanceof Error && error.message === "body_too_large") json(response,
          error instanceof SyntaxError ? 400 : 413, { error: error instanceof SyntaxError ? "invalid_json" : "body_too_large", message: "The request could not be read." });
        else json(response, 503, { error: "note_tree_unavailable", message: "The Note Tree change could not be completed. Try again." });
      }
      return true;
    },
  };
}
