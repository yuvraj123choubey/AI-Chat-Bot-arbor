import { toProviderError } from "./providers/base.ts";
import type { AIProvider, Message, ModelDefinition, ProviderName, Usage } from "./types.ts";

export interface CallRecord { model: ModelDefinition; usage: Usage; ok: boolean; error?: string; startedAt: Date; finishedAt: Date }
export interface ModelCallOptions {
  /** Ordered candidates; later ones are fallbacks. */
  candidates: ModelDefinition[];
  providers: Map<ProviderName, AIProvider>;
  messages: Message[];
  maxOutputTokens?: number;
  signal?: AbortSignal;
  timeoutMs?: number;
  /** Called after every attempt, so agent runs and usage can be recorded. */
  onCall?: (record: CallRecord) => void | Promise<void>;
}
export interface StructuredOptions<T> extends ModelCallOptions {
  name: string;
  schema: Record<string, unknown>;
  /** Returns the typed value, or a message describing what is wrong with it. */
  validate: (data: unknown) => T | string;
}
export class ModelCallError extends Error {}

/** Finds the JSON value in a reply that may include prose or code fences around it. */
export function extractJson(text: string): unknown {
  const cleaned = text.replace(/```(?:json)?/gi, "");
  const start = cleaned.search(/[[{]/);
  if (start < 0) throw new Error("no JSON found");
  const open = cleaned[start];
  const end = cleaned.lastIndexOf(open === "{" ? "}" : "]");
  return JSON.parse(cleaned.slice(start, end + 1));
}

async function attempt(model: ModelDefinition, options: ModelCallOptions, messages: Message[], responseFormat?: { name: string; schema: Record<string, unknown> }) {
  const startedAt = new Date();
  const timeout = AbortSignal.timeout(options.timeoutMs ?? 180_000);
  try {
    const result = await options.providers.get(model.provider)!.generate({
      model, messages, maxOutputTokens: options.maxOutputTokens, responseFormat, signal: options.signal ? AbortSignal.any([options.signal, timeout]) : timeout
    });
    await options.onCall?.({ model, usage: result.usage, ok: true, startedAt, finishedAt: new Date() });
    return result;
  } catch (error) {
    if (options.signal?.aborted) throw options.signal.reason ?? error;
    await options.onCall?.({ model, usage: { inputTokens: 0, outputTokens: 0 }, ok: false, error: toProviderError(error, model.provider).message.slice(0, 300), startedAt, finishedAt: new Date() });
    return undefined;
  }
}

/** Plain text generation with fallback across candidates. */
export async function generateText(options: ModelCallOptions): Promise<{ text: string; model: ModelDefinition }> {
  for (const model of options.candidates) {
    const result = await attempt(model, options, options.messages);
    if (result?.text.trim()) return { text: result.text, model };
  }
  throw new ModelCallError("No model could complete this step.");
}

/**
 * JSON generation held to a schema. Each candidate gets one retry with the validation error spelled out;
 * then the next candidate is tried. Throws if nobody produces valid output.
 */
export async function generateStructured<T>(options: StructuredOptions<T>): Promise<{ data: T; model: ModelDefinition }> {
  const instruction = `Reply with JSON only, matching this JSON schema:\n${JSON.stringify(options.schema)}`;
  let lastProblem = "no model available";
  for (const model of options.candidates) {
    let messages: Message[] = [...options.messages, { role: "user", content: instruction }];
    for (let retry = 0; retry < 2; retry++) {
      const result = await attempt(model, options, messages, { name: options.name, schema: options.schema });
      if (!result) { lastProblem = `${model.provider} failed`; break; }
      let problem: string;
      try {
        const checked = options.validate(extractJson(result.text));
        if (typeof checked !== "string") return { data: checked, model };
        problem = checked;
      } catch (error) { problem = error instanceof Error ? error.message : "invalid JSON"; }
      lastProblem = problem;
      messages = [...messages, { role: "assistant", content: result.text }, { role: "user", content: `That reply was not usable (${problem}). ${instruction}` }];
    }
  }
  throw new ModelCallError(`Could not get a valid ${options.name}: ${lastProblem}`);
}
