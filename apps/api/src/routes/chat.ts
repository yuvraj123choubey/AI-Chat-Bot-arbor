import { friendlyError, streamChat } from "../../../../packages/ai/src/chat.ts";
import { selectContext } from "../../../../packages/ai/src/context.ts";
import { rankModels } from "../../../../packages/ai/src/router.ts";
import type { Message, ModelDefinition, ReasoningMode } from "../../../../packages/ai/src/types.ts";
import { citationClaims, citationRules, gatherEvidence, groundedUserPrompt, sanitizeCitations, sanitizeLinks, searchIntent, urls, type ResearchStatus, type SearchMode } from "../../../../packages/research/src/index.ts";
import { claimsUnverifiable, type SearchIntent } from "../../../../packages/research/src/intent.ts";
import { planQueries } from "../../../../packages/research/src/queries.ts";
import type { App } from "../app.ts";
import { ndjson, readJson, send, type RouteContext } from "../http.ts";
import { isConversationId, titleFrom, type MessageMeta } from "../repos/conversations.ts";
import { toSourceView } from "../repos/sources.ts";

interface ChatRequest { conversationId?: string; workspace: string; message?: string; regenerate: boolean; selectedModel: string; reasoningLevel: ReasoningMode; searchMode: SearchMode }
export function parseChat(body: any): ChatRequest | string {
  const regenerate = body?.regenerate === true;
  if (!regenerate && (typeof body?.message !== "string" || !body.message.trim() || body.message.length > 20000)) return "Message must contain 1–20,000 characters";
  if (body.conversationId !== undefined && (typeof body.conversationId !== "string" || !isConversationId(body.conversationId))) return "Invalid conversation";
  const workspace = parseWorkspace(body.workspaceId);
  if (!workspace) return "Invalid workspace";
  const selectedModel = body.selectedModel ?? "auto";
  if (typeof selectedModel !== "string" || selectedModel.length > 64) return "Invalid model selection";
  const reasoningLevel = body.reasoningLevel ?? "balanced";
  if (!["fast", "balanced", "deep"].includes(reasoningLevel)) return "Reasoning level must be fast, balanced or deep";
  const searchMode = body.searchMode ?? "auto";
  if (!["auto", "on", "off"].includes(searchMode)) return "Search must be auto, on or off";
  return { conversationId: body.conversationId, workspace, message: regenerate ? undefined : body.message.trim(), regenerate, selectedModel, reasoningLevel, searchMode };
}
export function parseWorkspace(value: unknown): string | undefined {
  if (value === undefined || value === null) return "default";
  return typeof value === "string" && /^[A-Za-z0-9_-]{1,64}$/.test(value) ? value : undefined;
}

/**
 * POST /api/chat streams NDJSON: `conversation`, then for searched answers `status` updates and `sources`,
 * then `model`, `thinking`, `delta`…, and finally `done`, `stopped` or `error`. The user turn and an empty reply
 * row are saved first; the reply is completed when generation ends, including stopped or failed replies.
 */
