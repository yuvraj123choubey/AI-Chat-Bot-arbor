import { extname } from "node:path";
import { CommandError, PathError, templates } from "../../../../packages/code/src/index.ts";
import type { App } from "../app.ts";
import { ndjson, readBody, RequestError, send, type RouteContext } from "../http.ts";
import { parseWorkspace } from "./chat.ts";

const mime: Record<string, string> = {
  ".html": "text/html; charset=utf-8", ".htm": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".mjs": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8", ".svg": "image/svg+xml", ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp",
  ".ico": "image/x-icon", ".txt": "text/plain; charset=utf-8", ".md": "text/plain; charset=utf-8", ".woff2": "font/woff2", ".woff": "font/woff", ".wasm": "application/wasm", ".map": "application/json"
};

/** Coding projects: CRUD, files, search, version history, commands, preview and the coding agent. */
export function projectRoutes(app: App) {
  const workspaceOf = async (query: URLSearchParams) => {
    const slug = parseWorkspace(query.get("workspaceId") ?? undefined);
    if (!slug) throw new RequestError(400, "Invalid workspace");
    return app.workspace(slug);
  };
  const open = async ({ query, params }: RouteContext) => {
    const project = await app.projects.open(await workspaceOf(query), params[0]);
    if (!project) throw new RequestError(404, "Project not found");
    return project;
  };
  /** Project file uploads can be large; they come as JSON (base64 for binary files) under a 15 MB limit. */
  const body = async (ctx: RouteContext, limit = 100_000) => {
    const raw = (await readBody(ctx.req, limit)).toString("utf8");
    try { return raw ? JSON.parse(raw) : {}; } catch { throw new RequestError(400, "Request body must be valid JSON"); }
  };
  /** File-system and command errors are the user's to fix, so they come back as 400 with the reason. */
  const guarded = (handler: (ctx: RouteContext) => Promise<unknown>) => async (ctx: RouteContext) => {
    try { return await handler(ctx); }
    catch (error) {
      if (error instanceof PathError || error instanceof CommandError) return send(ctx.res, 400, { error: error.message });
      throw error;
    }
  };

  return {
    templates: ({ res }: RouteContext) => send(res, 200, Object.entries(templates).map(([id, t]) => ({ id, label: t.label, description: t.description }))),
    list: async ({ res, query }: RouteContext) => send(res, 200, await app.projects.list(await workspaceOf(query))),
    create: guarded(async ctx => {
      const input = await body(ctx);
      const name = typeof input.name === "string" ? input.name.trim() : "";
      if (!name || name.length > 120) return send(ctx.res, 400, { error: "Project name must contain 1–120 characters" });
      return send(ctx.res, 201, await app.projects.create(await workspaceOf(ctx.query), name, typeof input.template === "string" ? input.template : "blank"));
    }),
    get: async ({ res, query, params }: RouteContext) => {
      const view = await app.projects.get(await workspaceOf(query), params[0]);
      return view ? send(res, 200, view) : send(res, 404, { error: "Project not found" });
    },
    rename: async (ctx: RouteContext) => {
      const input = await body(ctx);
      const name = typeof input.name === "string" ? input.name.trim() : "";
      if (!name || name.length > 120) return send(ctx.res, 400, { error: "Project name must contain 1–120 characters" });
      return (await app.projects.rename(await workspaceOf(ctx.query), ctx.params[0], name)) ? send(ctx.res, 200, { ok: true }) : send(ctx.res, 404, { error: "Project not found" });
    },
    remove: async ({ res, query, params }: RouteContext) => (await app.projects.remove(await workspaceOf(query), params[0])) ? send(res, 200, { ok: true }) : send(res, 404, { error: "Project not found" }),

    tree: guarded(async ctx => send(ctx.res, 200, await (await open(ctx)).files.tree())),
    readFile: guarded(async ctx => send(ctx.res, 200, await (await open(ctx)).files.read(ctx.query.get("path") ?? ""))),
    /** Raw bytes of a project file (images in the explorer). */
    rawFile: guarded(async ctx => {
      const project = await open(ctx);
      const path = ctx.query.get("path") ?? "";
      const bytes = await project.files.readBytes(path);
      ctx.res.writeHead(200, { "content-type": mime[extname(path).toLowerCase()] ?? "application/octet-stream", "content-security-policy": "sandbox", "x-content-type-options": "nosniff" });
      ctx.res.end(bytes);
    }),
    writeFile: guarded(async ctx => {
      const project = await open(ctx);
      const input = await body(ctx, 15 * 1024 * 1024);
      if (typeof input.path !== "string") return send(ctx.res, 400, { error: "path is required" });
      if (typeof input.content === "string") await project.files.write(input.path, input.content);
      else if (typeof input.contentBase64 === "string") await project.files.write(input.path, Buffer.from(input.contentBase64, "base64"));
      else return send(ctx.res, 400, { error: "content or contentBase64 is required" });
      return send(ctx.res, 200, { ok: true });
    }),
    fs: guarded(async ctx => {
      const project = await open(ctx);
      const input = await body(ctx);
      if (input.op === "mkdir") await project.files.mkdir(String(input.path ?? ""));
      else if (input.op === "rename") await project.files.rename(String(input.path ?? ""), String(input.to ?? ""));
      else if (input.op === "delete") await project.files.remove(String(input.path ?? ""));
      else return send(ctx.res, 400, { error: "op must be mkdir, rename or delete" });
      return send(ctx.res, 200, { ok: true });
    }),
    search: guarded(async ctx => send(ctx.res, 200, await (await open(ctx)).files.search((ctx.query.get("q") ?? "").slice(0, 200)))),

    history: guarded(async ctx => send(ctx.res, 200, await (await open(ctx)).history.log(100))),
    pending: guarded(async ctx => send(ctx.res, 200, await (await open(ctx)).history.pending())),
    checkpointDiff: guarded(async ctx => {
      if (!/^[0-9a-f]{7,40}$/i.test(ctx.params[1])) return send(ctx.res, 400, { error: "Invalid checkpoint" });
      const from = ctx.query.get("from");
      if (from && !/^[0-9a-f]{7,40}$/i.test(from)) return send(ctx.res, 400, { error: "Invalid checkpoint" });
      const history = (await open(ctx)).history;
      return send(ctx.res, 200, from ? await history.diff(from, ctx.params[1]) : await history.changesIn(ctx.params[1]));
    }),
    checkpoint: guarded(async ctx => {
      const input = await body(ctx);
      const label = typeof input.label === "string" && input.label.trim() ? input.label.trim().slice(0, 200) : "Saved version";
      const created = await (await open(ctx)).history.checkpoint(label, "you");
      return send(ctx.res, created ? 201 : 200, created ?? { unchanged: true });
    }),
    restore: guarded(async ctx => {
      const project = await open(ctx);
      const log = await project.history.log(500);
      const target = log.find(c => c.commit.startsWith(ctx.params[1]));
      if (!target) return send(ctx.res, 404, { error: "Checkpoint not found" });
      return send(ctx.res, 200, (await project.history.restore(target.commit, target.message.slice(0, 120))) ?? { unchanged: true });
    }),

    runs: guarded(async ctx => send(ctx.res, 200, app.projects.runner.list((await open(ctx)).id))),
    run: guarded(async ctx => {
      const project = await open(ctx);
      const input = await body(ctx);
      if (typeof input.command !== "string") return send(ctx.res, 400, { error: "command is required" });
      const timeout = Math.min(Math.max(Number(input.timeoutSeconds) || 120, 5), 1800) * 1000;
      return send(ctx.res, 202, app.projects.runner.start({ projectId: project.id, cwd: project.root, command: input.command, timeoutMs: timeout }));
    }),
    /** NDJSON: the output so far, then live output, then one `end` event. */
    runEvents: guarded(async ctx => {
      const project = await open(ctx);
      const info = app.projects.runner.get(ctx.params[1]);
      if (!info || info.projectId !== project.id) return send(ctx.res, 404, { error: "Run not found (finished runs are kept for 30 minutes)" });
      const stream = ndjson(ctx.res);
      await new Promise<void>(resolve => {
        const unsubscribe = app.projects.runner.subscribe(info.id, event => { stream.write(event); if (event.type === "end") { resolve(); } });
        stream.signal.addEventListener("abort", () => { unsubscribe(); resolve(); }, { once: true });
      });
      stream.end();
    }),
    cancelRun: guarded(async ctx => {
      const project = await open(ctx);
      const info = app.projects.runner.get(ctx.params[1]);
      if (!info || info.projectId !== project.id) return send(ctx.res, 404, { error: "Run not found" });
      return send(ctx.res, 200, { cancelled: app.projects.runner.cancel(info.id) });
    }),

    preview: guarded(async ctx => {
      const project = await open(ctx);
      return send(ctx.res, 200, app.projects.previews.get(project.id) ?? { status: "idle" });
    }),
    previewAction: guarded(async ctx => {
      const project = await open(ctx);
      const input = await body(ctx);
      if (input.action === "stop") { app.projects.previews.stop(project.id); return send(ctx.res, 200, { status: "idle" }); }
      const staticUrl = `/api/projects/${project.id}/static/index.html?workspaceId=${encodeURIComponent(ctx.query.get("workspaceId") ?? "default")}`;
      return send(ctx.res, 200, await app.projects.previews.start(project.id, project.root, staticUrl));
    }),
    /**
     * Serves a static project for preview. The sandbox policy gives the page an opaque origin, so a project's
     * scripts cannot call Arbor's API or read its data even though they are served from the same host.
     */
    static: async (ctx: RouteContext) => {
      try {
        const project = await open(ctx);
        let path = ctx.params[1] || "index.html";
        if (path.endsWith("/")) path += "index.html";
        const bytes = await project.files.readBytes(path);
        ctx.res.writeHead(200, { "content-type": mime[extname(path).toLowerCase()] ?? "application/octet-stream", "content-security-policy": "sandbox allow-scripts allow-forms allow-modals allow-popups", "x-content-type-options": "nosniff", "cache-control": "no-store" });
        ctx.res.end(bytes);
      } catch (error) {
        if (error instanceof RequestError) throw error;
        ctx.res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
        ctx.res.end("Not found in this project");
      }
    },

    startAgent: guarded(async ctx => {
      const project = await open(ctx);
      const input = await body(ctx);
      const task = typeof input.task === "string" ? input.task.trim() : "";
      if (task.length < 3 || task.length > 4000) return send(ctx.res, 400, { error: "Describe the change in 3–4,000 characters" });
      if (!app.chatModels().length) return send(ctx.res, 503, { error: "No AI model is available. Start the local model server or configure a provider." });
      const workspaceId = await workspaceOf(ctx.query);
      const taskId = await app.tasks.submit({ workspaceId, userId: app.identity.userId, type: "code_agent", title: `Code: ${task.slice(0, 120)}`, input: { projectId: project.id, task, selectedModel: typeof input.selectedModel === "string" ? input.selectedModel : "auto", context: typeof input.context === "string" ? input.context.slice(0, 8000) : "" } });
      return send(ctx.res, 202, { taskId });
    }),
    agentRuns: guarded(async ctx => {
      const project = await open(ctx);
      const rows = await app.db.task.findMany({ where: { type: "code_agent", workspaceId: await workspaceOf(ctx.query), input: { path: ["projectId"], equals: project.id } }, orderBy: { createdAt: "desc" }, take: 20 });
      return send(ctx.res, 200, rows.map(r => ({ taskId: r.id, task: (r.input as { task?: string }).task ?? r.title, status: r.status, error: r.error, output: r.output, createdAt: r.createdAt.toISOString(), finishedAt: r.finishedAt?.toISOString() ?? null })));
    })
  };
}
