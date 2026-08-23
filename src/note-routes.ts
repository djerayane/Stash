import { json, readJson, type HttpRoute } from "./http-routing.js";
import { InvalidNoteEdit, InvalidNoteInput, InvalidNoteTriageInput, presentNoteTriageResult, type NoteService } from "./notes.js";
import type { MemberAccessResolver } from "./workspaces-projects.js";

export function noteRoutes(service: NoteService, memberAccess: MemberAccessResolver): HttpRoute {
  return {
    matches: (request, url) => (request.method === "POST" && /^\/api\/workspaces\/[^/]+\/notes$/.test(url.pathname))
      || (request.method === "GET" && /^\/api\/workspaces\/[^/]+\/note-templates$/.test(url.pathname))
      || (request.method === "GET" && /^\/api\/workspaces\/[^/]+\/notes$/.test(url.pathname))
      || (request.method === "GET" && /^\/api\/workspaces\/[^/]+\/inbox$/.test(url.pathname))
      || (request.method === "POST" && /^\/api\/workspaces\/[^/]+\/inbox\/[^/]+\/triage$/.test(url.pathname))
      || (request.method === "GET" && /^\/api\/notes\/[^/]+\/conflicts$/.test(url.pathname))
      || (request.method === "PUT" && /^\/api\/notes\/[^/]+\/conflicts\/[^/]+$/.test(url.pathname))
      || (["GET", "PUT"].includes(request.method ?? "") && /^\/api\/notes\/[^/]+$/.test(url.pathname)),
    async handle(request, response, url) {
      const access = await memberAccess.authenticateBearer(request.headers.authorization);
      if (!access) {
        json(response, 401, { error: "unauthorized", message: "A valid Member session is required." });
        return true;
      }
      try {
        if (request.method === "GET" && /^\/api\/workspaces\/[^/]+\/(note-templates|notes)$/.test(url.pathname)) {
          let workspaceId: string;
          try { workspaceId = decodeURIComponent(url.pathname.split("/")[3]!); } catch { throw new InvalidNoteInput(); }
          const view = url.searchParams.get("view");
          if (view && view !== "decisions") throw new InvalidNoteInput();
          const result = url.pathname.endsWith("/note-templates")
            ? await service.listTemplates(access.accountId, workspaceId)
            : view === "decisions" ? await service.listDecisions(access.accountId, workspaceId)
              : await service.listNotes(access.accountId, workspaceId);
          if (result.status === "workspace_forbidden") {
            json(response, 403, { error: "workspace_forbidden", message: "This Member cannot read Notes in that Workspace." });
          } else if ("templates" in result) json(response, 200, { templates: result.templates });
          else json(response, 200, { notes: result.notes.map(({ createdByMemberId: _, ...note }) => note) });
          return true;
        }
        if (request.method === "GET" && url.pathname.endsWith("/conflicts")) {
          let noteId: string;
          try { noteId = decodeURIComponent(url.pathname.split("/")[3]!); } catch { throw new InvalidNoteEdit(); }
          const result = await service.listConflicts(access.accountId, noteId);
          if (result.status === "not_found") json(response, 404, { error: "note_not_found", message: "This Note is unavailable." });
          else json(response, 200, { conflicts: result.conflicts });
          return true;
        }
        if (request.method === "PUT" && url.pathname.includes("/conflicts/")) {
          let noteId: string; let conflictId: string;
          try { noteId = decodeURIComponent(url.pathname.split("/")[3]!); conflictId = decodeURIComponent(url.pathname.split("/")[5]!); }
          catch { throw new InvalidNoteEdit(); }
          const result = await service.resolveConflict(access.accountId, noteId, conflictId, await readJson(request));
          if (result.status === "resolved") {
            const { createdByMemberId: _, ...note } = result.note;
            json(response, 200, { ...note, portableProjection: { format: result.projection.schema, state: "recorded" } });
          } else if (result.status === "already_resolved") json(response, 409, { error: "conflict_already_resolved", message: "This conflict has already been resolved." });
          else if (result.status === "conflict_changed") json(response, 409, { error: "conflict_changed", message: "The Note changed again. Review the refreshed conflict before resolving it.", conflict: result.conflict });
          else if (result.status === "invalid_operation_identity") json(response, 422, { error: "invalid_operation_identity", message: "This preserved edit reused an operation identity and cannot be applied safely." });
          else if (result.status === "invalid_reference") json(response, 422, { error: "invalid_block_reference", message: "The preserved contribution no longer has an unambiguous Block target." });
          else json(response, 404, { error: result.status, message: "The requested Note conflict could not be found." });
          return true;
        }
        if (request.method === "GET" && url.pathname.startsWith("/api/notes/")) {
          let noteId: string;
          try { noteId = decodeURIComponent(url.pathname.split("/")[3]!); } catch { throw new InvalidNoteEdit(); }
          const note = await service.get(access.accountId, noteId);
          if (!note) json(response, 404, { error: "note_not_found", message: "This Note is unavailable." });
          else { const { createdByMemberId: _, ...publicNote } = note; json(response, 200, publicNote); }
          return true;
        }
        if (request.method === "PUT" && url.pathname.startsWith("/api/notes/")) {
          let noteId: string;
          try { noteId = decodeURIComponent(url.pathname.split("/")[3]!); } catch { throw new InvalidNoteEdit(); }
          const result = await service.edit(access.accountId, noteId, await readJson(request));
          if (result.status === "updated" || result.status === "duplicate") {
            const { createdByMemberId: _, ...note } = result.note;
            json(response, 200, { ...note, portableProjection: { format: result.projection.schema, state: "recorded" } });
          } else if (result.status === "conflict_preserved") {
            json(response, 409, { error: "revision_conflict", message: "This Note changed since editing began. Your version was preserved for conflict resolution.",
              ...(result.conflictId ? { conflictId: result.conflictId } : {}) });
          } else if (result.status === "invalid_reference") {
            json(response, 422, { error: "invalid_block_reference", message: "A Block reference is missing or ambiguous. Reload the Note and repair it explicitly." });
          } else json(response, 404, { error: "note_not_found", message: "This Note is unavailable." });
          return true;
        }
        let workspaceId: string;
        try {
          workspaceId = decodeURIComponent(url.pathname.split("/")[3]!);
        } catch {
          throw new InvalidNoteInput();
        }
        if (request.method === "GET") {
          const result = await service.listInbox(access.accountId, workspaceId);
          if (result.status === "workspace_forbidden") json(response, 403, { error: "workspace_forbidden", message: "This Member cannot read that Workspace Inbox." });
          else json(response, 200, { notes: result.notes.map(({ createdByMemberId: _, ...note }) => note) });
          return true;
        }
        if (url.pathname.includes("/inbox/")) {
          let noteId: string;
          try { noteId = decodeURIComponent(url.pathname.split("/")[5]!); } catch { throw new InvalidNoteTriageInput(); }
          const outcome = await service.triage(access.accountId, workspaceId, noteId, await readJson(request));
          if (outcome.status === "updated") {
            json(response, 200, presentNoteTriageResult(outcome.result)); return true;
          }
          if (outcome.status === "note_not_found" || outcome.status === "target_note_not_found") {
            json(response, 404, { error: outcome.status, message: "The requested Note could not be found." }); return true;
          }
          json(response, 403, { error: "workspace_forbidden", message: "This Member cannot triage that Note or Project." }); return true;
        }
        const result = await service.capture(access.accountId, workspaceId, await readJson(request));
        if (result.status === "created") {
          const { createdByMemberId: _, ...note } = result.note;
          json(response, 201, {
            ...note,
            portableProjection: {
              format: result.projection.schema,
              state: "recorded",
            },
          });
        } else {
          json(response, 403, {
            error: "workspace_forbidden",
            message: "This Member cannot capture Notes in that Workspace or Project.",
          });
        }
      } catch (error) {
        if (error instanceof InvalidNoteEdit) {
          json(response, 422, { error: "invalid_rich_text", message: "The rich-text document is invalid and was not saved." });
        } else if (error instanceof InvalidNoteInput || error instanceof InvalidNoteTriageInput) {
          json(response, 422, {
            error: "invalid_input",
            message: "A Note requires content or a supported Template and valid optional Project, tags, and reminder fields.",
          });
        } else if (error instanceof SyntaxError || (error instanceof Error && error.message === "body_too_large")) {
          const tooLarge = error instanceof Error && error.message === "body_too_large";
          json(response, tooLarge ? 413 : 400, {
            error: tooLarge ? "body_too_large" : "invalid_json",
            message: tooLarge ? "Request body exceeds the 64 KiB limit." : "Request body must be valid JSON.",
          });
        } else {
          json(response, 503, {
            error: "note_unavailable",
            message: "The Note could not be captured. Try again.",
          });
        }
      }
      return true;
    },
  };
}
