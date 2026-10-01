import "./setup-env.ts";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import { loadRegistry, providerLabel } from "../../../packages/ai/src/registry.ts";
import { Orchestrator } from "../../../packages/ai/src/orchestrator.ts";
import { friendlyError, streamChat } from "../../../packages/ai/src/chat.ts";
import { appendRecord } from "../../../packages/ai/src/usage.ts";
import { redactSecrets } from "../../../packages/ai/src/redact.ts";
import { DeepSeekProvider } from "../../../packages/ai/src/providers/deepseek.ts";
import { OpenAIProvider } from "../../../packages/ai/src/providers/openai.ts";
import { AnthropicProvider } from "../../../packages/ai/src/providers/anthropic.ts";
import { GoogleProvider } from "../../../packages/ai/src/providers/google.ts";
import type { ModelDefinition, ProviderName, ReasoningMode, TaskRequest } from "../../../packages/ai/src/types.ts";
import { FileConversationStore, isConversationId, titleFrom, type Conversation, type StoredMessage } from "./conversations.ts";

const providers = [new OpenAIProvider(), new AnthropicProvider(), new GoogleProvider(), new DeepSeekProvider()];
const providerMap = new Map<ProviderName, (typeof providers)[number]>(providers.map(p => [p.name, p]));
const registry = await loadRegistry();
const policy = parseAllowedProviders();
const orchestrator = new Orchestrator(registry, providerMap);
const store = new FileConversationStore();
const usageLog = "data/usage.jsonl";
const idleTimeoutMs = Number(process.env.PROVIDER_TIMEOUT_MS) || 180_000;
/** Conversations with a response in flight; a second concurrent request would interleave history. */
const generating = new Set<string>();
const port = Number(process.env.PORT || 8787);

/** Models offered to users: enabled in the registry, credentialed on this server, and permitted by policy. */
function chatModels(): ModelDefinition[] {
  return registry.filter(m => m.enabled && policy.has(m.provider) && providerMap.get(m.provider)?.isConfigured());
}

const server = createServer(async (req, res) => {
  res.setHeader("content-type", "application/json; charset=utf-8");
  res.setHeader("cache-control", "no-store");
  try {
    // Only same-machine hosts are served, which blocks DNS-rebinding pages from spending the server's API credit.
    if (!/^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/.test(req.headers.host || "")) return send(res, 403, { error: "Forbidden host" });
    // Requiring JSON forces a CORS preflight, so other websites cannot submit cross-origin requests.
    if (req.method !== "GET" && req.method !== "DELETE" && !/^application\/json\b/i.test(req.headers["content-type"] || "")) return send(res, 415, { error: "Requests must be JSON" });
    const url = new URL(req.url || "/", "http://localhost");
    const conversationPath = url.pathname.match(/^\/api\/conversations\/([^/]+)$/);

    if (url.pathname === "/api/health" && req.method === "GET") return send(res, 200, { ok: true });
    if (url.pathname === "/api/models" && req.method === "GET") {
      return send(res, 200, chatModels().map(m => ({
        id: m.id, provider: m.provider, providerLabel: providerLabel(m.provider), displayName: m.displayName, modelId: m.modelId, capabilities: m.capabilities,
        supportsStreaming: m.supportsStreaming, supportsTools: m.supportsTools, supportsVision: m.supportsVision, supportsReasoning: m.supportsReasoning, supportsCoding: m.supportsCoding
      })));
    }
    if (url.pathname === "/api/conversations" && req.method === "GET") {
      const workspaceId = parseWorkspace(url.searchParams.get("workspaceId"));
      return workspaceId ? send(res, 200, await store.list(workspaceId)) : send(res, 400, { error: "Invalid workspace" });
    }
    if (conversationPath && req.method === "GET") {
      const conversation = await store.get(conversationPath[1]);
      return conversation ? send(res, 200, conversation) : send(res, 404, { error: "Conversation not found" });
    }
    if (conversationPath && req.method === "DELETE") {
      if (generating.has(conversationPath[1])) return send(res, 409, { error: "Stop the current response before deleting this conversation." });
      return (await store.delete(conversationPath[1])) ? send(res, 200, { ok: true }) : send(res, 404, { error: "Conversation not found" });
    }
    if (url.pathname === "/api/chat" && req.method === "POST") return await chat(req, res);
    if (url.pathname === "/api/tasks" && req.method === "POST") {
      const task = parseTask(await readJson(req));
      if (typeof task === "string") return send(res, 400, { error: task });
      return send(res, 200, await orchestrator.run(task));
    }
    // Same task as /api/tasks, streamed as NDJSON: progress events while running, then one result or error line.
    if (url.pathname === "/api/tasks/stream" && req.method === "POST") {
      const task = parseTask(await readJson(req));
      if (typeof task === "string") return send(res, 400, { error: task });
      const abort = new AbortController();
      res.on("close", () => { if (!res.writableEnded) abort.abort(); });
      res.writeHead(200, { "content-type": "application/x-ndjson; charset=utf-8" });
      const line = (data: unknown) => { if (!res.writableEnded) res.write(`${JSON.stringify(data)}\n`); };
      try {
        line({ type: "result", result: await orchestrator.run(task, { signal: abort.signal, onProgress: event => line({ type: "progress", ...event }) }) });
      } catch (error) { line({ type: "error", error: error instanceof Error ? error.message : "Unexpected error" }); }
      return res.end();
    }
    return send(res, 404, { error: "Not found" });
  } catch (error) {
    if (error instanceof RequestError) return send(res, error.status, { error: error.message });
    console.error("Request failed:", redactSecrets(error instanceof Error ? error.stack || error.message : String(error)));
    if (!res.headersSent) return send(res, 500, { error: "Something went wrong on the server." });
    res.end();
  }
});

