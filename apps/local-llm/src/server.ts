/**
 * Arbor's built-in local model server: runs an open-weight GGUF model on this machine with llama.cpp
 * (via node-llama-cpp) and exposes an OpenAI-compatible /v1/chat/completions endpoint on 127.0.0.1.
 * Free to run, no account or key. The API talks to it through the same OpenAI-compatible provider code
 * used for hosted models, so Ollama, LM Studio or llama.cpp's own server can be used instead.
 *
 * Model ids ending in ":thinking" let the model reason privately first (streamed as reasoning_content,
 * which Arbor never shows); other ids ask for a direct answer.
 */
import "../../api/src/setup-env.ts";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { getLlama, LlamaChat, QwenChatWrapper, resolveChatWrapper, resolveModelFile, type ChatWrapper, type LlamaContextSequence, type LlamaModel } from "node-llama-cpp";
import { dataRoot } from "../../../packages/db/src/local.ts";
import { messageText, toHistory } from "./history.ts";

const DEFAULT_LOCAL_MODEL = "hf:Qwen/Qwen3-4B-GGUF:Q4_K_M";
const modelUri = process.env.LOCAL_MODEL || DEFAULT_LOCAL_MODEL;
const port = Number(process.env.LOCAL_LLM_PORT || 11435);
const contextSize = Number(process.env.LOCAL_CONTEXT_SIZE || 16384);
const parallel = Math.max(1, Number(process.env.LOCAL_PARALLEL || 2));
const modelsDir = join(dataRoot, "models");

type State = { phase: "downloading"; progress: number } | { phase: "loading" } | { phase: "ready"; model: string; gpu: string } | { phase: "failed"; error: string };
let state: State = { phase: "loading" };
let runtime: { model: LlamaModel; direct: ChatWrapper; thinking: ChatWrapper; sequences: LlamaContextSequence[] } | undefined;

/** Sequences are a fixed pool (one per parallel request); requests wait for a free one. */
const free: LlamaContextSequence[] = [];
const waiting: ((s: LlamaContextSequence) => void)[] = [];
function acquire(): Promise<LlamaContextSequence> {
  const s = free.pop();
  return s ? Promise.resolve(s) : new Promise(resolve => waiting.push(resolve));
}
function release(s: LlamaContextSequence) {
  const next = waiting.shift();
  if (next) next(s); else free.push(s);
}

async function load() {
  try {
    mkdirSync(modelsDir, { recursive: true });
    let lastLogged = -1;
    const path = await resolveModelFile(modelUri, {
      directory: modelsDir, cli: false,
      onProgress({ totalSize, downloadedSize }) {
        const progress = totalSize ? downloadedSize / totalSize : 0;
        state = { phase: "downloading", progress };
        const pct = Math.floor(progress * 100);
        if (pct >= lastLogged + 5) { lastLogged = pct; console.log(`Downloading local model ${modelUri}: ${pct}%`); }
      }
    });
    state = { phase: "loading" };
    const llama = await getLlama({ gpu: "auto" });
    const model = await llama.loadModel({ modelPath: path, gpuLayers: "auto" });
    const context = await model.createContext({ contextSize: { max: contextSize }, sequences: parallel, flashAttention: "auto" });
    const sequences = Array.from({ length: parallel }, () => context.getSequence());
    const base = resolveChatWrapper(model);
    const qwen = base instanceof QwenChatWrapper;
    runtime = {
      model, sequences,
      direct: qwen ? new QwenChatWrapper({ thoughts: "discourage" }) : base,
      thinking: qwen ? new QwenChatWrapper({ thoughts: "auto" }) : base
    };
    free.push(...sequences);
    const gpu = llama.gpu ? `${llama.gpu} (${(await llama.getGpuDeviceNames()).join(", ")})` : "CPU";
    state = { phase: "ready", model: model.filename ?? modelUri, gpu };
    console.log(`Local model ready: ${state.model} on ${gpu}, context ${context.contextSize} tokens × ${parallel}`);
  } catch (error) {
    state = { phase: "failed", error: error instanceof Error ? error.message : String(error) };
    console.error(`Local model failed to load: ${state.error}`);
  }
}

interface ChatBody { model?: string; messages?: { role: string; content: unknown }[]; stream?: boolean; max_tokens?: number; max_completion_tokens?: number; temperature?: number }

