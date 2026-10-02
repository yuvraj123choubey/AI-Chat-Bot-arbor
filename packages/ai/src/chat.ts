import { inferTaskKind, rankModels, unmetRequirements } from "./router.ts";
import { providerLabel } from "./registry.ts";
import { ProviderError, toProviderError, type ProviderErrorCode } from "./providers/base.ts";
import { redactSecrets } from "./redact.ts";
import { estimateCost } from "./usage.ts";
import type { AIProvider, Message, ModelDefinition, ProviderName, ReasoningMode, TaskKind, TaskRequest, Usage } from "./types.ts";

export type ChatErrorCode = ProviderErrorCode | "no_models" | "model_not_configured";
export interface ChatModelInfo { id: string; provider: ProviderName; providerLabel: string; displayName: string; modelId: string }
export type ChatEvent =
  | { type: "model"; model: ChatModelInfo; taskKind: TaskKind; reasoningLevel: ReasoningMode; fallbackFrom: string[] }
  | { type: "thinking" }
  | { type: "delta"; text: string }
  | { type: "done"; stop?: "length" | "filtered"; usage: Usage }
  | { type: "stopped"; usage: Usage }
  | { type: "error"; code: ChatErrorCode; message: string };
export interface ChatInput {
  /** Prior turns plus the new user message last; system prompts are added here, not by callers. */
  history: Message[];
  selectedModel: "auto" | string;
  reasoningLevel: ReasoningMode;
  /** Task kind of the conversation's previous turn, so short follow-ups stay on the same kind of model. */
  previousTaskKind?: TaskKind;
  /** Citation rules to add when the last user turn carries numbered sources. */
  grounding?: string;
  context?: Record<string, string | undefined>;
}
export interface ChatDeps {
  /** Only models that are enabled and whose provider has credentials. */
  models: ModelDefinition[];
  providers: Map<ProviderName, AIProvider>;
  idleTimeoutMs: number;
  log?: (entry: Record<string, unknown>) => Promise<void>;
}

const budgets: Record<ReasoningMode, number> = { fast: 2048, balanced: 8192, deep: 16384 };
const levelGuidance: Record<ReasoningMode, string> = {
  fast: "Keep the answer brief and to the point.",
  balanced: "Be complete but concise.",
  deep: "Take extra care: check your work, consider edge cases and alternatives, and give a thorough, well-structured answer."
};
const MAX_HISTORY_MESSAGES = 40;
const MAX_HISTORY_CHARS = 120_000;

export function chatTaskKind(prompt: string, previous?: TaskKind): TaskKind {
  const inferred = inferTaskKind(prompt);
  // Chat has no tools yet, so browsing requests are answered as conversation and builds as coding help.
  const kind = inferred === "browser" ? "chat" : inferred === "build" ? "code" : inferred;
  return kind === "chat" && previous ? previous : kind;
}
/** Deterministic model choice: a manual pick is used alone; Auto ranks qualified models, which are also the fallback order. */
export function planChat(models: ModelDefinition[], input: ChatInput): { kind: TaskKind; candidates: ModelDefinition[] } | { error: ChatErrorCode } {
  if (!models.length) return { error: "no_models" };
  const prompt = input.history.at(-1)?.content || "";
  const kind = chatTaskKind(prompt, input.previousTaskKind);
  if (input.selectedModel !== "auto") {
    const model = models.find(m => m.id === input.selectedModel);
    return model ? { kind, candidates: [model] } : { error: "model_not_configured" };
  }
  const request: TaskRequest = { prompt, mode: input.reasoningLevel, taskKind: kind, modelChoice: "auto" };
  const ranked = rankModels(models, request, new Set(models.map(m => m.provider)));
  const qualified = ranked.filter(m => !unmetRequirements(m, request).length);
  return { kind, candidates: qualified.length ? qualified : ranked };
}
export function outputBudget(model: ModelDefinition, level: ReasoningMode): number {
  // Reasoning models spend part of the budget on hidden reasoning, so they never get less than the balanced budget.
  const budget = model.supportsReasoning ? Math.max(budgets[level], budgets.balanced) : budgets[level];
  return Math.min(budget, model.maxOutputTokens || budget);
}
export function systemPrompt(level: ReasoningMode, grounding?: string): string {
  return [
    "You are Arbor, an AI assistant for research, reasoning, coding and writing.",
    "Answer the user's latest message, using the earlier conversation as context.",
    "Use Markdown when it helps: short headings, lists, and fenced code blocks with a language tag.",
    "Give the answer and the key steps that support it; do not narrate hidden reasoning.",
    "If you are unsure or lack information the question depends on, say so rather than guessing.",
    levelGuidance[level],
    ...(grounding ? [grounding] : [])
  ].join(" ");
}
/** Providers reject empty turns, and Claude and Gemini also reject consecutive turns from the same role, so those are merged. */
export function normalizeHistory(history: Message[]): Message[] {
  const merged: Message[] = [];
  for (const m of history) {
    if (m.role === "system" || !m.content.trim()) continue;
    const last = merged.at(-1);
    if (last?.role === m.role) last.content += `\n\n${m.content}`;
    else merged.push({ role: m.role, content: m.content });
  }
  let kept = merged.slice(-MAX_HISTORY_MESSAGES);
  while (kept.length > 1 && kept.reduce((n, m) => n + m.content.length, 0) > MAX_HISTORY_CHARS) kept = kept.slice(1);
  while (kept.length && kept[0].role !== "user") kept = kept.slice(1);
  return kept;
}
export function friendlyError(code: ChatErrorCode, model?: ModelDefinition): string {
  const p = model ? providerLabel(model.provider) : "The provider";
  switch (code) {
    case "no_models": return "No AI models are configured. Add a provider API key and model ID to .env, then restart the server.";
    case "model_not_configured": return "That model isn't configured on the server. Choose Auto or another model.";
    case "auth": return `${p} rejected the server's API key. Check the ${p} key in .env, or try another configured model.`;
    case "quota": return `${p} reports that the account is out of credit or quota. Try another configured model.`;
    case "rate_limit": return `${p} is limiting requests right now. Wait a moment, or try another configured model.`;
    case "model_unavailable": return `${p} doesn't recognise the configured model "${model?.modelId}". Check the model ID in .env, or try another configured model.`;
    case "timeout": return `${p} took too long to respond. Try again, or try another configured model.`;
    case "network": return `Couldn't reach ${p}. Check the server's internet connection.`;
    case "filtered": return `${p} declined to answer this message.`;
    case "empty_response": return `${p} returned an empty response. Try again, or try another configured model.`;
    case "bad_request": return `${p} couldn't process this request. Try rephrasing it, or try another configured model.`;
    default: return `${p} is currently unavailable. Try another configured model.`;
  }
}

