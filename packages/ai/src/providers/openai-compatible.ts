import { BaseProvider, ProviderError, postJson, parseSse } from "./base.ts";
import type { GenerateRequest, GenerateResult, ProviderName, StreamChunk, ToolCall } from "../types.ts";

export class OpenAICompatibleProvider extends BaseProvider {
  /** OpenAI expects `max_completion_tokens`; DeepSeek and most compatible APIs use `max_tokens`. */
  constructor(public readonly name: ProviderName, private readonly url: string, private readonly key: string | undefined, private readonly maxTokensField = "max_tokens") { super(); }
  isConfigured() { return Boolean(this.key); }
  protected body(request: GenerateRequest, stream = false) {
    return {
      model: request.model.modelId,
      messages: request.messages,
      ...(request.maxOutputTokens ? { [this.maxTokensField]: request.maxOutputTokens } : {}),
      ...(request.tools?.length ? { tools: request.tools.map(t => ({ type: "function", function: t })) } : {}),
      stream,
      ...(stream ? { stream_options: { include_usage: true } } : {})
    };
  }
  private headers() { return { authorization: `Bearer ${this.key}` }; }
  async generate(request: GenerateRequest): Promise<GenerateResult> {
    const data = await postJson(this.name, this.url, this.headers(), this.body(request), request.signal);
    const message = data.choices?.[0]?.message;
    if (!message) throw new ProviderError(this.name, 0, "returned no message", "empty_response");
    return {
      text: message.content || "",
      toolCalls: (message.tool_calls || []).map((t: any) => ({ id: t.id, name: t.function.name, arguments: safeArguments(t.function.arguments) })),
      usage: { inputTokens: data.usage?.prompt_tokens || 0, outputTokens: data.usage?.completion_tokens || 0 }
    };
  }
  async *stream(request: GenerateRequest): AsyncIterable<StreamChunk> {
    const response = await fetch(this.url, { method: "POST", headers: { "content-type": "application/json", ...this.headers() }, body: JSON.stringify(this.body(request, true)), signal: request.signal });
    const calls = new Map<number, { id: string; name: string; arguments: string }>();
    for await (const { data } of parseSse(this.name, response)) {
      if (data.error) throw new ProviderError(this.name, Number(data.error.code) || 500, String(data.error.message || "stream error").slice(0, 500));
      const choice = data.choices?.[0];
      const delta = choice?.delta;
      // Reasoning models stream private reasoning separately; only its presence is reported, never its content.
      if (delta?.reasoning_content) yield { thinking: true };
      if (delta?.content) yield { text: delta.content };
      for (const call of delta?.tool_calls || []) {
        const prior = calls.get(call.index) || { id: "", name: "", arguments: "" };
        prior.id += call.id || ""; prior.name += call.function?.name || ""; prior.arguments += call.function?.arguments || "";
        calls.set(call.index, prior);
      }
      if (choice?.finish_reason === "length") yield { stop: "length" };
      if (choice?.finish_reason === "content_filter") yield { stop: "filtered" };
      if (data.usage) yield { usage: { inputTokens: data.usage.prompt_tokens || 0, outputTokens: data.usage.completion_tokens || 0 } };
    }
    for (const call of calls.values()) yield { toolCall: { id: call.id, name: call.name, arguments: safeArguments(call.arguments) } };
  }
}
function safeArguments(raw: string): ToolCall["arguments"] {
  try { const value = JSON.parse(raw); return value && typeof value === "object" ? value : {}; } catch { return {}; }
}
