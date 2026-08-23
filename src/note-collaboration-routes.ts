import { InvalidCollaborationUpdate, type NoteCollaborationService } from "./note-collaboration.js";
import { json, readJson, type HttpRoute } from "./http-routing.js";
import type { MemberAccessResolver } from "./workspaces-projects.js";

function encode(update: Uint8Array): string { return Buffer.from(update).toString("base64"); }

export function noteCollaborationRoutes(service: NoteCollaborationService, memberAccess: MemberAccessResolver): HttpRoute {
  return {
    matches: (request, url) => ["GET", "POST"].includes(request.method ?? "")
      && /^\/api\/notes\/[^/]+\/collaboration$/.test(url.pathname),
    async handle(request, response, url) {
      const access = await memberAccess.authenticateBearer(request.headers.authorization);
      if (!access) { json(response, 401, { error: "unauthorized", message: "A valid Member session is required." }); return true; }
      let noteId: string;
      try { noteId = decodeURIComponent(url.pathname.split("/")[3]!); } catch { json(response, 400, { error: "invalid_note" }); return true; }
      try {
        const snapshot = request.method === "GET"
          ? await service.load(access.accountId, noteId)
          : await service.apply(access.accountId, noteId, decodeUpdate(await readJson(request)));
        if (!snapshot) json(response, 404, { error: "note_not_found", message: "This Note is unavailable." });
        else json(response, request.method === "GET" ? 200 : 202, {
          sequence: snapshot.sequence, update: encode(snapshot.update), updatedAt: snapshot.updatedAt,
          updatedByMemberId: snapshot.updatedByMemberId,
        });
      } catch (error) {
        if (error instanceof InvalidCollaborationUpdate) json(response, 422, { error: "invalid_collaboration_update", message: "The collaboration update is invalid." });
        else throw error;
      }
      return true;
    },
  };
}

function decodeUpdate(value: unknown): Uint8Array {
  if (!value || typeof value !== "object" || typeof (value as { update?: unknown }).update !== "string") throw new InvalidCollaborationUpdate();
  const source = (value as { update: string }).update;
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(source)) throw new InvalidCollaborationUpdate();
  return Buffer.from(source, "base64");
}
