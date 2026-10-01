import type { Capability, ModelDefinition, ProviderName, Role, TaskKind, TaskRequest } from "./types.ts";

interface Requirement { need: string; test: (m: ModelDefinition) => boolean }
interface Profile { prefer: Capability[]; requires: Requirement[] }
const coding: Requirement = { need: "coding", test: m => m.supportsCoding };
const reasoning: Requirement = { need: "reasoning", test: m => m.supportsReasoning };
const tools: Requirement = { need: "tool use", test: m => m.supportsTools };

const taskProfiles: Record<TaskKind, Profile> = {
  chat: { prefer: ["fast"], requires: [] },
  research: { prefer: ["reasoning", "large-context"], requires: [] },
  code: { prefer: ["coding", "reasoning"], requires: [coding] },
  math: { prefer: ["reasoning", "technical-analysis"], requires: [reasoning] },
  browser: { prefer: ["tools", "fast"], requires: [tools] },
  build: { prefer: ["coding", "reasoning", "tools"], requires: [coding] }
};
const roleProfiles: Record<Exclude<Role, "answer">, Profile> = {
  planner: { prefer: ["reasoning"], requires: [reasoning] },
  verifier: { prefer: ["fast"], requires: [] },
  reviewer: { prefer: ["reasoning", "technical-analysis"], requires: [reasoning] }
};

export function inferTaskKind(prompt: string): TaskKind {
  if (/\b(browser|click|navigate|screenshot|webpage)\b/i.test(prompt)) return "browser";
  if (/\b(build|create|develop)\b.{0,40}\b(app|website|project)\b/i.test(prompt)) return "build";
  if (/\b(code|debug|program|typescript|react|repository|bug|test)\b/i.test(prompt)) return "code";
  if (/\b(prove|proof|equations?|theorem|calculate|mathematics|derive|integral|probability|logic puzzle|step[- ]by[- ]step)\b/i.test(prompt)) return "math";
  if (/\b(research|sources|papers|citations|study|evidence)\b/i.test(prompt)) return "research";
  return "chat";
}
function profileFor(role: Role, request: TaskRequest): Profile {
  if (role !== "answer") return roleProfiles[role];
  const profile = taskProfiles[request.taskKind || inferTaskKind(request.prompt)];
  return request.mode === "deep" && !profile.requires.includes(reasoning) ? { ...profile, requires: [...profile.requires, reasoning] } : profile;
}
/** Capabilities the role needs that this model lacks; empty means the model is fully qualified. */
export function unmetRequirements(model: ModelDefinition, request: TaskRequest, role: Role = "answer"): string[] {
  return profileFor(role, request).requires.filter(r => !r.test(model)).map(r => r.need);
}
/**
 * Eligible models for a role, best first. Provider allow-lists and a manual provider choice are hard filters
 * applied to every role, so a task never sends data to a provider the user or organisation excluded.
 */
export function rankModels(models: ModelDefinition[], request: TaskRequest, allowed: Set<ProviderName>, role: Role = "answer"): ModelDefinition[] {
  const { prefer, requires } = profileFor(role, request);
  const eligible = models.filter(m => m.enabled && allowed.has(m.provider) && (request.modelChoice === "auto" || m.provider === request.modelChoice));
  return eligible.sort((a, b) => score(b) - score(a) || `${a.provider}:${a.modelId}`.localeCompare(`${b.provider}:${b.modelId}`));
  function score(m: ModelDefinition): number {
    let n = prefer.reduce((sum, c, i) => sum + (m.capabilities.includes(c) ? (i === 0 ? 12 : 5) : 0), 0);
    if (requires.every(r => r.test(m))) n += 50;
    if (role === "answer" && request.mode === "deep") n += m.supportsReasoning ? 15 : -15;
    if (role === "answer" && request.mode === "fast") n += m.capabilities.includes("fast") ? 15 : 0;
    if (role === "verifier" || request.mode !== "deep") n -= (m.inputUsdPerMillion + m.outputUsdPerMillion) / 10;
    return n;
  }
}