/**
 * POST /api/chat streams NDJSON events: `conversation` first, then `model`, `thinking`, `delta`…, and finally
 * `done`, `stopped` or `error`. The user turn is saved before generation starts and the reply when it ends,
 * including partial replies that were stopped or failed mid-stream.
 */
async function chat(req: IncomingMessage, res: ServerResponse) {
  const input = parseChat(await readJson(req));
  if (typeof input === "string") return send(res, 400, { error: input });
  const models = chatModels();
  if (!models.length) return send(res, 503, { error: friendlyError("no_models") });
  if (input.selectedModel !== "auto" && !models.some(m => m.id === input.selectedModel)) return send(res, 400, { error: "That model isn't configured on the server. Choose Auto or another model." });

  const now = new Date().toISOString();
  let conversation: Conversation | undefined;
  if (input.conversationId) {
    conversation = await store.get(input.conversationId);
    if (!conversation || conversation.workspaceId !== input.workspaceId) return send(res, 404, { error: "Conversation not found" });
  } else {
    if (input.regenerate) return send(res, 400, { error: "Nothing to regenerate" });
    conversation = { id: randomUUID(), title: titleFrom(input.message!), workspaceId: input.workspaceId, createdAt: now, updatedAt: now, messages: [] };
  }
  if (generating.has(conversation.id)) return send(res, 409, { error: "A response is already being generated in this conversation." });
  if (input.regenerate) {
    while (conversation.messages.at(-1)?.role === "assistant") conversation.messages.pop();
    if (!conversation.messages.length) return send(res, 400, { error: "Nothing to regenerate" });
  } else {
    conversation.messages.push({ id: randomUUID(), role: "user", content: input.message!, createdAt: now });
  }
  const previousTaskKind = conversation.messages.findLast(m => m.role === "assistant" && m.meta)?.meta?.taskKind;
  conversation.updatedAt = now;

  generating.add(conversation.id);
  try {
    await store.save(conversation);
    const abort = new AbortController();
    res.on("close", () => { if (!res.writableEnded) abort.abort(); });
    res.writeHead(200, { "content-type": "application/x-ndjson; charset=utf-8", "x-accel-buffering": "no" });
    const line = (data: unknown) => { if (!res.writableEnded && !res.destroyed) res.write(`${JSON.stringify(data)}\n`); };
    line({ type: "conversation", conversation: { id: conversation.id, title: conversation.title, workspaceId: conversation.workspaceId, updatedAt: conversation.updatedAt }, userMessageId: conversation.messages.at(-1)!.id });

    const reply: StoredMessage = { id: randomUUID(), role: "assistant", content: "", createdAt: new Date().toISOString() };
    const events = streamChat(
      { models, providers: providerMap, idleTimeoutMs, log: entry => appendRecord(usageLog, entry) },
      { history: conversation.messages.map(m => ({ role: m.role, content: m.content })), selectedModel: input.selectedModel, reasoningLevel: input.reasoningLevel, previousTaskKind, context: { conversationId: conversation.id, workspaceId: conversation.workspaceId } },
      abort.signal
    );
    for await (const event of events) {
      if (event.type === "model") reply.meta = { modelId: event.model.modelId, registryId: event.model.id, provider: event.model.provider, providerLabel: event.model.providerLabel, displayName: event.model.displayName, reasoningLevel: event.reasoningLevel, taskKind: event.taskKind, fallbackFrom: event.fallbackFrom };
      if (event.type === "delta") reply.content += event.text;
      if (event.type === "done") { reply.status = "complete"; reply.stop = event.stop; }
      if (event.type === "stopped") reply.status = "stopped";
      if (event.type === "error") { reply.status = "error"; reply.error = event.message; console.warn(`Chat error (${event.code}): ${event.message}`); }
      line(event.type === "model" ? { ...event, messageId: reply.id } : event);
    }
    conversation.messages.push(reply);
    conversation.updatedAt = new Date().toISOString();
    await store.save(conversation);
    res.end();
  } finally { generating.delete(conversation.id); }
}

