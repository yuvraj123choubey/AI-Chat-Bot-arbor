import { createServer, type Server } from "node:http";
import type { ProviderName, TaskRequest } from "../../../packages/ai/src/types.ts";
import { redactSecrets } from "../../../packages/ai/src/redact.ts";
import type { App } from "./app.ts";
import { ndjson, readJson, RequestError, Router, send } from "./http.ts";
import { chatRoute } from "./routes/chat.ts";
import { libraryRoutes } from "./routes/library.ts";
import { researchRoutes } from "./routes/research.ts";
import { projectRoutes } from "./routes/projects.ts";
import { documentRoutes } from "./routes/documents.ts";

/** Builds the HTTP server for an app; the route table is the API's public surface. */
export function createHttpServer(app: App): Server {
  const library = libraryRoutes(app);
  const research = researchRoutes(app);
  const projects = projectRoutes(app);
  const documents = documentRoutes(app);
  const router = new Router()
    .on("POST", "/api/documents", documents.upload)
    .on("GET", "/api/documents", documents.list)
    .on("GET", "/api/documents/:id", documents.get)
    .on("GET", "/api/documents/:id/file", documents.file)
    .on("GET", "/api/documents/:id/pages", documents.pages)
    .on("PATCH", "/api/documents/:id", documents.rename)
    .on("POST", "/api/documents/:id/links", documents.link)
    .on("DELETE", "/api/documents/:id/links/:linkId", documents.unlink)
    .on("DELETE", "/api/documents/:id", documents.remove)
    .on("POST", "/api/research", research.start)
    .on("GET", "/api/research", research.list)
    .on("GET", "/api/research/:id", research.get)
    .on("DELETE", "/api/research/:id", research.remove)
    .on("GET", "/api/tasks/:id/events", research.events)
    .on("POST", "/api/tasks/:id/cancel", research.cancel)
    .on("GET", "/api/projects/templates", projects.templates)
    .on("GET", "/api/projects", projects.list)
    .on("POST", "/api/projects", projects.create)
    .on("GET", "/api/projects/:id", projects.get)
    .on("PATCH", "/api/projects/:id", projects.rename)
    .on("DELETE", "/api/projects/:id", projects.remove)
    .on("GET", "/api/projects/:id/tree", projects.tree)
    .on("GET", "/api/projects/:id/file", projects.readFile)
    .on("GET", "/api/projects/:id/raw", projects.rawFile)
    .on("PUT", "/api/projects/:id/file", projects.writeFile)
    .on("POST", "/api/projects/:id/fs", projects.fs)
    .on("GET", "/api/projects/:id/search", projects.search)
    .on("GET", "/api/projects/:id/history", projects.history)
    .on("POST", "/api/projects/:id/history", projects.checkpoint)
    .on("GET", "/api/projects/:id/changes", projects.pending)
    .on("GET", "/api/projects/:id/history/:commit", projects.checkpointDiff)
    .on("POST", "/api/projects/:id/history/:commit/restore", projects.restore)
    .on("GET", "/api/projects/:id/runs", projects.runs)
    .on("POST", "/api/projects/:id/runs", projects.run)
    .on("GET", "/api/projects/:id/runs/:run/events", projects.runEvents)
    .on("POST", "/api/projects/:id/runs/:run/cancel", projects.cancelRun)
    .on("GET", "/api/projects/:id/preview", projects.preview)
    .on("POST", "/api/projects/:id/preview", projects.previewAction)
    // Static preview serves any path inside the project; the last group captures the rest of the URL.
    .on("GET", "/api/projects/:id/static/(.*)", projects.static)
    .on("POST", "/api/projects/:id/agent", projects.startAgent)
    .on("GET", "/api/projects/:id/agent", projects.agentRuns)
    .on("GET", "/api/health", ({ res }) => send(res, 200, { ok: true }))
    .on("GET", "/api/models", library.models)
    .on("GET", "/api/search/providers", library.searchStatus)
    .on("POST", "/api/chat", ctx => chatRoute(app, ctx))
    .on("GET", "/api/conversations", library.listConversations)
    .on("GET", "/api/conversations/:id", library.getConversation)
    .on("PATCH", "/api/conversations/:id", library.renameConversation)
    .on("DELETE", "/api/conversations/:id", library.deleteConversation)
    .on("GET", "/api/sources", library.listSources)
    .on("GET", "/api/sources/:id", library.getSource)
    .on("POST", "/api/sources/:id/save", library.saveSource)
    .on("POST", "/api/tasks", async ({ req, res }) => {
      const task = parseTask(app, await readJson(req));
      return typeof task === "string" ? send(res, 400, { error: task }) : send(res, 200, await app.orchestrator.run(task));
    })
    // Same task as /api/tasks, streamed as NDJSON: progress events while running, then one result or error line.
    .on("POST", "/api/tasks/stream", async ({ req, res }) => {
      const task = parseTask(app, await readJson(req));
      if (typeof task === "string") return send(res, 400, { error: task });
      const stream = ndjson(res);
      try {
        stream.write({ type: "result", result: await app.orchestrator.run(task, { signal: stream.signal, onProgress: event => stream.write({ type: "progress", ...event }) }) });
      } catch (error) { stream.write({ type: "error", error: error instanceof Error ? error.message : "Unexpected error" }); }
      stream.end();
    });

  return createServer(async (req, res) => {
    res.setHeader("cache-control", "no-store");
    try {
      // Only same-machine hosts are served, which blocks DNS-rebinding pages from spending the server's API credit.
      if (!/^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/.test(req.headers.host || "")) return send(res, 403, { error: "Forbidden host" });
      const url = new URL(req.url || "/", "http://localhost");
      // Requiring JSON forces a CORS preflight, so other websites cannot submit cross-origin requests. File uploads
      // must be multipart, which browsers send cross-site without a preflight, so they need a custom header instead.
      const isUpload = req.method === "POST" && url.pathname === "/api/documents" && /^multipart\/form-data\b/i.test(req.headers["content-type"] || "");
      if (isUpload && req.headers["x-arbor-client"] !== "web") return send(res, 403, { error: "Uploads must come from the Arbor app." });
      if (!isUpload && !["GET", "DELETE", "HEAD"].includes(req.method || "") && !/^application\/json\b/i.test(req.headers["content-type"] || "")) return send(res, 415, { error: "Requests must be JSON" });
      const route = router.match(req.method || "GET", url.pathname);
      if (!route) return send(res, 404, { error: "Not found" });
      await route.handler({ req, res, params: route.params, query: url.searchParams });
    } catch (error) {
      if (error instanceof RequestError) return send(res, error.status, { error: error.message });
      console.error("Request failed:", redactSecrets(error instanceof Error ? error.stack || error.message : String(error)));
      if (!res.headersSent) return send(res, 500, { error: "Something went wrong on the server." });
      res.end();
    }
  });
}

function parseTask(app: App, body: any): TaskRequest | string {
  if (typeof body?.prompt !== "string" || !body.prompt.trim() || body.prompt.length > 20000) return "Prompt must contain 1–20,000 characters";
  const mode = ["fast", "balanced", "deep"].includes(body.mode) ? body.mode : "balanced";
  const modelChoice = typeof body.modelChoice === "string" ? body.modelChoice : "auto";
  if (modelChoice !== "auto" && !app.providers.some(p => p.name === modelChoice)) return "Invalid provider selection";
  const requested = Array.isArray(body.allowedProviders) ? body.allowedProviders.filter((p: unknown) => typeof p === "string" && app.policy.has(p as ProviderName)) : [...app.policy];
  const taskKind = ["chat", "research", "code", "math", "browser", "build"].includes(body.taskKind) ? body.taskKind : undefined;
  return { prompt: body.prompt.trim(), mode, modelChoice, allowedProviders: requested, taskKind, workspaceId: typeof body.workspaceId === "string" ? body.workspaceId.slice(0, 100) : undefined, userId: typeof body.userId === "string" ? body.userId.slice(0, 100) : undefined };
}
