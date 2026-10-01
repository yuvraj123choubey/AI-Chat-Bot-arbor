import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Orchestrator } from "../src/orchestrator.ts";
import type { AIProvider, GenerateRequest, GenerateResult, ModelDefinition, StreamChunk } from "../src/types.ts";

const definition = (provider: string, modelId: string): ModelDefinition => ({ id: `${provider}-${modelId}`, provider, modelId, displayName: modelId, capabilities: ["fast", "reasoning"], supportsStreaming: true, supportsTools: false, supportsVision: false, supportsReasoning: true, supportsCoding: false, contextWindow: 1000, inputUsdPerMillion: provider === "openai" ? 1 : 2, outputUsdPerMillion: provider === "openai" ? 2 : 4, enabled: true });
class Stub implements AIProvider {
  constructor(readonly name: string, readonly fails = false) {}
  isConfigured() { return true; }
  async generate(_request: GenerateRequest): Promise<GenerateResult> { if (this.fails) throw new Error("temporary failure"); return { text: "done", toolCalls: [], usage: { inputTokens: 100, outputTokens: 50 } }; }
  async *stream(request: GenerateRequest): AsyncIterable<StreamChunk> { yield { text: (await this.generate(request)).text }; }
  toolCall(request: GenerateRequest) { return this.generate(request); }
  reason(request: GenerateRequest) { return this.generate(request); }
  analyzeCode(request: GenerateRequest) { return this.generate(request); }
}
test("falls back, reports actual model, and records usage", async () => {
  const folder = await mkdtemp(join(tmpdir(), "arbor-test-"));
  try {
    const orchestrator = new Orchestrator([definition("openai", "a"), definition("deepseek", "b")], new Map([["openai", new Stub("openai", true)], ["deepseek", new Stub("deepseek")]]), join(folder, "usage.jsonl"));
    const result = await orchestrator.run({ prompt: "hello", taskKind: "chat", mode: "balanced", modelChoice: "auto" });
    assert.equal(result.provider, "deepseek");
    assert.deepEqual(result.fallbackFrom, ["openai:a"]);
    assert.equal(result.estimatedCostUsd, 0.0004);
    const log = (await readFile(join(folder, "usage.jsonl"), "utf8")).trim().split("\n").map(line => JSON.parse(line));
    assert.equal(log[0].type, "provider_failure");
    assert.equal(log[1].provider, "deepseek");
  } finally { await rm(folder, { recursive: true, force: true }); }
});
