import type { IncomingMessage } from "node:http";

import { json, type HttpRoute } from "./http-routing.js";
import { GitHubSignalNotFound, GitHubSignalWriteForbidden, InvalidGitHubSignalInput, InvalidGitHubWebhook, type GitHubSignalService } from "./github-signals.js";
import type { MemberAccessResolver } from "./workspaces-projects.js";

const memberPath = /^\/api\/projects\/([^/]+)\/tasks\/([^/]+)\/development-signals(?:\/suggestions\/([^/]+)\/confirm)?$/;

export function githubWebhookRoute(service: GitHubSignalService): HttpRoute {
  return { matches: (_request, url) => url.pathname === "/api/github/webhooks", async handle(request, response) {
    if (request.method !== "POST") { json(response, 405, { error: "method_not_allowed", message: "This GitHub webhook operation is not supported." }); return true; }
    let raw: Buffer;
    try { raw = await readRaw(request); } catch { json(response, 413, { error: "payload_too_large", message: "The GitHub webhook payload is too large." }); return true; }
    if (!service.verify(raw, header(request, "x-hub-signature-256"))) { json(response, 401, { error: "invalid_signature", message: "The GitHub webhook signature is invalid." }); return true; }
    try {
      await service.receive(header(request, "x-github-event"), header(request, "x-github-delivery"), raw);
      json(response, 202, { accepted: true });
    } catch (error) {
      if (error instanceof InvalidGitHubWebhook || error instanceof InvalidGitHubSignalInput) json(response, 400, { error: "invalid_github_event", message: "The GitHub event is not supported or is invalid." });
      else json(response, 503, { error: "github_signal_unavailable", message: "The GitHub Signal could not be stored. GitHub can retry this delivery." });
    }
    return true;
  } };
}

export function githubSignalRoutes(service: GitHubSignalService, access: MemberAccessResolver): HttpRoute {
  return { matches: (_request, url) => memberPath.test(url.pathname), async handle(request, response, url) {
    const member = await access.authenticateBearer(request.headers.authorization);
    if (!member) { json(response, 401, { error: "unauthorized", message: "A valid Member session is required." }); return true; }
    try {
      const [, encodedProject, encodedKey, suggestionId] = url.pathname.match(memberPath)!;
      const projectId = decodeURIComponent(encodedProject!); const key = decodeURIComponent(encodedKey!);
      if (request.method === "GET" && !suggestionId) json(response, 200, { signals: await service.list(member.accountId, projectId, key) });
      else if (request.method === "POST" && suggestionId) json(response, 200, { suggestion: await service.confirm(member.accountId, projectId, key, decodeURIComponent(suggestionId)) });
      else json(response, 405, { error: "method_not_allowed", message: "This development Signal operation is not supported." });
    } catch (error) {
      if (error instanceof InvalidGitHubSignalInput || error instanceof URIError) json(response, 422, { error: "invalid_input", message: "Development Signal values must be valid." });
      else if (error instanceof GitHubSignalWriteForbidden) json(response, 403, { error: "project_forbidden", message: "This Member cannot confirm development Signals for that Task." });
      else if (error instanceof GitHubSignalNotFound) json(response, 404, { error: "development_signal_not_found", message: "That Task or Signal is unavailable in this Project." });
      else json(response, 503, { error: "development_signals_unavailable", message: "Development Signals are unavailable. Try again." });
    }
    return true;
  } };
}

function header(request: IncomingMessage, name: string) { const value = request.headers[name]; return Array.isArray(value) ? value[0] : value; }
async function readRaw(request: IncomingMessage) { const chunks: Buffer[] = []; let size = 0; for await (const chunk of request) { const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk); size += buffer.length; if (size > 1024 * 1024) throw new Error("body_too_large"); chunks.push(buffer); } return Buffer.concat(chunks); }
