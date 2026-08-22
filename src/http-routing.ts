import type { IncomingMessage, ServerResponse } from "node:http";

export interface HttpRoute {
  matches(request: IncomingMessage, url: URL): boolean;
  handle(request: IncomingMessage, response: ServerResponse, url: URL): Promise<boolean> | boolean;
}

export function json(response: ServerResponse, status: number, body: object): void {
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  response.end(JSON.stringify(body));
}

export async function readJson(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > 64 * 1024) throw new Error("body_too_large");
    chunks.push(buffer);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

export function requireInstanceAdministrator(token: string, route: HttpRoute): HttpRoute {
  return {
    matches: route.matches,
    async handle(request, response, url) {
      if (request.headers.authorization !== `Bearer ${token}`) {
        json(response, 401, {
          error: "unauthorized",
          message: "A valid Instance Administrator bearer token is required.",
        });
        return true;
      }
      return route.handle(request, response, url);
    },
  };
}