async function completions(req: IncomingMessage, res: ServerResponse) {
  let raw = "";
  for await (const chunk of req) { raw += chunk; if (raw.length > 4_000_000) return error(res, 413, "Request too large"); }
  let body: ChatBody;
  try { body = JSON.parse(raw); } catch { return error(res, 400, "Invalid JSON"); }
  if (!Array.isArray(body.messages) || !body.messages.length) return error(res, 400, "messages is required");
  if (!runtime || state.phase !== "ready") {
    const detail = state.phase === "downloading" ? `downloading the model (${Math.floor(state.progress * 100)}%)` : state.phase === "failed" ? `failed to load: ${state.error}` : "still loading the model";
    return error(res, 503, `The local model is ${detail}.`);
  }
  const thinking = typeof body.model === "string" && body.model.endsWith(":thinking");
  const maxTokens = Math.min(Number(body.max_completion_tokens || body.max_tokens) || 4096, contextSize);
  const abort = new AbortController();
  res.on("close", () => { if (!res.writableEnded) abort.abort(); });
  const history = toHistory(body.messages);
  const id = `chatcmpl-${Date.now().toString(36)}`;
  const created = Math.floor(Date.now() / 1000);
  const promptTokens = runtime.model.tokenize(body.messages.map(m => messageText(m.content)).join("\n")).length;
  const sequence = await acquire();
  const chat = new LlamaChat({ contextSequence: sequence, chatWrapper: thinking ? runtime.thinking : runtime.direct, autoDisposeSequence: false });
  try {
    if (body.stream) {
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store" });
      const sse = (delta: Record<string, unknown>, finish: string | null = null) => res.write(`data: ${JSON.stringify({ id, object: "chat.completion.chunk", created, model: body.model, choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`);
      const result = await chat.generateResponse(history, {
        maxTokens, temperature: body.temperature ?? (thinking ? 0.6 : 0.7), signal: abort.signal, stopOnAbortSignal: true,
        onResponseChunk(chunk) {
          if (chunk.type === "segment") { if (chunk.segmentType === "thought" && chunk.text) sse({ reasoning_content: chunk.text }); }
          else if (chunk.text) sse({ content: chunk.text });
        }
      });
      if (abort.signal.aborted) return res.end();
      sse({}, result.metadata.stopReason === "maxTokens" ? "length" : "stop");
      res.write(`data: ${JSON.stringify({ id, object: "chat.completion.chunk", created, model: body.model, choices: [], usage: usage(promptTokens, result.response) })}\n\n`);
      res.end("data: [DONE]\n\n");
    } else {
      const result = await chat.generateResponse(history, { maxTokens, temperature: body.temperature ?? 0.3, signal: abort.signal, stopOnAbortSignal: true });
      json(res, 200, { id, object: "chat.completion", created, model: body.model, choices: [{ index: 0, message: { role: "assistant", content: result.response }, finish_reason: result.metadata.stopReason === "maxTokens" ? "length" : "stop" }], usage: usage(promptTokens, result.response) });
    }
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    console.error(`Generation failed: ${message}`);
    if (!res.headersSent) error(res, /context|too long|exceed/i.test(message) ? 400 : 500, message.slice(0, 300));
    else res.end();
  } finally {
    chat.dispose({ disposeSequence: false });
    release(sequence);
  }
}
function usage(promptTokens: number, response: string) {
  const completion = runtime ? runtime.model.tokenize(response).length : 0;
  return { prompt_tokens: promptTokens, completion_tokens: completion, total_tokens: promptTokens + completion };
}
function json(res: ServerResponse, status: number, data: unknown) { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(data)); }
function error(res: ServerResponse, status: number, message: string) { json(res, status, { error: { message, type: status === 503 ? "unavailable" : "invalid_request_error" } }); }

const server = createServer((req, res) => {
  // Same-machine only: the host check blocks DNS-rebinding pages from using the local model.
  if (!/^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/.test(req.headers.host || "")) return error(res, 403, "Forbidden host");
  const url = new URL(req.url || "/", "http://localhost");
  if (req.method === "GET" && url.pathname === "/health") return json(res, 200, state);
  if (req.method === "GET" && url.pathname === "/v1/models") return json(res, 200, { object: "list", data: state.phase === "ready" ? [{ id: "local", object: "model", owned_by: "arbor", description: state.model }] : [] });
  if (req.method === "POST" && url.pathname === "/v1/chat/completions") return void completions(req, res).catch(e => { if (!res.headersSent) error(res, 500, String(e)); });
  error(res, 404, "Not found");
});
server.on("error", e => { console.error(`Local model server could not start: ${e.message}`); process.exit(1); });
server.listen(port, "127.0.0.1", () => {
  console.log(`Local model server on http://127.0.0.1:${port} (model ${modelUri})`);
  void load();
});