server.listen(port, "127.0.0.1", () => {
  console.log(`API listening on http://127.0.0.1:${port}`);
  describeSetup();
});

/** Startup summary so a missing key or model ID is obvious from the server log; never prints secrets. */
function describeSetup() {
  const ready = chatModels();
  if (ready.length) console.log(`Models ready: ${ready.map(m => `${m.id} (${providerLabel(m.provider)} ${m.modelId})`).join(", ")}`);
  else console.log("No models are ready. Add a provider API key and at least one model ID to .env, then restart.");
  for (const provider of providers) {
    const named = registry.filter(m => m.provider === provider.name && m.enabled);
    if (named.length && !provider.isConfigured()) console.log(`${providerLabel(provider.name)}: model ID set (${named.map(m => m.modelIdEnv || m.id).join(", ")}) but no API key.`);
    if (!named.length && provider.isConfigured()) console.log(`${providerLabel(provider.name)}: API key set but no model ID; set one of ${registry.filter(m => m.provider === provider.name).map(m => m.modelIdEnv).filter(Boolean).join(", ")}.`);
    if (named.length && provider.isConfigured() && !policy.has(provider.name)) console.log(`${providerLabel(provider.name)}: configured but excluded by ALLOWED_PROVIDERS.`);
  }
}

class RequestError extends Error { constructor(public readonly status: number, message: string) { super(message); } }
interface ChatRequest { conversationId?: string; workspaceId: string; message?: string; regenerate: boolean; selectedModel: string; reasoningLevel: ReasoningMode }
function parseChat(body: any): ChatRequest | string {
  const regenerate = body?.regenerate === true;
  if (!regenerate && (typeof body?.message !== "string" || !body.message.trim() || body.message.length > 20000)) return "Message must contain 1–20,000 characters";
  if (body.conversationId !== undefined && (typeof body.conversationId !== "string" || !isConversationId(body.conversationId))) return "Invalid conversation";
  const workspaceId = parseWorkspace(body.workspaceId);
  if (!workspaceId) return "Invalid workspace";
  const selectedModel = body.selectedModel === undefined ? "auto" : body.selectedModel;
  if (typeof selectedModel !== "string" || selectedModel.length > 64) return "Invalid model selection";
  const reasoningLevel = body.reasoningLevel === undefined ? "balanced" : body.reasoningLevel;
  if (!["fast", "balanced", "deep"].includes(reasoningLevel)) return "Reasoning level must be fast, balanced or deep";
  return { conversationId: body.conversationId, workspaceId, message: regenerate ? undefined : body.message.trim(), regenerate, selectedModel, reasoningLevel };
}
function parseWorkspace(value: unknown): string | undefined {
  if (value === undefined || value === null) return "default";
  return typeof value === "string" && /^[A-Za-z0-9_-]{1,64}$/.test(value) ? value : undefined;
}
function parseTask(body: any): TaskRequest | string {
  if (typeof body?.prompt !== "string" || !body.prompt.trim() || body.prompt.length > 20000) return "Prompt must contain 1–20,000 characters";
  const mode = ["fast", "balanced", "deep"].includes(body.mode) ? body.mode : "balanced";
  const modelChoice = typeof body.modelChoice === "string" ? body.modelChoice : "auto";
  if (modelChoice !== "auto" && !providers.some(p => p.name === modelChoice)) return "Invalid provider selection";
  const requested = Array.isArray(body.allowedProviders) ? body.allowedProviders.filter((p: unknown) => typeof p === "string" && policy.has(p as ProviderName)) : [...policy];
  const taskKind = ["chat", "research", "code", "math", "browser", "build"].includes(body.taskKind) ? body.taskKind : undefined;
  return { prompt: body.prompt.trim(), mode, modelChoice, allowedProviders: requested, taskKind, workspaceId: typeof body.workspaceId === "string" ? body.workspaceId.slice(0, 100) : undefined, userId: typeof body.userId === "string" ? body.userId.slice(0, 100) : undefined };
}
function parseAllowedProviders(): Set<ProviderName> {
  let list: unknown;
  try { list = JSON.parse(process.env.ALLOWED_PROVIDERS || "null"); } catch { throw new Error("ALLOWED_PROVIDERS must be a JSON array, e.g. [\"openai\",\"deepseek\"]"); }
  if (Array.isArray(list)) return new Set(list.filter((x): x is ProviderName => typeof x === "string"));
  return new Set(providers.map(p => p.name));
}
async function readJson(req: IncomingMessage): Promise<any> {
  let content = "";
  for await (const chunk of req) { content += chunk; if (content.length > 100_000) throw new RequestError(413, "Request too large"); }
  try { return JSON.parse(content); } catch { throw new RequestError(400, "Request body must be valid JSON"); }
}
function send(res: ServerResponse, status: number, data: unknown) { res.writeHead(status); res.end(JSON.stringify(data)); }
