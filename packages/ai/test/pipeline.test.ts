import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Orchestrator } from "../src/orchestrator.ts";
import { parseRegistry } from "../src/registry.ts";
import { parseVerification, searchAll, structuralCitationCheck, type Source } from "../src/research.ts";
import type { AIProvider, GenerateRequest, GenerateResult, ModelDefinition, ProgressEvent, StreamChunk } from "../src/types.ts";

const model = (provider: string, modelId: string, extra: Partial<ModelDefinition> = {}): ModelDefinition => ({ id: `${provider}-${modelId}`, provider, modelId, displayName: modelId, capabilities: [], supportsStreaming: true, supportsTools: false, supportsVision: false, supportsReasoning: false, supportsCoding: false, contextWindow: 1000, inputUsdPerMillion: 1, outputUsdPerMillion: 1, enabled: true, ...extra });
class Scripted implements AIProvider {
  seen: { model: string; system: string }[] = [];
  constructor(readonly name: string, private readonly reply: (request: GenerateRequest) => string, private readonly failing = new Set<string>()) {}
  isConfigured() { return true; }
  async generate(request: GenerateRequest): Promise<GenerateResult> {
    this.seen.push({ model: request.model.modelId, system: request.messages[0].content });
    if (this.failing.has(request.model.modelId)) throw new Error("unavailable");
    return { text: this.reply(request), toolCalls: [], usage: { inputTokens: 10, outputTokens: 10 } };
  }
  async *stream(request: GenerateRequest): AsyncIterable<StreamChunk> { yield { text: (await this.generate(request)).text }; }
  toolCall(request: GenerateRequest) { return this.generate(request); }
  reason(request: GenerateRequest) { return this.generate(request); }
  analyzeCode(request: GenerateRequest) { return this.generate(request); }
}
async function withLog(fn: (path: string) => Promise<void>) {
  const folder = await mkdtemp(join(tmpdir(), "arbor-test-"));
  try { await fn(join(folder, "usage.jsonl")); } finally { await rm(folder, { recursive: true, force: true }); }
}
const source = (id: number, url: string): Source => ({ id, title: `T${id}`, url, excerpt: `excerpt ${url}`, evidenceType: "page" });

test("model IDs resolve from the environment and unset variables disable the model", () => {
  const raw = [model("deepseek", "", { modelIdEnv: "DS_MODEL" }), model("openai", "", { modelIdEnv: "OA_MODEL" })];
  const [deepseek, openai] = parseRegistry(raw, { DS_MODEL: " ds-latest " });
  assert.equal(deepseek.modelId, "ds-latest");
  assert.equal(deepseek.enabled, true);
  assert.equal(openai.enabled, false);
  assert.throws(() => parseRegistry([model("openai", "")], {}), /needs a modelId/);
});

test("fallback never silently downgrades to a model lacking the required capability", async () => {
  await withLog(async log => {
    const coder = model("deepseek", "coder", { supportsCoding: true, capabilities: ["coding"] });
    const fast = model("openai", "fast", { capabilities: ["fast"] });
    const orchestrator = new Orchestrator([coder, fast], new Map<string, AIProvider>([["deepseek", new Scripted("deepseek", () => "", new Set(["coder"]))], ["openai", new Scripted("openai", () => "fix")]]), log);
    await assert.rejects(orchestrator.run({ prompt: "debug this", taskKind: "code", mode: "balanced", modelChoice: "auto" }), /All eligible models failed: deepseek:coder/);
  });
});

test("a capability gap is used only when nothing qualifies, and is disclosed", async () => {
  await withLog(async log => {
    const orchestrator = new Orchestrator([model("openai", "fast", { capabilities: ["fast"] })], new Map([["openai", new Scripted("openai", () => "answer")]]), log);
    const result = await orchestrator.run({ prompt: "debug this", taskKind: "code", mode: "balanced", modelChoice: "auto" });
    assert.equal(result.model, "fast");
    assert.match(result.notices[0], /No enabled model offers coding/);
  });
});

