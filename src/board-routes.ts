import { json, readJson, type HttpRoute } from "./http-routing.js";
import { InvalidBoardInput, type BoardService } from "./boards.js";
import type { MemberAccessResolver } from "./workspaces-projects.js";
const base = /^\/api\/projects\/([^/]+)\/boards$/;
const one = /^\/api\/projects\/([^/]+)\/boards\/([^/]+)$/;
const move = /^\/api\/projects\/([^/]+)\/boards\/([^/]+)\/tasks\/([^/]+)$/;
export function boardRoutes(service: BoardService, accessResolver: MemberAccessResolver): HttpRoute {
  return { matches: (request,url) => (request.method === "GET" || request.method === "POST") && base.test(url.pathname) || request.method === "GET" && one.test(url.pathname) || request.method === "PATCH" && move.test(url.pathname),
    async handle(request,response,url) {
      const access = await accessResolver.authenticateBearer(request.headers.authorization); if (!access) { json(response,401,{error:"unauthorized",message:"A valid Member session is required."}); return true; }
      try {
        const match = move.exec(url.pathname) ?? one.exec(url.pathname) ?? base.exec(url.pathname)!; const projectId = decodeURIComponent(match[1]!);
        const result = move.test(url.pathname) ? await service.move(access.accountId,projectId,decodeURIComponent(match[2]!),decodeURIComponent(match[3]!),await readJson(request))
          : one.test(url.pathname) ? await service.read(access.accountId,projectId,decodeURIComponent(match[2]!))
          : request.method === "POST" ? await service.create(access.accountId,projectId,await readJson(request)) : await service.list(access.accountId,projectId);
        if (result.status === "created") json(response,201,{board:result.board});
        else if (result.status === "found") json(response,200,"columns" in result ? {board:result.board,columns:result.columns}:{boards:result.boards});
        else if (result.status === "moved") json(response,200,{task:result.task});
        else if (result.status === "forbidden") json(response,403,{error:"project_read_only",message:"Guests can view this Project board but cannot change it."});
        else if (result.status === "invalid_status") json(response,422,{error:result.status,message:"Choose an active status from this Project Workflow."});
        else if (result.status === "unsupported_group") json(response,409,{error:result.status,message:"Only a status-grouped board can move a Task between Workflow statuses."});
        else json(response,404,{error:"board_not_found",message:"This board is unavailable."});
      } catch (error) {
        if (error instanceof InvalidBoardInput || error instanceof URIError) json(response,422,{error:"invalid_input",message:"Provide a valid board name, grouping, Project, Task, and Workflow status."});
        else if (error instanceof SyntaxError || error instanceof Error && error.message === "body_too_large") json(response,error instanceof SyntaxError?400:413,{error:error instanceof SyntaxError?"invalid_json":"body_too_large",message:"The request could not be read."});
        else json(response,503,{error:"board_unavailable",message:"The board could not be loaded or saved. Try again."});
      } return true;
    } };
}
