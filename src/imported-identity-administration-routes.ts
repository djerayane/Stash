import type { IncomingMessage } from "node:http";

import { json, readJson, type HttpRoute } from "./http-routing.js";
import type { MemberAccessResolver } from "./workspaces-projects.js";

export interface PendingImportedIdentity {
  importId: string;
  workspaceId: string;
  workspaceName: string;
  sourceAccountId: string;
  displayName: string;
}

export interface ImportedIdentityAdministration {
  listPendingImportedIdentities(memberId: string): Promise<PendingImportedIdentity[]>;
  mapImportedIdentityAsMember(memberId: string, input: {
    importId: string; sourceAccountId: string; localAccountId: string; idempotencyKey: string;
  }): Promise<{ status: "mapped" | "duplicate" } | { status: "forbidden" | "not_found" | "conflict" | "local_account_not_found" }>;
}
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function importedIdentityAdministrationRoutes(service: ImportedIdentityAdministration, members: MemberAccessResolver): HttpRoute {
  return {
    matches(request, url) {
      return url.pathname === "/api/imported-identities" && request.method === "GET"
        || url.pathname === "/api/imported-identity-mappings" && request.method === "POST";
    },
    async handle(request, response, url) {
      const principal = await members.authenticateBearer(request.headers.authorization);
      if (!principal) { json(response, 401, { error: "unauthorized", message: "A valid Member session is required." }); return true; }
      try {
        if (url.pathname === "/api/imported-identities") {
          json(response, 200, { identities: await service.listPendingImportedIdentities(principal.accountId) }); return true;
        }
        const value = await readJson(request);
        const key = request.headers["idempotency-key"];
        if (!value || typeof value !== "object" || Array.isArray(value) || typeof key !== "string") throw new TypeError();
        const input = value as Record<string, unknown>;
        if (Object.keys(input).some((field) => !["importId", "sourceAccountId", "localAccountId"].includes(field))
          || ![input.importId, input.sourceAccountId, input.localAccountId, key].every((field) => typeof field === "string" && uuid.test(field))) throw new TypeError();
        const result = await service.mapImportedIdentityAsMember(principal.accountId, {
          importId: input.importId as string, sourceAccountId: input.sourceAccountId as string,
          localAccountId: input.localAccountId as string, idempotencyKey: key,
        });
        if (result.status === "forbidden") json(response, 403, { error: "forbidden", message: "Import administration permission is required." });
        else if (result.status === "not_found" || result.status === "local_account_not_found") json(response, 404, { error: result.status, message: "The imported identity or eligible Member was not found." });
        else if (result.status === "conflict") json(response, 409, { error: "identity_mapping_conflict", message: "This identity was already mapped differently." });
        else json(response, result.status === "mapped" ? 201 : 200, result);
      } catch (error) {
        const invalid = error instanceof TypeError || error instanceof SyntaxError || error instanceof Error && error.message === "body_too_large";
        json(response, invalid ? 422 : 503, invalid
          ? { error: "invalid_identity_mapping", message: "Valid identity mapping fields are required." }
          : { error: "identity_mapping_unavailable", message: "The identity mapping could not be completed. No attribution was changed." });
      }
      return true;
    },
  };
}
