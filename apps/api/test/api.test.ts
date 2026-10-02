import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { startTestDb, type TestDb } from "../../../packages/db/test/harness.ts";
import { createApp, type App } from "../src/app.ts";
import { createHttpServer } from "../src/http-server.ts";
import type { AIProvider, GenerateRequest, ModelDefinition, StreamChunk } from "../../../packages/ai/src/types.ts";
import type { SearchProvider } from "../../../packages/research/src/types.ts";

const model: ModelDefinition = { id: "stub-general", provider: "openai", modelId: "stub-1", displayName: "Stub", capabilities: ["fast", "reasoning"], supportsStreaming: true, supportsTools: false, supportsVision: false, supportsReasoning: true, supportsCoding: true, contextWindow: 0, inputUsdPerMillion: 1, outputUsdPerMillion: 2, enabled: true };

/** Scripted provider: answers depend on the prompt so each test can steer it. */
class StubProvider implements AIProvider {
  readonly name = "openai";
  requests: GenerateRequest[] = [];
  isConfigured() { return true; }
  async generate(request: GenerateRequest) {
    this.requests.push(request);
    return { text: '{"queries": ["ransomware backup defenses"]}', toolCalls: [], usage: { inputTokens: 5, outputTokens: 5 } };
  }
  async *stream(request: GenerateRequest): AsyncIterable<StreamChunk> {
    this.requests.push(request);
    const last = request.messages.at(-1)!.content;
    if (last.includes("[slow]")) {
      for (let i = 0; i < 200; i++) {
        if (request.signal?.aborted) throw request.signal.reason;
        yield { text: "tick " };
        await new Promise(r => setTimeout(r, 20));
      }
    }
    const text = last.includes("<<<") ? "Offline backups are the key defense [1]. Patching matters too [2, 7]. Invented claim [9]." : `Echo: ${last}`;
    for (const word of text.split(" ")) yield { text: `${word} ` };
    yield { usage: { inputTokens: 100, outputTokens: 20 } };
  }
  toolCall(request: GenerateRequest) { return this.generate(request); }
  reason(request: GenerateRequest) { return this.generate(request); }
  analyzeCode(request: GenerateRequest) { return this.generate(request); }
}
const search: SearchProvider = {
  id: "stub-search", label: "Stub search", coverage: "encyclopedia", isConfigured: () => true,
  async search(query) {
    return [
      { url: "https://example.org/backups", title: "Ransomware backups", snippet: "Backups", provider: "stub-search", query, rank: 0, fullText: "Offline backups are the most effective defense against ransomware encryption. ".repeat(30) },
      { url: "https://example.org/patching", title: "Ransomware patching", snippet: "Patching", provider: "stub-search", query, rank: 1, fullText: "Patching vulnerabilities is a ransomware defense that prevents initial access. ".repeat(30) }
    ];
  }
};

let testDb: TestDb, app: App, server: Server, base: string;
const provider = new StubProvider();
const legacyId = "11111111-1111-4111-8111-111111111111";

