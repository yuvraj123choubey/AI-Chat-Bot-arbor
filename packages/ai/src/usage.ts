import { appendFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import type { ModelDefinition, Usage } from "./types.ts";

/** Null when the registry has no price for the model, so unknown cost is never reported as free. */
export function estimateCost(model: ModelDefinition, usage: Usage): number | null {
  if (!model.inputUsdPerMillion && !model.outputUsdPerMillion) return null;
  return (usage.inputTokens * model.inputUsdPerMillion + usage.outputTokens * model.outputUsdPerMillion) / 1_000_000;
}
export async function appendRecord(path: string, entry: Record<string, unknown>) {
  await mkdir(dirname(path), { recursive: true });
  await appendFile(path, `${JSON.stringify(entry)}\n`);
}
