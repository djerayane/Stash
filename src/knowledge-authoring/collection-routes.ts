import { json, readJson, type HttpRoute } from "../http-routing.js";
import type { MemberAccessResolver } from "../workspaces-projects.js";
import { InvalidCollectionInput, type CollectionService } from "./collections.js";

const noteCollections = /^\/api\/notes\/([^/]+)\/collections(?:\/(impact|relocate|delete))?$/;
const collection = /^\/api\/collections\/([^/]+)$/;
const properties = /^\/api\/collections\/([^/]+)\/properties$/;
const propertyOrder = /^\/api\/collections\/([^/]+)\/properties\/order$/;
const propertyImpact = /^\/api\/collections\/([^/]+)\/properties\/([^/]+)\/impact$/;
const property = /^\/api\/collections\/([^/]+)\/properties\/([^/]+)$/;
const records = /^\/api\/collections\/([^/]+)\/records(?:\/([^/]+)(?:\/(move))?)?$/;
const noteViews = /^\/api\/notes\/([^/]+)\/view-blocks$/;
const view = /^\/api\/view-blocks\/([^/]+)$/;

export function collectionRoutes(service: CollectionService, access: MemberAccessResolver): HttpRoute {
  return {
    matches(_request, url) { return noteCollections.test(url.pathname) || collection.test(url.pathname) || properties.test(url.pathname)
      || propertyOrder.test(url.pathname) || propertyImpact.test(url.pathname) || property.test(url.pathname) || records.test(url.pathname)
      || noteViews.test(url.pathname) || view.test(url.pathname); },
    async handle(request, response, url) {
      const member = await access.authenticateBearer(request.headers.authorization);
      if (!member) { json(response, 401, { error: "unauthorized", message: "A valid Member session is required." }); return true; }
      try {
        const propertyImpactMatch = propertyImpact.exec(url.pathname);
        if (propertyImpactMatch) {
          if (request.method !== "GET") return method(response, "GET");
          const result = await service.previewPropertyRemoval(member.accountId, decodeURIComponent(propertyImpactMatch[1]!),
            decodeURIComponent(propertyImpactMatch[2]!));
          if (result.status === "found") json(response, 200, { impact: result.impact });
          else if (result.status === "primary_property_required") json(response, 409, { error: result.status,
            message: "Keep one primary text property so every record remains identifiable." });
          else json(response, 404, { error: result.status, message: "This Collection property is unavailable." });
          return true;
        }
        const orderMatch = propertyOrder.exec(url.pathname);
        if (orderMatch) {
          if (request.method !== "PATCH") return method(response, "PATCH");
          const result = await service.reorderProperties(member.accountId, decodeURIComponent(orderMatch[1]!), await readJson(request));
          if (result.status === "updated") json(response, 200, { collection: result.collection });
          else json(response, 404, { error: result.status, message: "This Collection property is unavailable." });
          return true;
        }
        const itemMatch = property.exec(url.pathname);
        if (itemMatch) {
          if (request.method !== "PATCH" && request.method !== "DELETE") return method(response, "PATCH or DELETE");
          const collectionId = decodeURIComponent(itemMatch[1]!); const propertyId = decodeURIComponent(itemMatch[2]!);
          const result = request.method === "PATCH"
            ? await service.updateProperty(member.accountId, collectionId, propertyId, await readJson(request))
            : await service.deleteProperty(member.accountId, collectionId, propertyId, await readJson(request));
          if (result.status === "updated") json(response, 200, { collection: result.collection,
            ...("impact" in result ? { impact: result.impact } : {}) });
          else if (result.status === "primary_property_required") json(response, 409, { error: result.status,
            message: "Keep one primary text property so every record remains identifiable." });
          else if (result.status === "impact_changed") json(response, 409, { error: result.status, impact: result.impact,
            message: "The property impact changed. Review the updated counts before deleting." });
          else if (result.status === "invalid_property") json(response, 422, { error: result.status,
            message: "The property type or options do not match its saved values." });
          else json(response, 404, { error: result.status, message: "This Collection property is unavailable." });
          return true;
        }
        const propertyMatch = properties.exec(url.pathname);
        if (propertyMatch) {
          if (request.method !== "POST") return method(response, "POST");
          const result = await service.createProperty(member.accountId, decodeURIComponent(propertyMatch[1]!), await readJson(request));
          if (result.status === "created") json(response, 201, { property: result.property });
          else if (result.status === "property_conflict") json(response, 409, { error: result.status, message: "That property identity or position is already in use." });
          else json(response, 404, { error: result.status, message: "This Collection is unavailable." });
          return true;
        }
        const noteMatch = noteCollections.exec(url.pathname);
        if (noteMatch) {
          const noteId = decodeURIComponent(noteMatch[1]!); const operation = noteMatch[2];
          const expected = operation === "impact" ? "GET" : operation ? "POST" : request.method === "GET" ? "GET" : "POST";
          if (request.method !== expected) return method(response, expected);
          const result = operation === "impact" ? await service.previewRemoval(member.accountId, noteId)
            : operation === "relocate" ? await service.relocate(member.accountId, noteId, await readJson(request))
              : operation === "delete" ? await service.delete(member.accountId, noteId, await readJson(request))
                : request.method === "GET" ? await service.listForNote(member.accountId, noteId)
                  : await service.create(member.accountId, noteId, await readJson(request));
          if (result.status === "created") json(response, 201, { collection: result.collection });
          else if (result.status === "found") json(response, 200, "impact" in result ? { impact: result.impact }
            : { workspaceId: result.workspaceId, collections: result.collections,
              availableCollections: result.availableCollections, availableCollectionNotes: result.availableCollectionNotes,
              availableNotes: result.availableNotes, views: result.views });
          else if (result.status === "relocated" || result.status === "deleted") json(response, 200, result);
          else if (result.status === "impact_changed" || result.status === "collection_conflict") json(response, 409,
            { error: result.status, message: "The Collection impact changed. Review it again before continuing." });
          else json(response, 404, { error: result.status, message: "This Note or Collection is unavailable." });
          return true;
        }
        const recordMatch = records.exec(url.pathname);
        if (recordMatch) {
          const collectionId = decodeURIComponent(recordMatch[1]!); const recordId = recordMatch[2] && decodeURIComponent(recordMatch[2]);
          const expected = !recordId || recordMatch[3] ? "POST" : "PATCH";
          if (request.method !== expected) return method(response, expected);
          const result = !recordId ? await service.createRecord(member.accountId, collectionId, await readJson(request))
            : recordMatch[3] ? await service.moveRecord(member.accountId, collectionId, recordId, await readJson(request))
              : await service.updateRecord(member.accountId, collectionId, recordId, await readJson(request));
          if (result.status === "created") json(response, 201, { record: result.record });
          else if (result.status === "updated" || result.status === "moved") json(response, 200, result);
          else if (result.status === "record_conflict") json(response, 409, { error: result.status, message: "That record identity or position is already in use." });
          else if (result.status === "invalid_record") json(response, 422, { error: result.status,
            message: "The saved value no longer matches this Collection property." });
          else json(response, 404, { error: result.status, message: "This Collection record is unavailable." });
          return true;
        }
        const collectionMatch = collection.exec(url.pathname);
        if (collectionMatch) {
          const collectionId = decodeURIComponent(collectionMatch[1]!);
          if (request.method === "GET") {
            const result = await service.read(member.accountId, collectionId);
            if (result.status === "found") json(response, 200, { collection: result.collection });
            else json(response, 404, { error: result.status, message: "This Collection is unavailable." });
          } else if (request.method === "PATCH") {
            const result = await service.rename(member.accountId, collectionId, await readJson(request));
            if (result.status === "updated") json(response, 200, { collection: result.collection });
            else json(response, 404, { error: result.status, message: "This Collection field is unavailable." });
          } else return method(response, "GET or PATCH");
          return true;
        }
        const noteViewMatch = noteViews.exec(url.pathname);
        if (noteViewMatch) {
          if (request.method !== "POST") return method(response, "POST");
          const result = await service.createView(member.accountId, decodeURIComponent(noteViewMatch[1]!), await readJson(request));
          if (result.status === "created") json(response, 201, { view: result.view });
          else if (result.status === "view_conflict") json(response, 409, { error: result.status, message: "That View Block identity is already in use." });
          else json(response, 404, { error: result.status, message: "The Note or View source is unavailable." });
          return true;
        }
        const viewMatch = view.exec(url.pathname)!; const viewId = decodeURIComponent(viewMatch[1]!);
        if (request.method === "GET") {
          const result = await service.readView(member.accountId, viewId);
          if (result.status === "found") json(response, 200, { view: result.view, source: result.source });
          else if (result.status === "source_unavailable") json(response, 403,
            { error: result.status, message: "This View source is unavailable." });
          else json(response, 404, { error: result.status, message: "This View Block is unavailable." });
        } else if (request.method === "PATCH") {
          const result = await service.updateView(member.accountId, viewId, await readJson(request));
          if (result.status === "updated") json(response, 200, result);
          else json(response, result.status === "source_unavailable" ? 403 : 404,
            { error: result.status, message: "This View Block or source is unavailable." });
        } else return method(response, "GET or PATCH");
      } catch (error) {
        if (error instanceof InvalidCollectionInput || error instanceof URIError) json(response, 422,
          { error: "invalid_collection_input", message: "Use valid stable identities and the supported Collection or View fields." });
        else if (error instanceof SyntaxError || error instanceof Error && error.message === "body_too_large") json(response,
          error instanceof SyntaxError ? 400 : 413, { error: error instanceof SyntaxError ? "invalid_json" : "body_too_large", message: "The request could not be read." });
        else json(response, 503, { error: "collections_unavailable", message: "The Collection operation could not be completed. Try again." });
      }
      return true;
    },
  };
}

function method(response: import("node:http").ServerResponse, allow: string) {
  response.setHeader("allow", allow); json(response, 405, { error: "method_not_allowed", message: `Use ${allow} for this operation.` }); return true;
}
