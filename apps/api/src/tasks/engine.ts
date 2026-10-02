import type { Db, Prisma } from "../../../../packages/db/src/client.ts";

export type TaskEvent =
  | { type: "status"; status: string; error?: string }
  | { type: "step"; step: { id: string; ordinal: number; kind: string; title: string; status: string; startedAt?: string; finishedAt?: string; error?: string } }
  | { type: "progress"; stage: string; label: string; detail?: string }
  | { type: string; [key: string]: unknown };

export interface TaskContext {
  taskId: string;
  workspaceId: string;
  input: Record<string, unknown>;
  signal: AbortSignal;
  emit(event: TaskEvent): void;
  /** Runs one recorded step: a TaskStep row tracks its status, timing, input and (summarised) output. */
  step<T>(kind: string, title: string, input: Record<string, unknown>, run: () => Promise<T>, summarize?: (output: T) => unknown): Promise<T>;
}
export type TaskHandler = (ctx: TaskContext) => Promise<Record<string, unknown> | void>;

/** Step inputs and outputs are kept for inspection; oversized ones are replaced by a short preview. */
function json(value: unknown): Prisma.InputJsonValue {
  const text = JSON.stringify(value ?? null);
  return (text.length > 200_000 ? { truncated: true, preview: text.slice(0, 2000) } : JSON.parse(text)) as Prisma.InputJsonValue;
}

/**
 * Runs long, multi-step work (deep research now; coding and browser agents later) outside the request that
 * started it. Tasks and steps are persisted, so progress survives page reloads; live events go to subscribers.
 * Work runs in this process with a concurrency limit; a restart marks unfinished tasks as interrupted.
 */
export class TaskEngine {
  private readonly handlers = new Map<string, TaskHandler>();
  private readonly running = new Map<string, AbortController>();
  private readonly queue: string[] = [];
  private readonly listeners = new Map<string, Set<(event: TaskEvent) => void>>();

  constructor(private readonly db: Db, private readonly concurrency = 1) {}

  register(type: string, handler: TaskHandler) { this.handlers.set(type, handler); }

  async recoverInterrupted(): Promise<number> {
    const { count } = await this.db.task.updateMany({ where: { status: { in: ["queued", "running", "waiting_approval"] } }, data: { status: "failed", error: "Interrupted by a server restart.", finishedAt: new Date() } });
    await this.db.taskStep.updateMany({ where: { status: { in: ["queued", "running"] } }, data: { status: "failed", error: "Interrupted by a server restart.", finishedAt: new Date() } });
    return count;
  }

  async submit(input: { workspaceId: string; userId?: string; type: string; title: string; input: Record<string, unknown> }): Promise<string> {
    if (!this.handlers.has(input.type)) throw new Error(`Unknown task type ${input.type}`);
    const task = await this.db.task.create({ data: { workspaceId: input.workspaceId, userId: input.userId, type: input.type, title: input.title.slice(0, 300), input: json(input.input) } });
    this.queue.push(task.id);
    void this.pump();
    return task.id;
  }

  async cancel(taskId: string): Promise<boolean> {
    const queued = this.queue.indexOf(taskId);
    if (queued >= 0) {
      this.queue.splice(queued, 1);
      await this.finish(taskId, "cancelled");
      return true;
    }
    const controller = this.running.get(taskId);
    controller?.abort(new Error("Cancelled"));
    return Boolean(controller);
  }

  isActive(taskId: string) { return this.running.has(taskId) || this.queue.includes(taskId); }

  /**
   * Listens to a task's events. Events already emitted are replayed first (kept while the task runs and for a
   * minute after), so a client that connects late — or reloads mid-task — misses nothing.
   */
  subscribe(taskId: string, listener: (event: TaskEvent) => void): () => void {
    for (const event of this.history.get(taskId) ?? []) listener(event);
    const set = this.listeners.get(taskId) ?? new Set();
    set.add(listener);
    this.listeners.set(taskId, set);
    return () => { set.delete(listener); if (!set.size) this.listeners.delete(taskId); };
  }
  private readonly history = new Map<string, TaskEvent[]>();

  private emit(taskId: string, event: TaskEvent) {
    const log = this.history.get(taskId) ?? [];
    log.push(event);
    if (log.length > 500) log.splice(0, log.length - 500);
    this.history.set(taskId, log);
    for (const listener of this.listeners.get(taskId) ?? []) { try { listener(event); } catch { /* a broken listener must not stop the task */ } }
  }

  private async pump() {
    while (this.running.size < this.concurrency && this.queue.length) {
      const taskId = this.queue.shift()!;
      const controller = new AbortController();
      this.running.set(taskId, controller);
      void this.execute(taskId, controller).finally(() => { this.running.delete(taskId); void this.pump(); });
    }
  }

  private async execute(taskId: string, controller: AbortController) {
    const task = await this.db.task.update({ where: { id: taskId }, data: { status: "running", startedAt: new Date() } });
    this.emit(taskId, { type: "status", status: "running" });
    let ordinal = 0;
    const ctx: TaskContext = {
      taskId, workspaceId: task.workspaceId, input: task.input as Record<string, unknown>, signal: controller.signal,
      emit: event => this.emit(taskId, event),
      step: async (kind, title, input, run, summarize) => {
        controller.signal.throwIfAborted();
        const row = await this.db.taskStep.create({ data: { taskId, ordinal: ++ordinal, kind, title: title.slice(0, 300), status: "running", input: json(input), startedAt: new Date() } });
        const view = { id: row.id, ordinal: row.ordinal, kind, title: row.title, startedAt: row.startedAt!.toISOString() };
        this.emit(taskId, { type: "step", step: { ...view, status: "running" } });
        try {
          const output = await run();
          const finished = await this.db.taskStep.update({ where: { id: row.id }, data: { status: "completed", output: json(summarize ? summarize(output) : output), finishedAt: new Date() } });
          this.emit(taskId, { type: "step", step: { ...view, status: "completed", finishedAt: finished.finishedAt!.toISOString() } });
          return output;
        } catch (error) {
          const cancelled = controller.signal.aborted;
          const message = cancelled ? "Cancelled" : error instanceof Error ? error.message.slice(0, 500) : "Step failed";
          await this.db.taskStep.update({ where: { id: row.id }, data: { status: cancelled ? "cancelled" : "failed", error: message, finishedAt: new Date() } });
          this.emit(taskId, { type: "step", step: { ...view, status: cancelled ? "cancelled" : "failed", error: message } });
          throw error;
        }
      }
    };
    try {
      const output = await this.handlers.get(task.type)!(ctx);
      await this.finish(taskId, "completed", undefined, output);
    } catch (error) {
      if (controller.signal.aborted) await this.finish(taskId, "cancelled");
      else await this.finish(taskId, "failed", error instanceof Error ? error.message.slice(0, 500) : "Task failed");
    }
  }

  private async finish(taskId: string, status: "completed" | "failed" | "cancelled", error?: string, output?: Record<string, unknown> | void) {
    await this.db.task.update({ where: { id: taskId }, data: { status, error: error ?? null, finishedAt: new Date(), ...(output ? { output: json(output) } : {}) } });
    this.emit(taskId, { type: "status", status, ...(error ? { error } : {}) });
    setTimeout(() => this.history.delete(taskId), 60_000).unref();
  }
}
