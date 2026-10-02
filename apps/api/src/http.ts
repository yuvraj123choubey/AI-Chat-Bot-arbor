import type { IncomingMessage, ServerResponse } from "node:http";

export class RequestError extends Error {
  constructor(public readonly status: number, message: string) { super(message); }
}
export function send(res: ServerResponse, status: number, data: unknown) {
  if (!res.headersSent) res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(data));
}
export async function readBody(req: IncomingMessage, limit = 100_000): Promise<Buffer> {
  const parts: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new RequestError(413, "Request too large");
    parts.push(chunk);
  }
  return Buffer.concat(parts);
}
export async function readJson(req: IncomingMessage): Promise<any> {
  const body = (await readBody(req)).toString("utf8");
  if (!body) return {};
  try { return JSON.parse(body); } catch { throw new RequestError(400, "Request body must be valid JSON"); }
}

/** Newline-delimited JSON stream with an abort signal tied to the client connection. */
export function ndjson(res: ServerResponse) {
  const abort = new AbortController();
  res.on("close", () => { if (!res.writableEnded) abort.abort(); });
  res.writeHead(200, { "content-type": "application/x-ndjson; charset=utf-8", "x-accel-buffering": "no", "cache-control": "no-store" });
  return {
    signal: abort.signal,
    write(data: unknown) { if (!res.writableEnded && !res.destroyed) res.write(`${JSON.stringify(data)}\n`); },
    end() { if (!res.writableEnded) res.end(); }
  };
}

export interface RouteContext { req: IncomingMessage; res: ServerResponse; params: string[]; query: URLSearchParams }
type Handler = (ctx: RouteContext) => Promise<unknown> | unknown;
/** Minimal router: routes are [method, path pattern] → handler; `:param` segments are captured in order. */
export class Router {
  private readonly routes: { method: string; pattern: RegExp; handler: Handler }[] = [];
  on(method: string, path: string, handler: Handler) {
    this.routes.push({ method, pattern: new RegExp(`^${path.replace(/:[a-zA-Z]+/g, "([^/]+)")}$`), handler });
    return this;
  }
  match(method: string, pathname: string): { handler: Handler; params: string[] } | undefined {
    for (const route of this.routes) {
      if (route.method !== method) continue;
      const m = pathname.match(route.pattern);
      if (m) return { handler: route.handler, params: m.slice(1).map(decodeURIComponent) };
    }
    return undefined;
  }
}
