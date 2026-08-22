import { json, readJson, type HttpRoute } from "./http-routing.js";
import {
  InvalidProjectInput,
  InvalidWorkspaceInput,
  type MemberAccessResolver,
  type WorkspaceProjectService,
} from "./workspaces-projects.js";

export function workspaceProjectRoutes(
  service: WorkspaceProjectService,
  memberAccess: MemberAccessResolver,
): HttpRoute {
  return {
    matches: (request, url) => request.method === "POST" && (
      url.pathname === "/api/workspaces"
      || /^\/api\/workspaces\/[^/]+\/projects$/.test(url.pathname)
    ),
    async handle(request, response, url) {
      const access = await memberAccess.authenticateBearer(request.headers.authorization);
      if (!access) {
        json(response, 401, {
          error: "unauthorized",
          message: "A valid Member session is required.",
        });
        return true;
      }

      try {
        const input = await readJson(request);
        if (url.pathname === "/api/workspaces") {
          const result = await service.createWorkspace(access.accountId, input);
          if (result.status === "organization_forbidden") {
            json(response, 403, {
              error: result.status,
              message: "This Member cannot create Workspaces for that Organization.",
            });
          } else {
            const { createdByMemberId: _, ...workspace } = result.workspace;
            json(response, 201, {
              ...workspace,
              portableProjection: { format: "stash.workspace.v1", state: "recorded" },
            });
          }
          return true;
        }

        let workspaceId: string;
        try {
          workspaceId = decodeURIComponent(url.pathname.split("/")[3]!);
        } catch {
          throw new InvalidProjectInput();
        }
        const result = await service.createProject(access.accountId, workspaceId, input);
        if (result.status === "created") {
          const { createdByMemberId: _, ...project } = result.project;
          json(response, 201, {
            ...project,
            portableProjection: { format: "stash.project.v1", state: "recorded" },
          });
        } else if (result.status === "key_conflict") {
          json(response, 409, {
            error: result.status,
            message: "Project keys must be unique within a Workspace.",
          });
        } else {
          json(response, 403, {
            error: "workspace_forbidden",
            message: "This Member cannot create Projects in that Workspace.",
          });
        }
      } catch (error) {
        if (error instanceof InvalidWorkspaceInput || error instanceof InvalidProjectInput) {
          json(response, 422, {
            error: "invalid_input",
            message: error instanceof InvalidWorkspaceInput
              ? "A Workspace requires a valid name and personal or Organization owner."
              : "A Project requires a valid Workspace id, name, and 2-20 character key.",
          });
          return true;
        }
        const tooLarge = error instanceof Error && error.message === "body_too_large";
        if (tooLarge || error instanceof SyntaxError) {
          json(response, tooLarge ? 413 : 400, {
            error: tooLarge ? "body_too_large" : "invalid_json",
            message: tooLarge
              ? "Request body exceeds the 64 KiB limit."
              : "Request body must be valid JSON.",
          });
          return true;
        }
        json(response, 503, {
          error: "workspace_unavailable",
          message: "The Workspace or Project could not be created. Try again.",
        });
      }
      return true;
    },
  };
}