test("deep research plans, searches extra queries, verifies citations and cross-checks with another provider", async () => {
  await withLog(async log => {
    const reasoner = model("deepseek", "ds", { supportsReasoning: true, capabilities: ["reasoning", "large-context"] });
    const reviewer = model("anthropic", "claude", { supportsReasoning: true, capabilities: ["reasoning"] });
    const fast = model("openai", "fast", { capabilities: ["fast"] });
    const reply = (request: GenerateRequest) => {
      const system = request.messages[0].content;
      if (system.startsWith("Write a short plan")) return '{"steps":["Find defenses","Compare them"],"searchQueries":["ransomware backups"]}';
      if (system.startsWith("You check whether")) return '{"results":[{"index":0,"verdict":"supported"},{"index":1,"verdict":"unsupported","note":"source is about phishing"}]}';
      if (system.startsWith("Review the draft")) return "Looks sound.";
      return "Backups limit damage [1]. Training stops all attacks [2]. See also [9].";
    };
    const providers = new Map<string, AIProvider>([["deepseek", new Scripted("deepseek", reply)], ["anthropic", new Scripted("anthropic", reply)], ["openai", new Scripted("openai", reply)]]);
    const queries: string[] = [];
    const search = async (q: string) => { queries.push(q); return q === "ransomware backups" ? [source(1, "https://b.example"), source(2, "https://a.example")] : [source(1, "https://a.example")]; };
    const events: ProgressEvent[] = [];
    const result = await new Orchestrator([reasoner, reviewer, fast], providers, log, { search }).run({ prompt: "Research ransomware defenses", taskKind: "research", mode: "deep", modelChoice: "auto" }, { onProgress: e => events.push(e) });

    assert.deepEqual(queries, ["Research ransomware defenses", "ransomware backups"]);
    assert.deepEqual(result.plan, ["Find defenses", "Compare them"]);
    assert.deepEqual(result.calls.map(c => `${c.role}:${c.model}`), ["planner:claude", "answer:ds", "verifier:fast", "reviewer:claude"]);
    assert.deepEqual(result.citationCheck?.invalid, [9]);
    assert.equal(result.citationCheck?.method, "model");
    assert.deepEqual(result.citationCheck?.flagged.map(f => [f.citation, f.verdict]), [[2, "unsupported"]]);
    assert.equal(result.review?.provider, "anthropic");
    assert.deepEqual(result.usage, { inputTokens: 40, outputTokens: 40 });
    assert.deepEqual(events.filter(e => e.status === "done").map(e => e.step), ["Planning", "Searching sources", "Analyzing", "Verifying result", "Reviewing final answer"]);
    const roles = (await readFile(log, "utf8")).trim().split("\n").map(line => JSON.parse(line).role);
    assert.deepEqual(roles, ["planner", "answer", "verifier", "reviewer"]);
  });
});

test("a manual provider choice pins every role, so data never reaches another provider", async () => {
  await withLog(async log => {
    const deepseek = new Scripted("deepseek", () => "Answer [1].");
    const openai = new Scripted("openai", () => "should not be called");
    const orchestrator = new Orchestrator([model("deepseek", "ds", { supportsReasoning: true, capabilities: ["reasoning"] }), model("openai", "fast", { capabilities: ["fast"] })], new Map<string, AIProvider>([["deepseek", deepseek], ["openai", openai]]), log, { search: async () => [source(1, "https://a.example")] });
    const result = await orchestrator.run({ prompt: "research it", taskKind: "research", mode: "deep", modelChoice: "deepseek" });
    assert.equal(openai.seen.length, 0);
    assert.ok(result.notices.some(n => /not cross-checked/.test(n)));
  });
});

test("citation helpers flag unknown sources, count only answered verdicts, and de-duplicate searches", async () => {
  const sources = [source(1, "https://a.example")];
  assert.deepEqual(structuralCitationCheck("Claim [1]. Other [1, 4].", sources).invalid, [4]);
  const claims = [{ citation: 1, claim: "a" }, { citation: 1, claim: "b" }];
  assert.deepEqual(parseVerification('ok {"results":[{"index":1,"verdict":"partial","note":"n"},{"index":7,"verdict":"unsupported"}]}', claims), { checked: 1, flagged: [{ citation: 1, claim: "b", verdict: "partial", note: "n" }] });
  const merged = await searchAll(["x", "y", "z"], 10, async q => {
    if (q === "z") throw new Error("down");
    return q === "x" ? [source(1, "https://a.example")] : [source(1, "https://a.example"), source(2, "https://b.example")];
  });
  assert.deepEqual(merged.map(s => [s.id, s.url]), [[1, "https://a.example"], [2, "https://b.example"]]);
});
