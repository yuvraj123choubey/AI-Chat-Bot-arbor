import { BaseProvider, parseSse, postJson } from "./base.ts";
import type { GenerateRequest, GenerateResult, StreamChunk } from "../types.ts";

const blockedReasons = new Set(["SAFETY", "RECITATION", "PROHIBITED_CONTENT", "BLOCKLIST", "SPII"]);

export class GoogleProvider extends BaseProvider {
  readonly name = "google";
  constructor(private readonly key = process.env.GOOGLE_API_KEY || process.env.GEMINI_API_KEY) { super(); }
  isConfigured() { return Boolean(this.key); }
  private url(request: GenerateRequest, stream = false) {
    return `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(request.model.modelId)}:${stream ? "streamGenerateContent?alt=sse" : "generateContent"}`;
  }
  private body(request: GenerateRequest) {
    const system = request.messages.filter(m => m.role === "system").map(m => ({ text: m.content }));
    return {
      ...(system.length ? { systemInstruction: { parts: system } } : {}),
      contents: request.messages.filter(m => m.role !== "system").map(m => ({ role: m.role === "assistant" ? "model" : "user", parts: [{ text: m.content }] })),
      ...(request.maxOutputTokens ? { generationConfig: { maxOutputTokens: request.maxOutputTokens } } : {}),
      ...(request.tools?.length ? { tools: [{ functionDeclarations: request.tools.map(t => ({ name: t.name, description: t.description, parameters: t.parameters })) }] } : {})
    };
  }
  async generate(request: GenerateRequest): Promise<GenerateResult> {
    const data = await postJson(this.name, this.url(request), { "x-goog-api-key": this.key || "" }, this.body(request), request.signal);
    // Thought summaries are flagged with `thought: true` and are never returned as answer text.
    const parts = (data.candidates?.[0]?.content?.parts || []).filter((p: any) => !p.thought);
    return {
      text: parts.map((p: any) => p.text || "").join(""),
      toolCalls: parts.filter((p: any) => p.functionCall).map((p: any) => ({ id: p.functionCall.id || crypto.randomUUID(), name: p.functionCall.name, arguments: p.functionCall.args || {} })),
      usage: { inputTokens: data.usageMetadata?.promptTokenCount || 0, outputTokens: data.usageMetadata?.candidatesTokenCount || 0 }
    };
  }
  async *stream(request: GenerateRequest): AsyncIterable<StreamChunk> {
    const response = await fetch(this.url(request, true), { method: "POST", headers: { "content-type": "application/json", "x-goog-api-key": this.key || "" }, body: JSON.stringify(this.body(request)), signal: request.signal });
    for await (const { data } of parseSse(this.name, response)) {
      const candidate = data.candidates?.[0];
      for (const p of candidate?.content?.parts || []) {
        if (p.thought) { yield { thinking: true }; continue; }
        if (p.text) yield { text: p.text };
        if (p.functionCall) yield { toolCall: { id: p.functionCall.id || crypto.randomUUID(), name: p.functionCall.name, arguments: p.functionCall.args || {} } };
      }
      if (candidate?.finishReason === "MAX_TOKENS") yield { stop: "length" };
      if (blockedReasons.has(candidate?.finishReason) || data.promptFeedback?.blockReason) yield { stop: "filtered" };
      if (data.usageMetadata) yield { usage: { inputTokens: data.usageMetadata.promptTokenCount || 0, outputTokens: data.usageMetadata.candidatesTokenCount || 0 } };
    }
  }
}
