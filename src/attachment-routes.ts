import type { IncomingMessage, ServerResponse } from "node:http";
import { json, type HttpRoute } from "./http-routing.js";
import { InvalidAttachment, type AttachmentService, type AttachmentSource } from "./attachments.js";
import type { MemberAccessResolver } from "./workspaces-projects.js";

async function readBodyWithLimit(request: IncomingMessage, maximum: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const value of request) {
    const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
    size += chunk.length;
    if (size > maximum) throw new InvalidAttachment("size");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

async function download(service: AttachmentService, memberId: string, response: ServerResponse, url: URL) {
  const result = await service.get(memberId, decodeURIComponent(url.pathname.split("/")[3]!));
  if (!result) { json(response, 404, { error: "attachment_not_found", message: "This Attachment is unavailable." }); return; }
  response.writeHead(200, {
    "content-type": result.record.contentType,
    "content-length": result.record.size,
    "content-disposition": `attachment; filename*=UTF-8''${encodeURIComponent(result.record.filename)}`,
    "x-content-type-options": "nosniff",
    "cache-control": "private, no-store",
  });
  response.end(result.content);
}

async function upload(service: AttachmentService, memberId: string, request: IncomingMessage, response: ServerResponse, url: URL) {
  const filename = request.headers["x-stash-filename"];
  const source = request.headers["x-stash-source"] ?? "upload";
  if (typeof filename !== "string" || (source !== "upload" && source !== "paste")) throw new InvalidAttachment("filename");
  const result = await service.create(memberId, decodeURIComponent(url.pathname.split("/")[3]!), {
    filename,
    contentType: request.headers["content-type"]?.split(";", 1)[0]?.trim().toLowerCase() ?? "application/octet-stream",
    source: source as AttachmentSource,
    content: await readBodyWithLimit(request, 10 * 1024 * 1024 + 1),
  });
  if (result.status === "workspace_forbidden") { json(response, 403, { error: "workspace_forbidden", message: "This Member cannot add Attachments to that Workspace." }); return; }
  const { createdByMemberId: _, storageKey: __, ...attachment } = result.record;
  json(response, 201, { ...attachment, contentUrl: `/api/attachments/${attachment.id}/content`, portableLink: `[${attachment.filename}](<${attachment.relativePath}>)`, portableProjection: { format: result.projection.schema, state: "recorded" } });
}

export function attachmentRoutes(service: AttachmentService, access: MemberAccessResolver): HttpRoute {
  return {
    matches: (request, url) => request.method === "POST" && /^\/api\/workspaces\/[^/]+\/attachments$/.test(url.pathname)
      || request.method === "GET" && /^\/api\/attachments\/[^/]+\/content$/.test(url.pathname),
    async handle(request, response, url) {
      const member = await access.authenticateBearer(request.headers.authorization);
      if (!member) { json(response, 401, { error: "unauthorized", message: "A valid Member session is required." }); return true; }
      try {
        if (request.method === "GET") await download(service, member.accountId, response, url);
        else await upload(service, member.accountId, request, response, url);
      } catch (error) {
        if (error instanceof InvalidAttachment) {
          const status = error.kind === "size" ? 413 : error.kind === "content_type" ? 415 : 422;
          json(response, status, { error: `invalid_attachment_${error.kind}`, message: error.kind === "size" ? "The Attachment is empty or exceeds the configured size limit." : "The Attachment filename or content type is not supported." });
        } else json(response, 503, { error: "attachment_unavailable", message: "The Attachment could not be stored or retrieved. Try again." });
      }
      return true;
    },
  };
}
