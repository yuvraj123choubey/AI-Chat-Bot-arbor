import test from "node:test";
import assert from "node:assert/strict";
import { normalizeHistory, outputBudget, streamChat, type ChatEvent, type ChatInput } from "../src/chat.ts";
import { ProviderError, toProviderError } from "../src/providers/base.ts";
import { DeepSeekProvider } from "../src/providers/deepseek.ts";
import { OpenAIProvider } from "../src/providers/openai.ts";
import { AnthropicProvider } from "../src/providers/anthropic.ts";
import { GoogleProvider } from "../src/providers/google.ts";
import { redactSecrets } from "../src/redact.ts";
import type { AIProvider, GenerateRequest, ModelDefinition, StreamChunk } from "../src/types.ts";

const model = (id: string, provider: string, extra: Partial<ModelDefinition> = {}): ModelDefinition => ({ id, provider, modelId: `${id}-v1`, displayName: id, capabilities: [], supportsStreaming: true, supportsTools: false, supportsVision: false, supportsReasoning: false, supportsCoding: false, contextWindow: 0, inputUsdPerMillion: 0, outputUsdPerMillion: 0, enabled: true, ...extra });
const general = model("general", "openai", { capabilities: ["fast"] });
const coder = model("coder", "anthropic", { capabilities: ["coding"], supportsCoding: true });
const reasoner = model("reasoner", "deepseek", { capabilities: ["reasoning", "technical-analysis"], supportsReasoning: true, maxOutputTokens: 9000 });

type Script = (request: GenerateRequest, signal?: AbortSignal) => AsyncIterable<StreamChunk>;
class Fake implements AIProvider {
  calls: GenerateRequest[] = [];
  constructor(readonly name: string, private readonly script: Script) {}
  isConfigured() { return true; }
  stream(request: GenerateRequest) { this.calls.push(request); return this.script(request, request.signal); }
  async generate(): Promise<never> { throw new Error("unused"); }
  toolCall = this.generate; reason = this.generate; analyzeCode = this.generate;
}
const says = (text: string): Script => async function* () { yield { thinking: true }; for (const word of text.split(" ")) yield { text: `${word} ` }; yield { usage: { inputTokens: 5, outputTokens: 3 } }; };
const fails = (status: number, afterText = ""): Script => async function* (request) { if (afterText) yield { text: afterText }; throw new ProviderError(request.model.provider, status, "boom"); };
function deps(models: ModelDefinition[], scripts: Record<string, Script>, log: Record<string, unknown>[] = [], idleTimeoutMs = 2000) {
  const providers = new Map<string, Fake>(Object.entries(scripts).map(([name, s]) => [name, new Fake(name, s)]));
  return { deps: { models, providers, idleTimeoutMs, log: async (e: Record<string, unknown>) => { log.push(e); } }, providers, log };
}
async function collect(events: AsyncIterable<ChatEvent>) { const out: ChatEvent[] = []; for await (const e of events) out.push(e); return out; }
const ask = (message: string, extra: Partial<ChatInput> = {}): ChatInput => ({ history: [{ role: "user", content: message }], selectedModel: "auto", reasoningLevel: "balanced", ...extra });
const answered = (events: ChatEvent[]) => events.find(e => e.type === "model")?.type === "model" ? (events.find(e => e.type === "model") as Extract<ChatEvent, { type: "model" }>).model.id : undefined;
const text = (events: ChatEvent[]) => events.flatMap(e => e.type === "delta" ? [e.text] : []).join("");

test("Auto routes conversation, coding and reasoning prompts to suitable models", async () => {
  const all = [general, coder, reasoner];
  const { deps: d } = deps(all, { openai: says("hi"), anthropic: says("code"), deepseek: says("proof") });
  assert.equal(answered(await collect(streamChat(d, ask("hello, how are you?")))), "general");
  assert.equal(answered(await collect(streamChat(d, ask("Debug this React component")))), "coder");
  assert.equal(answered(await collect(streamChat(d, ask("Prove that the square root of 2 is irrational")))), "reasoner");
  assert.equal(answered(await collect(streamChat(d, ask("Research the evidence on sleep and memory")))), "reasoner");
  // A short follow-up stays with the conversation's kind of model.
  assert.equal(answered(await collect(streamChat(d, ask("why?", { previousTaskKind: "code" })))), "coder");
});

test("streams text, signals thinking without content, and reports the model that answered", async () => {
  const { deps: d } = deps([general], { openai: says("Hello there") });
  const events = await collect(streamChat(d, ask("hi")));
  assert.deepEqual(events.map(e => e.type), ["model", "thinking", "delta", "delta", "done"]);
  assert.equal(text(events), "Hello there ");
  assert.deepEqual(events.at(-1), { type: "done", stop: undefined, usage: { inputTokens: 5, outputTokens: 3 } });
});

