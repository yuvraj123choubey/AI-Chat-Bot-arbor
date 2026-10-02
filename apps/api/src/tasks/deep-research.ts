import { rankModels, unmetRequirements } from "../../../../packages/ai/src/router.ts";
import { generateStructured, generateText, type CallRecord } from "../../../../packages/ai/src/structured.ts";
import { estimateCost } from "../../../../packages/ai/src/usage.ts";
import type { ModelDefinition, TaskRequest } from "../../../../packages/ai/src/types.ts";
import { gatherEvidence, searchIntent } from "../../../../packages/research/src/index.ts";
import { runDeepResearch } from "../../../../packages/research/src/deep.ts";
import type { App } from "../app.ts";
import type { TaskContext } from "./engine.ts";

export interface DeepResearchInput { researchId: string; question: string; selectedModel: string }

/** Models for the small structured steps (cheap first) and for writing the report (reasoning first). */
export function researchModels(models: ModelDefinition[], selectedModel: string): { structured: ModelDefinition[]; writer: ModelDefinition[] } {
  // A manual choice pins every step to that model, so the question never reaches another provider.
  if (selectedModel !== "auto") {
    const chosen = models.filter(m => m.id === selectedModel);
    return { structured: chosen, writer: chosen };
  }
  const allowed = new Set(models.map(m => m.provider));
  const writerRequest: TaskRequest = { prompt: "", mode: "deep", taskKind: "research", modelChoice: "auto" };
  const writers = rankModels(models, writerRequest, allowed);
  const qualified = writers.filter(m => !unmetRequirements(m, writerRequest).length);
  return {
    structured: rankModels(models, { prompt: "", mode: "fast", taskKind: "chat", modelChoice: "auto" }, allowed, "verifier"),
    // Reasoning models write first; the others follow as fallbacks, so one failed call does not lose the report.
    writer: [...qualified, ...writers.filter(m => !qualified.includes(m))]
  };
}

export function deepResearchHandler(app: App) {
  return async (ctx: TaskContext) => {
    const input = ctx.input as unknown as DeepResearchInput;
    const models = app.chatModels();
    if (!models.length) throw new Error("No AI model is available. Start the local model server or configure a provider.");
    const chosen = researchModels(models, input.selectedModel);
    if (!chosen.writer.length) throw new Error("The selected model is not available.");
    const record = (agent: string) => async (call: CallRecord) => {
      await app.db.agentRun.create({
        data: {
          taskId: ctx.taskId, agent, provider: call.model.provider, model: call.model.modelId, status: call.ok ? "completed" : "failed",
          inputTokens: call.usage.inputTokens, outputTokens: call.usage.outputTokens, costUsd: estimateCost(call.model, call.usage), startedAt: call.startedAt, finishedAt: call.finishedAt
        }
      });
      await app.recordUsage({ provider: call.model.provider, model: call.model.modelId, registryId: call.model.id, task: "deep_research", role: agent, status: call.ok ? "complete" : "failed", taskId: ctx.taskId, workspaceId: ctx.workspaceId, ...call.usage, estimatedCostUsd: estimateCost(call.model, call.usage) });
    };

    await app.research.setStatus(input.researchId, "running");
    try {
      const result = await runDeepResearch({
        signal: ctx.signal,
        gather: options => gatherEvidence({ providers: app.searchProviders }, { ...options, depth: "balanced" }),
        structured: async (agent, request) => (await generateStructured({ ...request, candidates: chosen.structured, providers: app.providerMap, signal: ctx.signal, onCall: record(agent) })).data,
        text: async (agent, request) => (await generateText({ ...request, candidates: chosen.writer, providers: app.providerMap, signal: ctx.signal, timeoutMs: 600_000, onCall: record(agent) })).text,
        step: ctx.step,
        progress: event => ctx.emit({ type: "progress", ...event }),
        savePlan: async plan => { await app.research.savePlan(input.researchId, plan); ctx.emit({ type: "plan", plan }); },
        saveQueries: async queries => { await app.research.saveQueries(input.researchId, queries); },
        saveSources: async added => {
          const ids = await app.research.addSources(ctx.workspaceId, input.researchId, added);
          ctx.emit({ type: "sources", sources: added.map(s => ({ ordinal: s.ordinal, id: ids.get(s.ordinal), title: s.source.title, url: s.source.url, domain: s.source.domain })) });
        },
        saveNotes: async notes => { await app.research.saveNotes(input.researchId, notes); ctx.emit({ type: "notes", count: notes.length }); }
      }, { question: input.question, focus: searchIntent(input.question, "on") });
      await app.research.complete(input.researchId, result.report, result.claims);
      ctx.emit({ type: "report" });
      return { sources: result.sources.length, notes: result.notes.length, conflicts: result.conflicts.length, cited: result.cited };
    } catch (error) {
      if (ctx.signal.aborted) await app.research.setStatus(input.researchId, "cancelled");
      else await app.research.setStatus(input.researchId, "failed", error instanceof Error ? error.message.slice(0, 500) : "Research failed");
      throw error;
    }
  };
}
