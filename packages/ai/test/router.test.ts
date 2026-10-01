import test from "node:test";
import assert from "node:assert/strict";
import { rankModels } from "../src/router.ts";
import type { ModelDefinition } from "../src/types.ts";

const fast: ModelDefinition = { id: "fast", provider: "openai", modelId: "fast-id", displayName: "Fast", capabilities: ["fast"], supportsStreaming: true, supportsTools: false, supportsVision: false, supportsReasoning: false, supportsCoding: false, contextWindow: 1000, inputUsdPerMillion: 1, outputUsdPerMillion: 1, enabled: true };
const deep: ModelDefinition = { id: "deep", provider: "deepseek", modelId: "reason-id", displayName: "Reason", capabilities: ["reasoning", "coding", "technical-analysis", "tools"], supportsStreaming: true, supportsTools: true, supportsVision: false, supportsReasoning: true, supportsCoding: true, contextWindow: 1000, inputUsdPerMillion: 2, outputUsdPerMillion: 2, enabled: true };

test("routes math to reasoning and ordinary chat to fast", () => {
  const allowed = new Set(["openai", "deepseek"]);
  assert.equal(rankModels([fast, deep], { prompt: "prove this theorem", taskKind: "math", mode: "balanced", modelChoice: "auto" }, allowed)[0], deep);
  assert.equal(rankModels([fast, deep], { prompt: "hello", taskKind: "chat", mode: "fast", modelChoice: "auto" }, allowed)[0], fast);
});
test("manual selection and privacy restrictions are enforced before ranking", () => {
  const request = { prompt: "debug code", taskKind: "code" as const, mode: "deep" as const, modelChoice: "deepseek" };
  assert.deepEqual(rankModels([fast, deep], request, new Set(["openai"])), []);
  assert.deepEqual(rankModels([fast, deep], request, new Set(["openai", "deepseek"])), [deep]);
});