test("manual selection uses only that model and does not fall back", async () => {
  const { deps: d, providers } = deps([general, reasoner], { openai: says("x"), deepseek: fails(503) });
  const events = await collect(streamChat(d, ask("hello", { selectedModel: "reasoner" })));
  assert.equal(providers.get("openai")!.calls.length, 0);
  assert.deepEqual(events, [{ type: "error", code: "unavailable", message: "DeepSeek is currently unavailable. Try another configured model." }]);
});

test("Auto falls back before any text is shown, records the failure, and discloses it", async () => {
  const log: Record<string, unknown>[] = [];
  const twoGeneral = [general, model("backup", "deepseek")];
  const { deps: d } = deps(twoGeneral, { openai: fails(429), deepseek: says("ok") }, log);
  const events = await collect(streamChat(d, ask("hello")));
  const meta = events.find(e => e.type === "model") as Extract<ChatEvent, { type: "model" }>;
  assert.equal(meta.model.id, "backup");
  assert.deepEqual(meta.fallbackFrom, ["OpenAI"]);
  assert.deepEqual(log.map(e => [e.type, e.provider, e.status]), [["provider_failure", "openai", "failed"], ["usage", "deepseek", "complete"]]);
});

test("does not fall back once text has streamed, and keeps the partial answer", async () => {
  const twoGeneral = [general, model("backup", "deepseek")];
  const { deps: d, providers } = deps(twoGeneral, { openai: fails(500, "partial "), deepseek: says("ok") });
  const events = await collect(streamChat(d, ask("hello")));
  assert.equal(providers.get("deepseek")!.calls.length, 0);
  assert.equal(text(events), "partial ");
  assert.equal(events.at(-1)!.type, "error");
});

test("missing configuration and unknown models produce friendly errors", async () => {
  assert.equal((await collect(streamChat(deps([], {}).deps, ask("hi"))))[0].type === "error" && "no_models", "no_models");
  const [event] = await collect(streamChat(deps([general], { openai: says("x") }).deps, ask("hi", { selectedModel: "missing" })));
  assert.deepEqual(event, { type: "error", code: "model_not_configured", message: "That model isn't configured on the server. Choose Auto or another model." });
});

test("cancelling stops the provider stream and reports stopped", async () => {
  const abort = new AbortController();
  const endless: Script = async function* (_request, signal) {
    yield { text: "start " };
    if (signal!.aborted) throw signal!.reason;
    await new Promise((_, reject) => signal!.addEventListener("abort", () => reject(signal!.reason), { once: true }));
  };
  const log: Record<string, unknown>[] = [];
  const { deps: d } = deps([general], { openai: endless }, log);
  const events: ChatEvent[] = [];
  for await (const e of streamChat(d, ask("hi"), abort.signal)) { events.push(e); if (e.type === "delta") abort.abort(); }
  assert.deepEqual(events.map(e => e.type), ["model", "delta", "stopped"]);
  assert.equal(log[0].status, "stopped");
});

test("a silent provider times out instead of hanging", async () => {
  const silent: Script = async function* (_request, signal) { await new Promise((_, reject) => signal!.addEventListener("abort", () => reject(new Error("aborted")), { once: true })); yield { text: "never reached" }; };
  const { deps: d } = deps([general], { openai: silent }, [], 30);
  const [event] = await collect(streamChat(d, ask("hi")));
  assert.equal(event.type === "error" && event.code, "timeout");
});

test("reasoning level sets the output budget within the model's limit", () => {
  assert.equal(outputBudget(general, "fast"), 2048);
  assert.equal(outputBudget(general, "deep"), 16384);
  assert.equal(outputBudget(reasoner, "fast"), 8192);
  assert.equal(outputBudget(reasoner, "deep"), 9000);
});

test("history drops empty turns, merges repeated roles, and starts with the user", () => {
  assert.deepEqual(normalizeHistory([{ role: "assistant", content: "hello" }, { role: "user", content: "a" }, { role: "assistant", content: "" }, { role: "user", content: "b" }]), [{ role: "user", content: "a\n\nb" }]);
});

test("provider failures are classified, and secrets are scrubbed from log text", () => {
  const code = (status: number, message = "x") => new ProviderError("openai", status, message).code;
  assert.deepEqual([code(401), code(402), code(429), code(429, "insufficient_quota"), code(404), code(400, "API key not valid"), code(400, "Model does not exist"), code(529), code(400)],
    ["auth", "quota", "rate_limit", "quota", "model_unavailable", "auth", "model_unavailable", "unavailable", "bad_request"]);
  assert.equal(toProviderError(new TypeError("fetch failed"), "openai").code, "network");
  assert.equal(toProviderError(Object.assign(new Error("t"), { name: "TimeoutError" }), "openai").code, "timeout");
  assert.equal(redactSecrets("Incorrect API key provided: sk-proj-abc123456789 and mysecretvalue1", { DEEPSEEK_API_KEY: "mysecretvalue1" }), "Incorrect API key provided: [redacted] and [redacted]");
});