before(async () => {
  testDb = await startTestDb();
  await mkdir(join(testDb.dataRoot, "conversations"), { recursive: true });
  await writeFile(join(testDb.dataRoot, "conversations", `${legacyId}.json`), JSON.stringify({
    id: legacyId, title: "Old chat", workspaceId: "default", createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z",
    messages: [{ id: "22222222-2222-4222-8222-222222222222", role: "user", content: "old question", createdAt: "2026-01-01T00:00:00Z" },
      { id: "33333333-3333-4333-8333-333333333333", role: "assistant", content: "old answer", createdAt: "2026-01-01T00:00:01Z", status: "complete" }]
  }));
  app = await createApp({ db: testDb.db, providers: [provider], registry: [model], searchProviders: [search], dataRoot: testDb.dataRoot });
  server = createHttpServer(app).listen(0, "127.0.0.1");
  await new Promise(r => server.once("listening", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
after(async () => { server?.close(); await testDb?.stop(); });

async function chat(body: Record<string, unknown>, abortAfterDelta = false) {
  const controller = new AbortController();
  const res = await fetch(`${base}/api/chat`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ selectedModel: "auto", reasoningLevel: "balanced", ...body }), signal: controller.signal });
  if (!res.ok) return { status: res.status, events: [] as any[], error: (await res.json()).error };
  const events: any[] = [];
  let buffer = "";
  try {
    const reader = res.body!.pipeThrough(new TextDecoderStream()).getReader();
    for (let read = await reader.read(); !read.done; read = await reader.read()) {
      buffer += read.value;
      const lines = buffer.split("\n"); buffer = lines.pop()!;
      for (const line of lines.filter(Boolean)) {
        events.push(JSON.parse(line));
        if (abortAfterDelta && events.at(-1).type === "delta") controller.abort();
      }
    }
  } catch (error) { if (!controller.signal.aborted) throw error; }
  return { status: res.status, events, conversationId: events[0]?.conversation?.id as string };
}
const get = async (path: string) => (await fetch(`${base}${path}`)).json();

test("legacy JSON conversations are imported once and the files backed up", async () => {
  const list = await get("/api/conversations");
  assert.ok(list.some((c: any) => c.id === legacyId && c.title === "Old chat"));
  const conversation = await get(`/api/conversations/${legacyId}`);
  assert.deepEqual(conversation.messages.map((m: any) => m.content), ["old question", "old answer"]);
  assert.equal(existsSync(join(testDb.dataRoot, "conversations")), false);
  assert.equal(readdirSync(join(testDb.dataRoot, "backup")).length, 1);
});

test("plain chat streams and persists both turns with model metadata and usage", async () => {
  const { events, conversationId } = await chat({ message: "hello there", searchMode: "off" });
  assert.deepEqual([...new Set(events.map(e => e.type))], ["conversation", "model", "delta", "done"]);
  const conversation = await get(`/api/conversations/${conversationId}`);
  assert.equal(conversation.messages[1].content.trim(), "Echo: hello there");
  assert.equal(conversation.messages[1].meta.providerLabel, "OpenAI");
  assert.equal(conversation.messages[1].status, "complete");
  assert.ok(await app.db.usageEvent.count({ where: { conversationId } }) >= 1);
});

test("searched answers get sources, backend-checked citations and stored citation rows", async () => {
  const before = provider.requests.length;
  const { events, conversationId } = await chat({ message: "What are the best ransomware defenses?", searchMode: "on" });
  assert.deepEqual(events.filter(e => e.type === "status").map(e => e.stage), ["searching", "searching", "reading", "comparing", "writing"]);
  const sources = events.find(e => e.type === "sources").sources;
  assert.deepEqual(sources.map((s: any) => s.ordinal), [1, 2]);
  const done = events.find(e => e.type === "done");
  assert.equal(done.content.trim(), "Offline backups are the key defense [1]. Patching matters too [2]. Invented claim.");
  assert.deepEqual(done.cited, [1, 2]);
  const prompts = provider.requests.slice(before);
  assert.match(prompts[0].messages[0].content, /JSON only/, "query planner ran first");
  const answerPrompt = prompts.at(-1)!;
  assert.match(answerPrompt.messages[0].content, /Cite only the source numbers/);
  assert.match(answerPrompt.messages.at(-1)!.content, /\[1\] Ransomware (backups|patching)/);

  const conversation = await get(`/api/conversations/${conversationId}`);
  const reply = conversation.messages[1];
  assert.equal(reply.content.trim(), done.content.trim());
  assert.deepEqual(reply.sources.map((s: any) => [s.ordinal, s.cited]), [[1, true], [2, true]]);
  assert.deepEqual(reply.steps.map((s: any) => s.stage), ["searching", "reading", "comparing", "writing"]);
  const citations = await app.db.citation.findMany({ where: { messageId: reply.id }, orderBy: { ordinal: "asc" } });
  assert.deepEqual(citations.map(c => [c.ordinal, c.claim]), [[1, "Offline backups are the key defense."], [2, "Patching matters too."]]);

  const sourceId = reply.sources[0].source.id;
  assert.equal((await (await fetch(`${base}/api/sources/${sourceId}/save`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" })).json()).saved, true);
  const saved = await get("/api/sources?saved=true");
  assert.deepEqual(saved.map((s: any) => s.id), [sourceId]);
  assert.ok((await get(`/api/sources/${sourceId}`)).fullText.includes("Offline backups"));

  // The same URL found again later is stored once per workspace.
  await chat({ conversationId, message: "And how do backups help?", searchMode: "on" });
  assert.equal(await app.db.source.count({ where: { url: "https://example.org/backups" } }), 1);
});

test("regenerate replaces the last answer and its sources", async () => {
  const first = await chat({ message: "Find sources on ransomware", searchMode: "on" });
  const oldReply = (await get(`/api/conversations/${first.conversationId}`)).messages[1].id;
  const again = await chat({ conversationId: first.conversationId, regenerate: true, searchMode: "off" });
  assert.equal(again.events.at(-1).type, "done");
  const conversation = await get(`/api/conversations/${first.conversationId}`);
  assert.equal(conversation.messages.length, 2);
  assert.notEqual(conversation.messages[1].id, oldReply);
  assert.equal(await app.db.messageSource.count({ where: { messageId: oldReply } }), 0);
});

test("stopping keeps the partial reply as stopped; interrupted replies are marked after a restart", async () => {
  const { conversationId } = await chat({ message: "count [slow]", searchMode: "off" }, true);
  await new Promise(r => setTimeout(r, 300));
  const reply = (await get(`/api/conversations/${conversationId}`)).messages[1];
  assert.equal(reply.status, "stopped");
  assert.ok(reply.content.includes("tick") && reply.content.length < 200);
  assert.equal(app.generating.size, 0);

  const orphan = await app.conversations.addMessage(conversationId!, { role: "assistant", content: "" });
  await app.conversations.markInterrupted();
  assert.equal((await app.db.message.findUnique({ where: { id: orphan.id } }))!.status, "error");
});

test("conversations can be renamed and deleted; validation errors are clear", async () => {
  const { conversationId } = await chat({ message: "rename me", searchMode: "off" });
  const patch = await fetch(`${base}/api/conversations/${conversationId}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ title: "Renamed" }) });
  assert.equal(patch.status, 200);
  assert.equal((await get(`/api/conversations/${conversationId}`)).title, "Renamed");
  assert.equal((await fetch(`${base}/api/conversations/${conversationId}`, { method: "DELETE" })).status, 200);
  assert.equal((await fetch(`${base}/api/conversations/${conversationId}`)).status, 404);
  assert.equal(await app.db.message.count({ where: { conversationId } }), 0);
  assert.equal((await chat({ message: "x", selectedModel: "nope" })).status, 400);
  assert.equal((await chat({ message: "x", searchMode: "sometimes" })).status, 400);
  assert.equal((await fetch(`${base}/api/chat`, { method: "POST", headers: { "content-type": "text/plain" }, body: "{}" })).status, 415);
});
