import { json, readJson, type HttpRoute } from "./http-routing.js";
import { InvalidNoteLinkInput, type NoteLinkService } from "./note-links.js";
import type { MemberAccessResolver } from "./workspaces-projects.js";

export function noteLinkRoutes(service: NoteLinkService, access: MemberAccessResolver): HttpRoute {
  return {
    matches: (request, url) => (request.method === "PUT" && /^\/api\/notes\/[^/]+\/location$/.test(url.pathname))
      || (["GET", "POST"].includes(request.method ?? "") && /^\/api\/notes\/[^/]+\/links$/.test(url.pathname))
      || (request.method === "PUT" && /^\/api\/notes\/[^/]+\/links\/[^/]+\/repair$/.test(url.pathname)),
    async handle(request, response, url) {
      const member = await access.authenticateBearer(request.headers.authorization);
      if (!member) { json(response, 401, { error: "unauthorized", message: "A valid Member session is required." }); return true; }
      try {
        const segments = url.pathname.split("/");
        let noteId: string; try { noteId = decodeURIComponent(segments[3]!); } catch { throw new InvalidNoteLinkInput(); }
        if (url.pathname.endsWith("/location")) {
          const result = await service.move(member.accountId, noteId, await readJson(request));
          if (result.status === "moved") json(response, 200, { location: result.location });
          else if (result.status === "changed") json(response, 409, { error: "note_changed", message: "The Note location changed. Reload before moving it.", location: result.location });
          else if (result.status === "path_conflict") json(response, 409, { error: result.status, message: "That path or permanent alias already belongs to another Note." });
          else json(response, 404, { error: "note_not_found", message: "This Note is unavailable." });
          return true;
        }
        if (url.pathname.endsWith("/repair")) {
          let linkId: string; try { linkId = decodeURIComponent(segments[5]!); } catch { throw new InvalidNoteLinkInput(); }
          const result = await service.repair(member.accountId, noteId, linkId, await readJson(request));
          if (result.status === "repaired") json(response, 200, { link: result.link });
          else if (result.status === "changed") json(response, 409, { error: "link_changed", message: "The Note link changed. Reload before repairing it.", link: result.link });
          else json(response, 404, { error: result.status, message: result.status === "target_not_found" ? "The selected Note is unavailable." : "This Note link is unavailable." });
          return true;
        }
        if (request.method === "GET") {
          const result = await service.list(member.accountId, noteId);
          if (result.status === "found") json(response, 200, { links: result.links });
          else json(response, 404, { error: "note_not_found", message: "This Note is unavailable." });
        } else {
          const result = await service.create(member.accountId, noteId, await readJson(request));
          if (result.status === "created") {
            const listed = await service.list(member.accountId, noteId);
            const created = listed.status === "found" ? listed.links.find((link) => link.id === result.link.id) : undefined;
            json(response, 201, { link: created ?? result.link });
          } else if (result.status === "already_linked") json(response, 409, { error: result.status, message: "These Notes are already linked." });
          else json(response, 404, { error: result.status, message: result.status === "target_not_found" ? "The target Note is unavailable." : "This Note is unavailable." });
        }
      } catch (error) {
        if (error instanceof InvalidNoteLinkInput) json(response, 422, { error: "invalid_input", message: "A Note link requires valid stable identities, revision, and portable Markdown path." });
        else if (error instanceof SyntaxError || error instanceof Error && error.message === "body_too_large") json(response, error instanceof SyntaxError ? 400 : 413,
          { error: error instanceof SyntaxError ? "invalid_json" : "body_too_large", message: "The request could not be read." });
        else json(response, 503, { error: "note_link_unavailable", message: "The Note link change could not be saved. Try again." });
      }
      return true;
    },
  };
}