export async function chatRoute(app: App, { req, res }: RouteContext) {
  const input = parseChat(await readJson(req));
  if (typeof input === "string") return send(res, 400, { error: input });
  const models = app.chatModels();
  if (!models.length) return send(res, 503, { error: friendlyError("no_models") });
  if (input.selectedModel !== "auto" && !models.some(m => m.id === input.selectedModel)) return send(res, 400, { error: friendlyError("model_not_configured") });
  const workspaceId = await app.workspace(input.workspace);

  let conversation: { id: string; title: string; updatedAt: Date | string };
  if (input.conversationId) {
    const found = await app.db.conversation.findFirst({ where: { id: input.conversationId, workspaceId }, select: { id: true, title: true, updatedAt: true } });
    if (!found) return send(res, 404, { error: "Conversation not found" });
    conversation = found;
  } else {
    if (input.regenerate) return send(res, 400, { error: "Nothing to regenerate" });
    conversation = await app.conversations.create(workspaceId, titleFrom(input.message!));
  }
  if (app.generating.has(conversation.id)) return send(res, 409, { error: "A response is already being generated in this conversation." });
  app.generating.add(conversation.id);
  try {
    if (input.regenerate) {
      if (!(await app.conversations.dropTrailingAssistants(conversation.id))) return send(res, 400, { error: "Nothing to regenerate" });
    } else {
      await app.conversations.addMessage(conversation.id, { role: "user", content: input.message! });
    }
    const history = await app.conversations.history(conversation.id);
    // Only turns relevant to the latest message reach the model; a new topic starts clean.
    const decision = selectContext(history.map(m => ({ role: m.role, content: m.content })));
    const continuing = decision.mode === "continue";
    const previousTaskKind = continuing ? history.findLast(m => m.role === "assistant" && m.meta)?.meta?.taskKind : undefined;
    const reply = await app.conversations.addMessage(conversation.id, { role: "assistant", content: "" });
    const stream = ndjson(res);
    stream.write({ type: "conversation", conversation: { id: conversation.id, title: conversation.title, updatedAt: new Date().toISOString() }, messageId: reply.id });

    const question = history.findLast(m => m.role === "user")!.content;
    // Links the user wrote may be repeated back; any other link must belong to a retrieved source.
    const userUrls = history.filter(m => m.role === "user").flatMap(m => urls(m.content));
    const modelHistory: Message[] = decision.messages.map(m => ({ role: m.role, content: m.content }));
    // Research stages shown with the answer, plus notices (stage "notice") the user should still see after a reload.
    const steps: (ResearchStatus | { stage: "notice"; label: string })[] = [];
    const notice = (message: string) => { steps.push({ stage: "notice", label: message }); stream.write({ type: "notice", message }); };
    const status = (s: ResearchStatus) => {
      const i = steps.findIndex(x => x.stage === s.stage);
      if (i >= 0) steps[i] = s; else steps.push(s);
      stream.write({ type: "status", ...s });
    };
    const context = { conversationId: conversation.id, workspaceId };
    let grounding: string | undefined;
    let ordinals = new Map<number, string>();
    let sourceUrls: string[] = [];

    /** Searches and grounds the latest turn in the results. Returns false if the client went away. */
    const runSearch = async (intent: SearchIntent): Promise<boolean> => {
      try {
        status({ stage: "searching", label: "Searching", detail: "Choosing search queries" });
        const plan = await planQueries({
          question: decision.searchText, previous: continuing ? decision.previousUser : undefined, max: input.reasoningLevel === "fast" ? 1 : input.reasoningLevel === "deep" ? 3 : 2,
          candidates: plannerCandidates(app, models, input), providers: app.providerMap, signal: stream.signal
        });
        if (plan.model) await app.recordUsage({ provider: plan.model.provider, model: plan.model.modelId, registryId: plan.model.id, task: "search", role: "query-planner", status: "complete", ...plan.usage, ...context });
        const gathered = await gatherEvidence({ providers: app.searchProviders }, { question: decision.searchText, queries: plan.queries, focus: intent, depth: input.reasoningLevel, signal: stream.signal, onStatus: status });
        for (const message of gathered.notices) notice(message);
        ordinals = await app.sources.attachToMessage(workspaceId, reply.id, gathered.evidence);
        sourceUrls = gathered.evidence.flatMap(e => [e.source.url, String(e.source.metadata.finalUrl ?? e.source.url)]);
        const rows = await app.db.source.findMany({ where: { id: { in: [...ordinals.values()] } } });
        const byId = new Map(rows.map(r => [r.id, toSourceView(r)]));
        stream.write({ type: "sources", sources: gathered.evidence.map(e => ({ ordinal: e.ordinal, cited: false, source: byId.get(ordinals.get(e.ordinal)!) })) });
        modelHistory[modelHistory.length - 1] = { role: "user", content: groundedUserPrompt(question, gathered.evidence) };
      } catch (error) {
        if (stream.signal.aborted) return false;
        console.warn("Search failed:", error instanceof Error ? error.message : error);
        notice("Web search failed, so this answer has no sources.");
        modelHistory[modelHistory.length - 1] = { role: "user", content: groundedUserPrompt(question, []) };
      }
      grounding = citationRules;
      status({ stage: "writing", label: "Writing answer" });
      return true;
    };
    const stopped = async () => {
      await app.conversations.finishMessage(reply.id, { content: "", status: "stopped", steps });
      stream.write({ type: "stopped" });
      stream.end();
    };
    /** Streams one model answer to the client; returns the final event and the full text. */
    const answer = async () => {
      let content = "";
      let meta: MessageMeta | undefined;
      for await (const event of streamChat(
        { models, providers: app.providerMap, idleTimeoutMs: app.idleTimeoutMs, log: entry => app.recordUsage(entry) },
        { history: modelHistory, selectedModel: input.selectedModel, reasoningLevel: input.reasoningLevel, previousTaskKind, grounding, contextNote: grounding ? undefined : decision.note, context },
        stream.signal
      )) {
        if (event.type === "model") meta = { modelId: event.model.modelId, registryId: event.model.id, provider: event.model.provider, providerLabel: event.model.providerLabel, displayName: event.model.displayName, reasoningLevel: event.reasoningLevel, taskKind: event.taskKind, fallbackFrom: event.fallbackFrom };
        if (event.type === "delta") content += event.text;
        if (event.type === "done" || event.type === "stopped" || event.type === "error") return { event, content, meta };
        stream.write(event.type === "model" ? { ...event, messageId: reply.id } : event);
      }
      throw new Error("The model stream ended without a result");
    };

    const intent = searchIntent(decision.searchText, input.searchMode);
    if (intent.search && !(await runSearch(intent))) return stopped();
    let result = await answer();
    // An unsearched answer must not claim something doesn't exist or can't be found: check first, then answer again.
    if (!grounding && input.searchMode === "auto" && decision.mode !== "ambiguous" && result.event.type === "done" && claimsUnverifiable(result.content)) {
      stream.write({ type: "reset", reason: "Checking with a web search before answering." });
      notice("Arbor was unsure about this, so it searched before answering.");
      if (!(await runSearch(searchIntent(decision.searchText, "on")))) return stopped();
      result = await answer();
    }

    const { event, content, meta } = result;
    // Citations and links are resolved by the backend: anything not backed by a retrieved source is removed.
    const allowed = new Set(ordinals.keys());
    const cited = sanitizeCitations(content, allowed);
    const linked = sanitizeLinks(cited.text, [...sourceUrls, ...userUrls]);
    if (cited.removed.length) console.warn(`Removed citation markers for unsupplied sources: ${cited.removed.join(", ")}`);
    if (linked.removed.length) console.warn(`Removed ${linked.removed.length} link(s) that were not retrieved sources.`);
    const final = linked.text;
    const statusValue = event.type === "done" ? "complete" : event.type;
    await app.conversations.finishMessage(reply.id, { content: final, status: statusValue, stop: event.type === "done" ? event.stop : undefined, error: event.type === "error" ? event.message : undefined, meta, steps: steps.length ? steps : undefined });
    if (grounding && final) await app.sources.recordCitations(reply.id, ordinals, cited.cited, citationClaims(final, allowed));
    if (event.type === "error") console.warn(`Chat error (${event.code}): ${event.message}`);
    stream.write({ ...event, ...(final !== content ? { content: final } : {}), ...(grounding ? { cited: cited.cited } : {}) });
    stream.end();
  } finally { app.generating.delete(conversation.id); }
}

/** The query planner uses the cheapest suitable model, or the user's chosen model so data stays with that provider. */
function plannerCandidates(app: App, models: ModelDefinition[], input: ChatRequest): ModelDefinition[] {
  if (input.selectedModel !== "auto") return models.filter(m => m.id === input.selectedModel);
  return rankModels(models, { prompt: "", mode: "fast", taskKind: "chat", modelChoice: "auto" }, new Set(models.map(m => m.provider)), "verifier");
}
