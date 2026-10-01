import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { ModelDefinition, ProviderName } from "./types.ts";

const validProviders = new Set(["openai", "anthropic", "google", "deepseek"]);
/** User-facing provider names; Anthropic models are presented as Claude. */
export const providerLabels: Record<string, string> = { openai: "OpenAI", anthropic: "Claude", google: "Gemini", deepseek: "DeepSeek" };
export function providerLabel(provider: ProviderName): string { return providerLabels[provider] || provider; }

export async function loadRegistry(path = process.env.MODEL_CONFIG_PATH || "config/models.example.json", env: NodeJS.ProcessEnv = process.env): Promise<ModelDefinition[]> {
  return parseRegistry(JSON.parse(await readFile(resolve(path), "utf8")), env);
}
export function parseRegistry(raw: unknown, env: NodeJS.ProcessEnv = process.env): ModelDefinition[] {
  if (!Array.isArray(raw)) throw new Error("Model configuration must be an array");
  const seen = new Set<string>();
  const ids = new Set<string>();
  return raw.map((item, index) => {
    if (!item || typeof item !== "object") throw new Error(`Invalid model at index ${index}`);
    const m = { ...item } as ModelDefinition;
    if (typeof m.id !== "string" || !/^[a-z0-9][a-z0-9._-]{0,63}$/.test(m.id)) throw new Error(`Model at index ${index} needs an id of lowercase letters, digits, '.', '_' or '-'`);
    if (ids.has(m.id)) throw new Error(`Duplicate model id ${m.id}`);
    ids.add(m.id);
    if (m.modelIdEnv !== undefined) {
      if (typeof m.modelIdEnv !== "string") throw new Error(`Invalid modelIdEnv at index ${index}`);
      m.modelId ??= "";
      const fromEnv = env[m.modelIdEnv]?.trim();
      if (fromEnv) m.modelId = fromEnv;
      // An unset variable means the operator has not set this model up; that is not a config error.
      else if (!m.modelId?.trim()) m.enabled = false;
    }
    if (!validProviders.has(m.provider) || typeof m.modelId !== "string" || typeof m.displayName !== "string" || !Array.isArray(m.capabilities) || typeof m.enabled !== "boolean") {
      throw new Error(`Invalid model at index ${index}`);
    }
    for (const key of ["supportsStreaming", "supportsTools", "supportsVision", "supportsReasoning", "supportsCoding"] as const) {
      if (typeof m[key] !== "boolean") throw new Error(`Invalid ${key} at index ${index}`);
    }
    for (const key of ["contextWindow", "inputUsdPerMillion", "outputUsdPerMillion"] as const) {
      if (!Number.isFinite(m[key]) || m[key] < 0) throw new Error(`Invalid ${key} at index ${index}`);
    }
    if (m.maxOutputTokens !== undefined && (!Number.isInteger(m.maxOutputTokens) || m.maxOutputTokens < 1)) throw new Error(`Invalid maxOutputTokens at index ${index}`);
    if (m.enabled && !m.modelId.trim()) throw new Error(`Enabled model ${m.displayName} needs a modelId`);
    const key = `${m.provider}:${m.modelId}`;
    // Two entries pointing at one provider model (e.g. both DeepSeek variables set to the same ID) would only duplicate the menu.
    if (m.enabled && seen.has(key)) m.enabled = false;
    if (m.enabled) seen.add(key);
    return m;
  });
}
export function configuredModels(models: ModelDefinition[], configured: Set<ProviderName>): ModelDefinition[] {
  return models.filter(m => m.enabled && configured.has(m.provider));
}
