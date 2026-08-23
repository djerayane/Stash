import { DiscussionService, InvalidDiscussionInput } from "./discussions.js";
import { json, readJson, type HttpRoute } from "./http-routing.js";
import type { MemberAccessResolver } from "./workspaces-projects.js";

export function discussionRoutes(service: DiscussionService, memberAccess: MemberAccessResolver): HttpRoute {
  return {
    matches: (request, url) => (request.method === "POST" && url.pathname === "/api/discussions")
      || (request.method === "GET" && /^\/api\/(notes|tasks)\/[^/]+\/discussions$/.test(url.pathname))
      || (request.method === "GET" && /^\/api\/notes\/[^/]+\/blocks\/[^/]+\/discussions$/.test(url.pathname))
      || (["GET"].includes(request.method ?? "") && /^\/api\/discussions\/[^/]+$/.test(url.pathname))
      || (request.method === "POST" && /^\/api\/discussions\/[^/]+\/messages$/.test(url.pathname))
      || (request.method === "POST" && /^\/api\/discussions\/[^/]+\/work$/.test(url.pathname))
      || (request.method === "PUT" && /^\/api\/discussions\/[^/]+\/resolution$/.test(url.pathname)),
    async handle(request, response, url) {
      const access = await memberAccess.authenticateBearer(request.headers.authorization);
      if (!access) { json(response, 401, { error: "unauthorized", message: "A valid Member session is required." }); return true; }
      try {
        if (request.method === "GET" && url.pathname.endsWith("/discussions")) {
          let targetId: string;
          try { targetId = decodeURIComponent(url.pathname.split("/")[3]!); } catch { throw new InvalidDiscussionInput(); }
          const blockRoute = url.pathname.includes("/blocks/");
          let blockKey = "";
          if (blockRoute) try { blockKey = decodeURIComponent(url.pathname.split("/")[5]!); } catch { throw new InvalidDiscussionInput(); }
          const result = blockRoute
            ? await service.listForBlock(access.accountId, targetId, blockKey)
            : url.pathname.startsWith("/api/notes/") ? await service.listForNote(access.accountId, targetId)
            : await service.listForTask(access.accountId, targetId);
          if (result.status === "found") json(response, 200, { discussions: result.discussions });
          else json(response, 404, { error: "target_not_found", message: "The Discussion target is unavailable." });
          return true;
        }
        if (url.pathname === "/api/discussions") {
          const result = await service.create(access.accountId, await readJson(request));
          if (result.status === "created") json(response, 201, { discussion: result.discussion, projection: { status: "recorded", schema: result.projection.schema } });
          else if (result.status === "forbidden") json(response, 403, { error: result.status, message: "Project Guests cannot create Discussions." });
          else if (result.status === "ambiguous_block") json(response, 422, { error: result.status, message: "That Block identity is ambiguous. Repair the Note before starting a Discussion." });
          else json(response, 404, { error: result.status, message: "The Discussion target is unavailable." });
          return true;
        }
        let discussionId: string;
        try { discussionId = decodeURIComponent(url.pathname.split("/")[3]!); } catch { throw new InvalidDiscussionInput(); }
        if (request.method === "GET") {
          const result = await service.get(access.accountId, discussionId);
          if (result.status === "found") json(response, 200, { discussion: result.discussion });
          else json(response, 404, { error: "discussion_not_found", message: "This Discussion is unavailable." });
          return true;
        }
        if (url.pathname.endsWith("/work")) {
          const result = await service.createWork(access.accountId, discussionId, await readJson(request));
          if (result.status === "created" || result.status === "duplicate") json(response, result.status === "created" ? 201 : 200, {
            result: result.status, work: result.work, activity: result.activity,
            projections: result.projections.map(({ schema }) => ({ schema, status: "recorded" })),
          });
          else if (result.status === "forbidden") json(response, 403, { error: result.status, message: "Project Guests cannot create durable work from Discussions." });
          else if (result.status === "message_not_found") json(response, 422, { error: result.status, message: "Every selected message must belong to this Discussion." });
          else if (result.status === "project_forbidden") json(response, 404, { error: result.status, message: "The destination Project is unavailable." });
          else if (result.status === "idempotency_conflict") json(response, 409, { error: result.status, message: "That idempotency key was already used for different work." });
          else json(response, 404, { error: "discussion_not_found", message: "This Discussion is unavailable." });
          return true;
        }
        if (url.pathname.endsWith("/messages")) {
          const result = await service.reply(access.accountId, discussionId, await readJson(request));
          if (result.status === "updated") json(response, 201, { discussion: result.discussion, projection: { status: "recorded", schema: result.projection.schema } });
          else if (result.status === "forbidden") json(response, 403, { error: result.status, message: "Project Guests cannot reply to Discussions." });
          else if (result.status === "resolved") json(response, 409, { error: "discussion_resolved", message: "Resolved Discussions are retained and cannot receive new messages." });
          else json(response, 404, { error: "discussion_not_found", message: "This Discussion is unavailable." });
          return true;
        }
        const result = await service.resolve(access.accountId, discussionId, await readJson(request));
        if (result.status === "resolved" || result.status === "already_resolved") json(response, 200, { result: result.status, discussion: result.discussion,
          ...(result.status === "resolved" ? { projection: { status: "recorded", schema: result.projection.schema } } : {}) });
        else if (result.status === "forbidden") json(response, 403, { error: result.status, message: "Project Guests cannot resolve Discussions." });
        else json(response, 404, { error: "discussion_not_found", message: "This Discussion is unavailable." });
      } catch (error) {
        if (error instanceof InvalidDiscussionInput) json(response, 422, { error: "invalid_input", message: "The Discussion request contains invalid input." });
        else if (error instanceof SyntaxError || error instanceof Error && error.message === "body_too_large")
          json(response, error instanceof SyntaxError ? 400 : 413, { error: error instanceof SyntaxError ? "invalid_json" : "body_too_large", message: "The request could not be read." });
        else json(response, 503, { error: "discussion_unavailable", message: "The Discussion change could not be saved. Try again." });
      }
      return true;
    },
  };
}