export async function* streamChat(deps: ChatDeps, input: ChatInput, signal?: AbortSignal): AsyncGenerator<ChatEvent> {
  const plan = planChat(deps.models, input);
  if ("error" in plan) { yield { type: "error", code: plan.error, message: friendlyError(plan.error) }; return; }
  const messages: Message[] = [{ role: "system", content: systemPrompt(input.reasoningLevel, input.grounding) }, ...normalizeHistory(input.history)];
  const fallbackFrom: string[] = [];
  for (const [index, model] of plan.candidates.entries()) {
    const idle = new AbortController();
    const timer = setTimeout(() => idle.abort(), deps.idleTimeoutMs);
    let usage: Usage = { inputTokens: 0, outputTokens: 0 };
    let announced = false, thinking = false, produced = false;
    let stop: "length" | "filtered" | undefined;
    const record = (status: string, extra: Record<string, unknown> = {}) => deps.log?.({
      type: status === "failed" ? "provider_failure" : "usage", at: new Date().toISOString(), provider: model.provider, model: model.modelId, registryId: model.id,
      task: plan.kind, role: "chat", reasoningLevel: input.reasoningLevel, status, ...input.context, ...usage, estimatedCostUsd: estimateCost(model, usage), ...extra
    });
    try {
      const stream = deps.providers.get(model.provider)!.stream({ model, messages, maxOutputTokens: outputBudget(model, input.reasoningLevel), signal: signal ? AbortSignal.any([signal, idle.signal]) : idle.signal });
      for await (const chunk of stream) {
        timer.refresh();
        if (!announced) {
          announced = true;
          yield { type: "model", model: { id: model.id, provider: model.provider, providerLabel: providerLabel(model.provider), displayName: model.displayName, modelId: model.modelId }, taskKind: plan.kind, reasoningLevel: input.reasoningLevel, fallbackFrom };
        }
        if (chunk.thinking && !thinking && !produced) { thinking = true; yield { type: "thinking" }; }
        if (chunk.text) { produced = true; yield { type: "delta", text: chunk.text }; }
        if (chunk.usage) usage = chunk.usage;
        if (chunk.stop) stop = chunk.stop;
      }
      if (!produced) throw new ProviderError(model.provider, 0, stop === "filtered" ? "response was filtered" : "empty response", stop === "filtered" ? "filtered" : "empty_response");
      await record("complete", { stop });
      yield { type: "done", stop, usage };
      return;
    } catch (raw) {
      if (signal?.aborted) { await record("stopped"); yield { type: "stopped", usage }; return; }
      const error = idle.signal.aborted ? new ProviderError(model.provider, 0, `no data for ${deps.idleTimeoutMs}ms`, "timeout") : toProviderError(raw, model.provider);
      await record("failed", { code: error.code, partial: produced, message: redactSecrets(error.message).slice(0, 300) });
      // Fallback is only safe before any text reached the user, and never routes around a provider's content filter.
      if (input.selectedModel === "auto" && !produced && error.code !== "filtered" && index < plan.candidates.length - 1) {
        fallbackFrom.push(providerLabel(model.provider));
        continue;
      }
      const others = [...new Set(fallbackFrom)].filter(label => label !== providerLabel(model.provider));
      const tried = others.length ? ` (${others.join(" and ")} also failed.)` : "";
      yield { type: "error", code: error.code, message: friendlyError(error.code, model) + tried };
      return;
    } finally { clearTimeout(timer); }
  }
}