function sse(events: string[]): Response {
  return new Response(events.map(e => `${e}\n\n`).join(""), { status: 200, headers: { "content-type": "text/event-stream" } });
}
async function withFetch(response: Response, run: (requests: { url: string; init: RequestInit }[]) => Promise<void>) {
  const original = globalThis.fetch;
  const requests: { url: string; init: RequestInit }[] = [];
  globalThis.fetch = (async (url: string, init: RequestInit) => { requests.push({ url: String(url), init }); return response; }) as typeof fetch;
  try { await run(requests); } finally { globalThis.fetch = original; }
}
async function chunks(stream: AsyncIterable<StreamChunk>) { const out: StreamChunk[] = []; for await (const c of stream) out.push(c); return out; }

test("DeepSeek streams answer text only, never its private reasoning", async () => {
  await withFetch(sse([
    'data: {"choices":[{"delta":{"reasoning_content":"SECRET"}}]}',
    'data: {"choices":[{"delta":{"content":"Answer"}}]}',
    'data: {"choices":[{"delta":{},"finish_reason":"length"}]}',
    'data: {"choices":[],"usage":{"prompt_tokens":4,"completion_tokens":2}}',
    "data: [DONE]"
  ]), async requests => {
    const out = await chunks(new DeepSeekProvider("key", "https://gateway.example/").stream({ model: reasoner, messages: [{ role: "user", content: "q" }], maxOutputTokens: 100 }));
    assert.deepEqual(out, [{ thinking: true }, { text: "Answer" }, { stop: "length" }, { usage: { inputTokens: 4, outputTokens: 2 } }]);
    assert.equal(requests[0].url, "https://gateway.example/chat/completions");
    const body = JSON.parse(String(requests[0].init.body));
    assert.equal(body.model, "reasoner-v1");
    assert.equal(body.max_tokens, 100);
    assert.equal(JSON.stringify(out).includes("SECRET"), false);
  });
});

test("OpenAI uses max_completion_tokens and surfaces HTTP errors as typed provider errors", async () => {
  await withFetch(sse(['data: {"choices":[{"delta":{"content":"ok"}}]}']), async requests => {
    await chunks(new OpenAIProvider("key").stream({ model: general, messages: [], maxOutputTokens: 50, temperature: 0.1 }));
    assert.equal(JSON.parse(String(requests[0].init.body)).max_completion_tokens, 50);
    assert.equal(JSON.parse(String(requests[0].init.body)).temperature, 0.1);
  });
  // Reasoning models fix their own sampling; a requested temperature is not sent to them.
  await withFetch(sse(['data: {"choices":[{"delta":{"content":"ok"}}]}']), async requests => {
    await chunks(new OpenAIProvider("key").stream({ model: { ...general, supportsReasoning: true }, messages: [], temperature: 0.1 }));
    assert.equal("temperature" in JSON.parse(String(requests[0].init.body)), false);
  });
  await withFetch(new Response('{"error":{"message":"bad key"}}', { status: 401 }), async () => {
    await assert.rejects(chunks(new OpenAIProvider("key").stream({ model: general, messages: [] })), (e: ProviderError) => e.code === "auth");
  });
});

test("Claude stream errors mid-response become typed errors", async () => {
  await withFetch(sse(['event: content_block_delta\ndata: {"index":0,"delta":{"type":"text_delta","text":"Hi"}}', 'event: error\ndata: {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}']), async requests => {
    const seen: StreamChunk[] = [];
    await assert.rejects((async () => { for await (const c of new AnthropicProvider("key").stream({ model: coder, messages: [{ role: "system", content: "s" }, { role: "user", content: "q" }], maxOutputTokens: 77 })) seen.push(c); })(), (e: ProviderError) => e.code === "unavailable");
    assert.deepEqual(seen, [{ text: "Hi" }]);
    const body = JSON.parse(String(requests[0].init.body));
    assert.equal(body.max_tokens, 77);
    assert.equal(body.system, "s");
  });
});

test("Gemini hides thought parts and reports blocked responses", async () => {
  await withFetch(sse(['data: {"candidates":[{"content":{"parts":[{"text":"private","thought":true},{"text":"Visible"}]},"finishReason":"SAFETY"}]}']), async () => {
    assert.deepEqual(await chunks(new GoogleProvider("key").stream({ model: general, messages: [{ role: "user", content: "q" }] })), [{ thinking: true }, { text: "Visible" }, { stop: "filtered" }]);
  });
});
