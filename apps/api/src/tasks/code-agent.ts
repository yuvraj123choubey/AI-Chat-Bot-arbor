import type { CallRecord } from "../../../../packages/ai/src/structured.ts";
import { estimateCost } from "../../../../packages/ai/src/usage.ts";
import type { ModelDefinition } from "../../../../packages/ai/src/types.ts";
import { modelDecider, runAgent } from "../../../../packages/code/src/index.ts";
import type { App } from "../app.ts";
import type { TaskContext } from "./engine.ts";

export interface CodeAgentInput { projectId: string; task: string; selectedModel: string; context?: string }

/**
 * Models for the agent: the user's choice, or coding-capable models that answer directly first (structured output
 * from a model that reasons privately is slower and less reliable), then any other model as a fallback.
 */
export function agentModels(models: ModelDefinition[], selectedModel: string): ModelDefinition[] {
  if (selectedModel !== "auto") return models.filter(m => m.id === selectedModel);
  const score = (m: ModelDefinition) => (m.supportsCoding ? 2 : 0) + (m.supportsReasoning ? 0 : 1);
  return [...models].sort((a, b) => score(b) - score(a));
}

export function codeAgentHandler(app: App) {
  return async (ctx: TaskContext) => {
    const input = ctx.input as unknown as CodeAgentInput;
    const project = await app.projects.open(ctx.workspaceId, input.projectId);
    if (!project) throw new Error("The project no longer exists.");
    const candidates = agentModels(app.chatModels(), input.selectedModel);
    if (!candidates.length) throw new Error("No AI model is available. Start the local model server or configure a provider.");
    const record = async (call: CallRecord) => {
      await app.db.agentRun.create({ data: { taskId: ctx.taskId, agent: "coding", provider: call.model.provider, model: call.model.modelId, status: call.ok ? "completed" : "failed", inputTokens: call.usage.inputTokens, outputTokens: call.usage.outputTokens, costUsd: estimateCost(call.model, call.usage), startedAt: call.startedAt, finishedAt: call.finishedAt } });
      await app.recordUsage({ provider: call.model.provider, model: call.model.modelId, registryId: call.model.id, task: "code_agent", role: "coding", status: call.ok ? "complete" : "failed", taskId: ctx.taskId, workspaceId: ctx.workspaceId, ...call.usage, estimatedCostUsd: estimateCost(call.model, call.usage) });
    };
    let step = 0;
    const result = await runAgent({
      files: project.files, history: project.history, runner: app.projects.runner, projectId: project.id, signal: ctx.signal,
      next: modelDecider({ candidates, providers: app.providerMap, signal: ctx.signal, onCall: record }),
      event: e => ctx.emit({ type: "agent", step: ++step, ...e }),
      pageUrl: () => app.projects.previews.get(project.id)?.status === "running" && app.projects.previews.get(project.id)?.port ? app.projects.previews.get(project.id)!.url : undefined
    }, input.task, input.context ?? "");
    ctx.emit({ type: "agent_result", result: { ...result, diff: result.diff ? { files: result.diff.files, truncated: result.diff.truncated } : undefined } });
    return { summary: result.summary, baseCommit: result.baseCommit, commit: result.commit, files: result.diff?.files ?? [], commands: result.commands, steps: result.steps, stoppedEarly: result.stoppedEarly, metrics: result.metrics };
  };
}
