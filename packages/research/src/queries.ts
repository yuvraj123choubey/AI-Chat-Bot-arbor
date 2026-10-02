import type { AIProvider, ModelDefinition, ProviderName, Usage } from "../../ai/src/types.ts";
import { heuristicQueries, parseQueries } from "./intent.ts";

export interface QueryPlan { queries: string[]; source: "model" | "heuristic"; model?: ModelDefinition; usage?: Usage }

/**
 * Turns a question (plus the previous turn, for follow-ups) into keyword search queries using the cheapest
 * suitable model. Falls back to deterministic queries if no model is available or the call fails, so search
 * never depends on one provider being up.
 */
export async function planQueries(input: {
  question: string; previous?: string; max: number;
  candidates: ModelDefinition[]; providers: Map<ProviderName, AIProvider>;
  signal?: AbortSignal; timeoutMs?: number; today?: Date;
}): Promise<QueryPlan> {
  const fallback = (): QueryPlan => ({ queries: heuristicQueries(input.question, input.previous), source: "heuristic" });
  const model = input.candidates[0];
  if (!model) return fallback();
  const today = (input.today || new Date()).toISOString().slice(0, 10);
  try {
    const timeout = AbortSignal.timeout(input.timeoutMs ?? 15_000);
    const result = await input.providers.get(model.provider)!.generate({
      model, maxOutputTokens: 300, signal: input.signal ? AbortSignal.any([input.signal, timeout]) : timeout,
      messages: [
        { role: "system", content: `You write web search queries. Today is ${today}. Reply with JSON only: {"queries": ["..."]}. Give ${input.max} short keyword queries (3–8 words each) that together find authoritative sources for the user's question. Resolve pronouns and follow-ups using the previous message. Add a year only when the question is about recent events. Do not answer the question.` },
        { role: "user", content: `${input.previous ? `Previous message: ${input.previous.slice(0, 1000)}\n\n` : ""}Question: ${input.question.slice(0, 2000)}` }
      ]
    });
    const queries = parseQueries(result.text, input.max);
    return queries.length ? { queries, source: "model", model, usage: result.usage } : { ...fallback(), model, usage: result.usage };
  } catch {
    if (input.signal?.aborted) throw input.signal.reason;
    return fallback();
  }
}
