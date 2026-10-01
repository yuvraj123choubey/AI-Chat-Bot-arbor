import type { AIProvider, GenerateRequest, GenerateResult, ProviderName, StreamChunk } from "../types.ts";

export abstract class BaseProvider implements AIProvider {
  abstract readonly name: ProviderName;
  abstract isConfigured(): boolean;
  abstract generate(request: GenerateRequest): Promise<GenerateResult>;
  async *stream(request: GenerateRequest): AsyncIterable<StreamChunk> {
    const result = await this.generate(request);
    yield { text: result.text, usage: result.usage };
    for (const toolCall of result.toolCalls) yield { toolCall };
  }
  toolCall(request: GenerateRequest) { return this.generate(request); }
  reason(request: GenerateRequest) { return this.generate(request); }
  analyzeCode(request: GenerateRequest) { return this.generate(request); }
}

export type ProviderErrorCode = "auth" | "quota" | "rate_limit" | "unavailable" | "model_unavailable" | "bad_request" | "timeout" | "network" | "empty_response" | "filtered" | "unknown";
export class ProviderError extends Error {
  readonly code: ProviderErrorCode;
  constructor(public readonly provider: ProviderName, public readonly status: number, message: string, code?: ProviderErrorCode) {
    super(`${provider} request failed (${status}): ${message}`);
    this.code = code || codeForStatus(status, message);
  }
}
function codeForStatus(status: number, message: string): ProviderErrorCode {
  if (status === 401 || status === 403 || (status === 400 && /api[ _-]?key/i.test(message))) return "auth";
  if (status === 402 || (status === 429 && /quota|billing|balance|credit/i.test(message))) return "quota";
  if (status === 429) return "rate_limit";
  if (status === 404 || (status === 400 && /model/i.test(message) && /not found|does not exist|not exist|unknown|invalid|not supported/i.test(message))) return "model_unavailable";
  if (status === 408 || status === 504) return "timeout";
  if (status >= 500) return "unavailable";
  if (status >= 400) return "bad_request";
  return "unknown";
}
/** Normalises anything thrown during a provider call; abort and timeout errors from fetch become typed codes. */
export function toProviderError(error: unknown, provider: ProviderName): ProviderError {
  if (error instanceof ProviderError) return error;
  const name = error instanceof Error ? error.name : "";
  const message = error instanceof Error ? error.message : String(error);
  if (name === "TimeoutError") return new ProviderError(provider, 0, "timed out", "timeout");
  if (name === "TypeError" || /fetch failed|ECONN|ENOTFOUND|EAI_AGAIN|socket/i.test(message)) return new ProviderError(provider, 0, message, "network");
  return new ProviderError(provider, 0, message, "unknown");
}
export async function postJson(provider: ProviderName, url: string, headers: Record<string, string>, body: unknown, signal?: AbortSignal): Promise<any> {
  const response = await fetch(url, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body), signal });
  if (!response.ok) throw new ProviderError(provider, response.status, (await response.text()).slice(0, 500));
  return response.json();
}
export async function* parseSse(provider: ProviderName, response: Response): AsyncIterable<{ event: string; data: any }> {
  if (!response.ok) throw new ProviderError(provider, response.status, (await response.text()).slice(0, 500));
  if (!response.body) throw new ProviderError(provider, 0, "no response stream", "unavailable");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let split: number;
      while ((split = buffer.search(/\r?\n\r?\n/)) >= 0) {
        const block = buffer.slice(0, split);
        buffer = buffer.slice(split).replace(/^\r?\n\r?\n/, "");
        let event = "message";
        const data: string[] = [];
        for (const line of block.split(/\r?\n/)) {
          if (line.startsWith("event:")) event = line.slice(6).trim();
          if (line.startsWith("data:")) data.push(line.slice(5).trimStart());
        }
        if (data.length && data.join("\n") !== "[DONE]") yield { event, data: JSON.parse(data.join("\n")) };
      }
    }
  } finally { reader.releaseLock(); }
}
