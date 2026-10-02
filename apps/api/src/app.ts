import { loadRegistry } from "../../../packages/ai/src/registry.ts";
import { Orchestrator } from "../../../packages/ai/src/orchestrator.ts";
import { DeepSeekProvider } from "../../../packages/ai/src/providers/deepseek.ts";
import { LocalProvider } from "../../../packages/ai/src/providers/local.ts";
import { OpenAIProvider } from "../../../packages/ai/src/providers/openai.ts";
import { AnthropicProvider } from "../../../packages/ai/src/providers/anthropic.ts";
import { GoogleProvider } from "../../../packages/ai/src/providers/google.ts";
import type { AIProvider, ModelDefinition, ProviderName } from "../../../packages/ai/src/types.ts";
import { createDb, waitForDb, type Db } from "../../../packages/db/src/client.ts";
import { dataRoot } from "../../../packages/db/src/local.ts";
import { searchProviders } from "../../../packages/research/src/index.ts";
import type { SearchProvider } from "../../../packages/research/src/types.ts";
import { bootstrapLocalIdentity, resolveWorkspace, type LocalIdentity } from "./repos/workspace.ts";
import { ConversationRepo } from "./repos/conversations.ts";
import { SourceRepo } from "./repos/sources.ts";
import { importLegacyConversations } from "./repos/legacy-import.ts";

export interface App {
  db: Db;
  identity: LocalIdentity;
  registry: ModelDefinition[];
  providers: AIProvider[];
  providerMap: Map<ProviderName, AIProvider>;
  policy: Set<ProviderName>;
  orchestrator: Orchestrator;
  conversations: ConversationRepo;
  sources: SourceRepo;
  searchProviders: SearchProvider[];
  idleTimeoutMs: number;
  /** Conversations with a response in flight; a second concurrent request would interleave history. */
  generating: Set<string>;
  /** Models offered to users: enabled in the registry, credentialed on this server, and permitted by policy. */
  chatModels(): ModelDefinition[];
  workspace(slug: string): Promise<string>;
  recordUsage(entry: Record<string, unknown>): Promise<void>;
}

export interface AppOverrides { db?: Db; providers?: AIProvider[]; registry?: ModelDefinition[]; searchProviders?: SearchProvider[]; dataRoot?: string }

export async function createApp(overrides: AppOverrides = {}): Promise<App> {
  const providers = overrides.providers ?? [new LocalProvider(), new OpenAIProvider(), new AnthropicProvider(), new GoogleProvider(), new DeepSeekProvider()];
  const providerMap = new Map<ProviderName, AIProvider>(providers.map(p => [p.name, p]));
  const registry = overrides.registry ?? await loadRegistry();
  const policy = parseAllowedProviders(providers);
  const db = overrides.db ?? createDb();
  await waitForDb(db);
  const identity = await bootstrapLocalIdentity(db);
  const conversations = new ConversationRepo(db);
  const imported = await importLegacyConversations(db, identity, overrides.dataRoot ?? dataRoot);
  if (imported) console.log(`Imported ${imported} conversation(s) from the earlier file store (originals kept in data/backup/).`);
  await conversations.markInterrupted();

  const app: App = {
    db, identity, registry, providers, providerMap, policy,
    orchestrator: new Orchestrator(registry, providerMap),
    conversations, sources: new SourceRepo(db),
    searchProviders: overrides.searchProviders ?? searchProviders(),
    idleTimeoutMs: Number(process.env.PROVIDER_TIMEOUT_MS) || 180_000,
    generating: new Set(),
    chatModels: () => registry.filter(m => m.enabled && policy.has(m.provider) && providerMap.get(m.provider)?.isConfigured()),
    workspace: slug => resolveWorkspace(db, identity, slug),
    async recordUsage(entry) {
      const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
      const str = (v: unknown) => (typeof v === "string" ? v : undefined);
      await db.usageEvent.create({
        data: {
          workspaceId: str(entry.workspaceId), conversationId: str(entry.conversationId), taskId: str(entry.taskId),
          provider: str(entry.provider) ?? "unknown", model: str(entry.model) ?? "unknown", registryId: str(entry.registryId), task: str(entry.task), role: str(entry.role),
          status: str(entry.status) ?? (entry.type === "provider_failure" ? "failed" : "complete"),
          inputTokens: num(entry.inputTokens) ?? 0, outputTokens: num(entry.outputTokens) ?? 0, costUsd: num(entry.estimatedCostUsd) ?? null
        }
      }).catch(error => console.warn("Could not record usage:", error instanceof Error ? error.message : error));
    }
  };
  return app;
}

function parseAllowedProviders(providers: AIProvider[]): Set<ProviderName> {
  let list: unknown;
  try { list = JSON.parse(process.env.ALLOWED_PROVIDERS || "null"); } catch { throw new Error("ALLOWED_PROVIDERS must be a JSON array, e.g. [\"openai\",\"deepseek\"]"); }
  if (Array.isArray(list)) return new Set(list.filter((x): x is ProviderName => typeof x === "string"));
  return new Set(providers.map(p => p.name));
}
