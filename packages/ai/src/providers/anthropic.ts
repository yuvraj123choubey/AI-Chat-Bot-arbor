import { BaseProvider, ProviderError, parseSse, postJson } from "./base.ts";
import type { GenerateRequest, GenerateResult, StreamChunk } from "../types.ts";

const url = "https://api.anthropic.com/v1/messages";
const streamErrorStatus: Record<string, number> = { rate_limit_error: 429, overloaded_error: 529, authentication_error: 401, permission_error: 403, not_found_error: 404, invalid_request_error: 400 };

export class AnthropicProvider extends BaseProvider {
  readonly name = "anthropic";
  constructor(private readonly key = process.env.ANTHROPIC_API_KEY) { super(); }
  isConfigured() { return Boolean(this.key); }
  private headers() { return { "x-api-key": this.key || "", "anthropic-version": "2023-06-01" }; }
  private body(request: GenerateRequest, stream = false) {
    return {
      model: request.model.modelId, max_tokens: request.maxOutputTokens || 4096, stream,
      ...(request.temperature !== undefined && !request.model.supportsReasoning ? { temperature: request.temperature } : {}),
      system: request.messages.filter(m => m.role === "system").map(m => m.content).join("\n\n") || undefined,
      messages: request.messages.filter(m => m.role !== "system").map(m => ({ role: m.role, content: m.content })),
      ...(request.tools?.length ? { tools: request.tools.map(t => ({ name: t.name, description: t.description, input_schema: t.parameters })) } : {})
    };
  }
  async generate(request: GenerateRequest): Promise<GenerateResult> {
    const data = await postJson(this.name, url, this.headers(), this.body(request), request.signal);
    return {
      text: (data.content || []).filter((b: any) => b.type === "text").map((b: any) => b.text).join(""),
      toolCalls: (data.content || []).filter((b: any) => b.type === "tool_use").map((b: any) => ({ id: b.id, name: b.name, arguments: b.input || {} })),
      usage: { inputTokens: data.usage?.input_tokens || 0, outputTokens: data.usage?.output_tokens || 0 }
    };
  }
  async *stream(request: GenerateRequest): AsyncIterable<StreamChunk> {
    const response = await fetch(url, { method: "POST", headers: { "content-type": "application/json", ...this.headers() }, body: JSON.stringify(this.body(request, true)), signal: request.signal });
    const calls = new Map<number, { id: string; name: string; input: string }>();
    let inputTokens = 0;
    for await (const { event, data } of parseSse(this.name, response)) {
      if (event === "error") throw new ProviderError(this.name, streamErrorStatus[data.error?.type] || 500, String(data.error?.message || "stream error").slice(0, 500));
      if (event === "message_start") inputTokens = data.message?.usage?.input_tokens || 0;
      if (event === "content_block_start" && data.content_block?.type === "tool_use") calls.set(data.index, { id: data.content_block.id, name: data.content_block.name, input: "" });
      if (event === "content_block_start" && data.content_block?.type === "thinking") yield { thinking: true };
      if (event === "content_block_delta") {
        if (data.delta?.type === "text_delta") yield { text: data.delta.text };
        if (data.delta?.type === "thinking_delta") yield { thinking: true };
        if (data.delta?.type === "input_json_delta") { const call = calls.get(data.index); if (call) call.input += data.delta.partial_json || ""; }
      }
      if (event === "message_delta") {
        if (data.delta?.stop_reason === "max_tokens") yield { stop: "length" };
        if (data.delta?.stop_reason === "refusal") yield { stop: "filtered" };
        yield { usage: { inputTokens, outputTokens: data.usage?.output_tokens || 0 } };
      }
    }
    for (const call of calls.values()) {
      let args = {}; try { args = JSON.parse(call.input); } catch { /* malformed tool arguments are not executed */ }
      yield { toolCall: { id: call.id, name: call.name, arguments: args } };
    }
  }
}
