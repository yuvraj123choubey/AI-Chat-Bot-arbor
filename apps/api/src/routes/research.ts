import type { App } from "../app.ts";
import { ndjson, readJson, send, type RouteContext } from "../http.ts";
import type { TaskEvent } from "../tasks/engine.ts";
import { parseWorkspace } from "./chat.ts";

const terminal = new Set(["completed", "failed", "cancelled"]);

/** Deep research projects and the task events that report their progress. */
export function researchRoutes(app: App) {
  const workspaceOf = async (value: unknown) => {
    const slug = parseWorkspace(value ?? undefined);
    return slug ? app.workspace(slug) : undefined;
  };
  return {
    async start({ req, res }: RouteContext) {
      const body = await readJson(req);
      const question = typeof body.question === "string" ? body.question.trim() : "";
      if (question.length < 5 || question.length > 2000) return send(res, 400, { error: "The research question must contain 5–2,000 characters." });
      const workspaceId = await workspaceOf(body.workspaceId);
      if (!workspaceId) return send(res, 400, { error: "Invalid workspace" });
      const selectedModel = typeof body.selectedModel === "string" ? body.selectedModel : "auto";
      const models = app.chatModels();
      if (!models.length) return send(res, 503, { error: "No AI model is available. Start the local model server or configure a provider." });
      if (selectedModel !== "auto" && !models.some(m => m.id === selectedModel)) return send(res, 400, { error: "That model isn't configured on the server. Choose Auto or another model." });
      // The project exists before its task starts, so the task can write to it from its first step.
      const project = await app.research.create(workspaceId, question);
      const taskId = await app.tasks.submit({ workspaceId, userId: app.identity.userId, type: "deep_research", title: `Research: ${question.slice(0, 120)}`, input: { question, selectedModel, researchId: project.id } });
      await app.research.linkTask(project.id, taskId);
      return send(res, 202, { researchId: project.id, taskId });
    },
    async list({ res, query }: RouteContext) {
      const workspaceId = await workspaceOf(query.get("workspaceId"));
      return workspaceId ? send(res, 200, await app.research.list(workspaceId)) : send(res, 400, { error: "Invalid workspace" });
    },
    async get({ res, query, params }: RouteContext) {
      const workspaceId = await workspaceOf(query.get("workspaceId"));
      const detail = workspaceId && await app.research.get(workspaceId, params[0]);
      return detail ? send(res, 200, detail) : send(res, 404, { error: "Research not found" });
    },
    async remove({ res, query, params }: RouteContext) {
      const workspaceId = await workspaceOf(query.get("workspaceId"));
      const detail = workspaceId && await app.research.get(workspaceId, params[0]);
      if (!detail) return send(res, 404, { error: "Research not found" });
      if (detail.taskId && app.tasks.isActive(detail.taskId)) await app.tasks.cancel(detail.taskId);
      await app.research.delete(workspaceId, params[0]);
      return send(res, 200, { ok: true });
    },
    async cancel({ res, query, params }: RouteContext) {
      const workspaceId = await workspaceOf(query.get("workspaceId"));
      const task = workspaceId && /^[0-9a-f-]{36}$/.test(params[0]) ? await app.db.task.findFirst({ where: { id: params[0], workspaceId } }) : null;
      if (!task) return send(res, 404, { error: "Task not found" });
      return send(res, 200, { cancelled: await app.tasks.cancel(task.id) });
    },
    /** NDJSON: a snapshot of the task, then live events until it finishes (or the client disconnects). */
    async events({ res, query, params }: RouteContext) {
      const workspaceId = await workspaceOf(query.get("workspaceId"));
      if (!workspaceId || !/^[0-9a-f-]{36}$/.test(params[0]) || !(await app.db.task.count({ where: { id: params[0], workspaceId } }))) return send(res, 404, { error: "Task not found" });
      // Subscribe before reading the snapshot, so no event can fall between the two; early events are buffered.
      const buffered: TaskEvent[] = [];
      let forward: ((event: TaskEvent) => void) | undefined;
      let finished = false;
      const unsubscribe = app.tasks.subscribe(params[0], event => {
        if (event.type === "status" && terminal.has(String(event.status))) finished = true;
        if (forward) forward(event); else buffered.push(event);
      });
      const task = (await app.db.task.findUnique({ where: { id: params[0] }, include: { steps: { orderBy: { ordinal: "asc" } } } }))!;
      const stream = ndjson(res);
      stream.write({ type: "snapshot", status: task.status, error: task.error, steps: task.steps.map(s => ({ id: s.id, ordinal: s.ordinal, kind: s.kind, title: s.title, status: s.status, startedAt: s.startedAt, finishedAt: s.finishedAt, error: s.error })) });
      // A task that already finished still replays the events it kept, so a client that connects late misses nothing.
      for (const event of buffered) stream.write(event);
      if (terminal.has(task.status) && !app.tasks.isActive(task.id)) { unsubscribe(); return stream.end(); }
      if (!finished) {
        await new Promise<void>(resolve => {
          const heartbeat = setInterval(() => stream.write({ type: "heartbeat" }), 15_000);
          const done = () => { clearInterval(heartbeat); resolve(); };
          forward = event => {
            stream.write(event);
            if (event.type === "status" && terminal.has(String(event.status))) done();
          };
          stream.signal.addEventListener("abort", done, { once: true });
        });
      }
      unsubscribe();
      stream.end();
    }
  };
}
