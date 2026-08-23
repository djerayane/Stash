import type { IncomingMessage } from "node:http";

import { json, type HttpRoute } from "./http-routing.js";
import { InvalidPortableWorkspaceImport, PortableWorkspaceImportTooLarge, UnsupportedPortableWorkspaceImport, type PortableWorkspaceImportService } from "./portable-workspace-import.js";

async function body(request: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = []; let size = 0;
  for await (const chunk of request) { const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk); size += bytes.length;
    if (size > 256 * 1024 * 1024) throw new PortableWorkspaceImportTooLarge(); chunks.push(bytes); }
  return Buffer.concat(chunks);
}
export function portableWorkspaceImportRoute(service: PortableWorkspaceImportService): HttpRoute {
  return { matches(request, url) { return request.method === "POST" && url.pathname === "/api/workspace-imports"; },
    async handle(request, response) {
      const importId = request.headers["idempotency-key"];
      const ownerAccountId = request.headers["x-stash-import-owner-account-id"];
      if (typeof importId !== "string" || typeof ownerAccountId !== "string") { json(response, 422, { error: "invalid_import_request", message: "UUID Idempotency-Key and X-Stash-Import-Owner-Account-Id headers are required." }); return true; }
      try {
        const result = await service.import(importId, ownerAccountId, await body(request));
        if (result.status === "forbidden") { json(response, 403, { error: "import_forbidden", message: "Workspace import permission is required." }); return true; }
        if (result.status === "workspace_conflict") { json(response, 409, { error: "workspace_conflict", message: "The Workspace identity already exists with different content." }); return true; }
        json(response, result.status === "imported" ? 201 : 200, { status: result.status, report: result.report });
      } catch (error) {
        if (error instanceof PortableWorkspaceImportTooLarge) json(response, 413, { error: "import_too_large", message: "The archive exceeds the safe import limit." });
        else if (error instanceof UnsupportedPortableWorkspaceImport) json(response, 422, { error: "unsupported_import", message: "The portable archive version or encoding is not supported." });
        else if (error instanceof InvalidPortableWorkspaceImport) json(response, 422, { error: "invalid_import", message: "The portable archive failed validation. Nothing was imported." });
        else json(response, 503, { error: "import_unavailable", message: "The Workspace import could not be completed. Nothing was imported." });
      } return true;
    } };
}
