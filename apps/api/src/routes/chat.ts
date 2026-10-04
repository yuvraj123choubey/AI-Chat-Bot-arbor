import { friendlyError, streamChat } from "../../../../packages/ai/src/chat.ts";
import { selectContext } from "../../../../packages/ai/src/context.ts";
import { rankModels } from "../../../../packages/ai/src/router.ts";
import type { Message, ModelDefinition, ReasoningMode } from "../../../../packages/ai/src/types.ts";
import { citationClaims, citationRules, gatherEvidence, groundedUserPrompt, sanitizeCitations, sanitizeLinks, searchIntent, urls, type ResearchStatus, type SearchMode } from "../../../../packages/research/src/index.ts";
import { claimsUnverifiable, type SearchIntent } from "../../../../packages/research/src/intent.ts";
import { eventNotFound, evidenceCoverage, gapNote, gapQueries, notFoundAnswer, RESEARCH_AGAIN_BELOW } from "../../../../packages/research/src/coverage.ts";
import { planQueries } from "../../../../packages/research/src/queries.ts";
import { extractionMessages, factSheetBlock, parseFacts, sourcesForExtraction, type Fact } from "../../../../packages/research/src/facts.ts";
import { applyVerdicts, claimsToVerify, enforcePrecision, ensureUnidentified, mentionOtherEvents, tidyAnswer, verifyMessages } from "../../../../packages/research/src/precision.ts";
import { eventAnswerRules } from "../../../../packages/research/src/prompt.ts";
import type { EvidenceSource } from "../../../../packages/research/src/types.ts";
import { generateText } from "../../../../packages/ai/src/structured.ts";
import type { App } from "../app.ts";
import { aboutCoursework, assignRoles, finalizeStudyAnswer, gatherMaterial, missingUnitsAnswer, outlineDocument, planStudy, reviewAnswer, reviewSubmission, studyPrompt, studyRules, type StudyDoc, type StudyMaterial, type StudySheet } from "../../../../packages/study/src/index.ts";
import { fileEvidence, questionRefersToFiles, strongFileMatch, type FileEvidence } from "../documents-evidence.ts";
import { cachedStudySheet, loadStudyDocs, studyBudget, studyGenerate, studySheetFor } from "../study.ts";
import { ndjson, readJson, send, type RouteContext } from "../http.ts";
import { isConversationId, titleFrom, type MessageMeta } from "../repos/conversations.ts";
import { toSourceView } from "../repos/sources.ts";

export type SearchScope = "auto" | "web" | "files" | "both";
interface ChatRequest { conversationId?: string; workspace: string; message?: string; regenerate: boolean; selectedModel: string; reasoningLevel: ReasoningMode; searchMode: SearchMode; searchScope: SearchScope; documentIds: string[] }
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
  const searchScope = body.searchScope ?? "auto";
  if (!["auto", "web", "files", "both"].includes(searchScope)) return "Search scope must be auto, web, files or both";
  const documentIds = body.documentIds ?? [];
  if (!Array.isArray(documentIds) || documentIds.length > 20 || documentIds.some((id: unknown) => typeof id !== "string" || !isConversationId(id))) return "documentIds must be a list of up to 20 document ids";
  return { conversationId: body.conversationId, workspace, message: regenerate ? undefined : body.message.trim(), regenerate, selectedModel, reasoningLevel, searchMode, searchScope, documentIds: [...new Set(documentIds as string[])] };
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
  let attachedDocs: { id: string; name: string }[] = [];
  if (input.documentIds.length) {
    const docs = await app.db.document.findMany({ where: { id: { in: input.documentIds }, workspaceId }, select: { id: true, status: true, name: true, displayName: true } });
    if (docs.length !== input.documentIds.length) return send(res, 400, { error: "One of the attached files was not found." });
    const waiting = docs.find(d => d.status !== "ready");
    if (waiting) return send(res, 409, { error: waiting.status === "failed" ? `"${waiting.name}" could not be read, so it can't be used.` : `"${waiting.name}" is still being processed. Try again in a moment.` });
    attachedDocs = input.documentIds.map(id => docs.find(d => d.id === id)!).map(d => ({ id: d.id, name: d.displayName || d.name }));
  }

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
      await app.conversations.addMessage(conversation.id, { role: "user", content: input.message!, ...(attachedDocs.length ? { meta: { attachments: attachedDocs } } : {}) });
      // Files attached to a conversation stay with it, so follow-up questions keep studying them.
      for (const doc of attachedDocs) await app.documents.link(workspaceId, doc.id, "conversation", conversation.id, null);
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
    let evidence: EvidenceSource[] = [];
    let verifiedFacts: Fact[] = [];
    let matchedEvents: { title: string; date?: string }[] = [];
    // Misspelled or run-together names ("telaviv", "fly dubai") are corrected before deciding and searching.
    const normalized = input.searchMode === "off" ? { text: decision.searchText, corrections: [] } : await app.normalize(decision.searchText, stream.signal);
    const searchText = normalized.text;
    let files: FileEvidence = { evidence: [], locators: new Map(), strongest: 0 };
    // Study of the user's documents for this turn: what the question needs, what was read, and (for a completeness
    // check) the requirement-by-requirement answer, which is assembled from verified checks rather than written freely.
    const studyPlan = planStudy(question);
    let material: StudyMaterial | undefined;
    let reviewText: string | undefined;

    /** Stores the numbered sources for this reply and sends them to the client before the answer streams. */
    const announceSources = async (list: EvidenceSource[]) => {
      ordinals = await app.sources.attachToMessage(workspaceId, reply.id, list);
      sourceUrls = list.flatMap(e => [e.source.url, String(e.source.metadata.finalUrl ?? e.source.url)]);
      const rows = await app.db.source.findMany({ where: { id: { in: [...ordinals.values()] } } });
      const byId = new Map(rows.map(r => [r.id, toSourceView(r)]));
      stream.write({ type: "sources", sources: list.map(e => ({ ordinal: e.ordinal, cited: false, source: byId.get(ordinals.get(e.ordinal)!), ...(e.source.metadata.locator ? { locator: e.source.metadata.locator } : {}) })) });
    };
    /** Grounds the answer in the user's files alone (no web search). */
    const groundInFiles = async (): Promise<boolean> => {
      evidence = files.evidence;
      await announceSources(files.evidence);
      modelHistory[modelHistory.length - 1] = { role: "user", content: material ? studyPrompt(question, studyPlan, material) : groundedUserPrompt(question, files.evidence) };
      grounding = [citationRules, material ? studyRules : "", fileRules].filter(Boolean).join(" ");
      status({ stage: "writing", label: "Writing answer" });
      return true;
    };

    /** Searches and grounds the latest turn in the results. Returns false if the client went away. */
    const runSearch = async (intent: SearchIntent): Promise<boolean> => {
      try {
        status({ stage: "searching", label: "Searching", detail: normalized.corrections.length ? `Reading ${normalized.corrections.map(c => `"${c.from}" as "${c.to}"`).join(", ")}` : "Choosing search queries" });
        const plan = await planQueries({
          question: searchText, previous: continuing ? decision.previousUser : undefined, max: input.reasoningLevel === "fast" ? 1 : input.reasoningLevel === "deep" ? 3 : 2,
          candidates: plannerCandidates(app, models, input), providers: app.providerMap, signal: stream.signal
        });
        if (plan.model) await app.recordUsage({ provider: plan.model.provider, model: plan.model.modelId, registryId: plan.model.id, task: "search", role: "query-planner", status: "complete", ...plan.usage, ...context });
        let gathered = await gatherEvidence({ providers: app.searchProviders }, { question: searchText, queries: plan.queries, focus: intent, depth: input.reasoningLevel, signal: stream.signal, onStatus: status });
        // When the results leave part of the question uncovered (a name, a code, a sub-topic), search once more aimed
        // at what is missing; event questions already follow up inside the pipeline.
        let gap = evidenceCoverage(searchText, gathered.evidence);
        if (!intent.event && input.reasoningLevel !== "fast" && (!gathered.evidence.length || gap.coverage < RESEARCH_AGAIN_BELOW)) {
          const more = gapQueries(searchText, gap, gathered.queries ?? plan.queries);
          if (more.length) {
            status({ stage: "searching", label: "Searching again", detail: gap.missing.length ? `The first results didn't cover: ${gap.missing.slice(0, 4).join(", ")}` : "The first results were too thin" });
            try {
              const second = await gatherEvidence({ providers: app.searchProviders }, { question: searchText, queries: more, focus: intent, depth: input.reasoningLevel, signal: stream.signal, onStatus: status, exclude: new Set(gathered.retrieved.map(r => r.canonicalUrl)) });
              const merged = [...gathered.evidence, ...second.evidence].slice(0, input.reasoningLevel === "deep" ? 12 : 8).map((e, i) => ({ ...e, ordinal: i + 1 }));
              gathered = { ...gathered, evidence: merged, retrieved: [...gathered.retrieved, ...second.retrieved], notices: [...new Set([...gathered.notices, ...second.notices])], queries: [...(gathered.queries ?? plan.queries), ...more] };
              gap = evidenceCoverage(searchText, gathered.evidence);
            } catch (error) {
              if (stream.signal.aborted) throw error;
            }
          }
        }
        const gapText = gathered.evidence.length && !intent.event ? gapNote(gap, searchText) : "";
        for (const message of gathered.notices) notice(message);
        // The user's own files come first; web sources are numbered after them, so every [n] is unambiguous.
        const combined = [...files.evidence, ...gathered.evidence.map(e => ({ ...e, ordinal: e.ordinal + files.evidence.length }))];
        evidence = combined;
        if (intent.event) matchedEvents = gathered.anchors ?? [];
        await announceSources(combined);
        // An event that no source mentions was not found: say so plainly instead of writing around the gap.
        if (intent.event && !files.evidence.length && eventNotFound(gap, gathered.anchors?.length ?? 0)) {
          reviewText = notFoundAnswer(question, gap, { queries: gathered.queries ?? plan.queries, sources: gathered.evidence.length });
          grounding = citationRules;
          status({ stage: "writing", label: "Writing answer", detail: "No source mentions this event" });
          return true;
        }
        // For a specific event, the concrete details are extracted and each one checked against its source first.
        let sheet = "";
        if (intent.event && combined.length) {
          status({ stage: "extracting", label: "Extracting details", detail: gathered.anchors?.length ? gathered.anchors.slice(0, 2).map(a => a.title).join(" · ") : undefined });
          try {
            // Only sources about the identified event feed extraction, so details of other events cannot leak in.
            const about = sourcesForExtraction(combined, gathered.anchors);
            const extracted = await generateText({
              candidates: plannerCandidates(app, models, input), providers: app.providerMap, signal: stream.signal, timeoutMs: 240_000, maxOutputTokens: 1500,
              messages: extractionMessages(question, about, gathered.anchors),
              onCall: call => app.recordUsage({ provider: call.model.provider, model: call.model.modelId, registryId: call.model.id, task: "search", role: "detail-extractor", status: call.ok ? "complete" : "failed", ...call.usage, ...context })
            });
            const facts = parseFacts(extracted.text, about);
            verifiedFacts = facts.facts;
            sheet = factSheetBlock(facts, gathered.anchors);
            if (facts.dropped.length) console.warn(`Dropped ${facts.dropped.length} extracted detail(s) not found in the sources.`);
            status({ stage: "extracting", label: "Extracting details", detail: `${facts.facts.length} details verified${facts.dropped.length ? `, ${facts.dropped.length} unsupported dropped` : ""}` });
          } catch (error) {
            if (stream.signal.aborted) throw error;
            status({ stage: "extracting", label: "Extracting details", detail: "skipped" });
          }
        }
        const asked = gapText ? `${question}\n\n${gapText}` : question;
        modelHistory[modelHistory.length - 1] = { role: "user", content: material && !sheet ? studyPrompt(asked, studyPlan, { ...material, evidence: combined }) : groundedUserPrompt(asked, combined, sheet) };
        grounding = [citationRules, intent.event ? eventAnswerRules : "", material ? studyRules : "", files.evidence.length ? fileRules : ""].filter(Boolean).join(" ");
      } catch (error) {
        if (stream.signal.aborted) return false;
        console.warn("Search failed:", error instanceof Error ? error.message : error);
        if (files.evidence.length) {
          notice("Web search failed, so this answer uses only your files.");
          return groundInFiles();
        }
        notice("Web search failed, so this answer has no sources.");
        modelHistory[modelHistory.length - 1] = { role: "user", content: groundedUserPrompt(question, []) };
        grounding = citationRules;
      }
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
    /** An answer assembled by Arbor from verified checks (not written by a model) goes out like a streamed one. */
    const deterministic = (text: string): Awaited<ReturnType<typeof answer>> => {
      stream.write({ type: "delta", text });
      return { event: { type: "done", usage: { inputTokens: 0, outputTokens: 0 } }, content: text, meta: undefined };
    };

    /**
     * Studies this turn's documents. "Is it complete?" checks every requirement against the submission and builds
     * the answer from those checks. Any other question gathers what it needs: the whole material (with study notes
     * when it is too long to send at once), or the named parts and matching passages. Returns false if stopped.
     */
    const studyFiles = async (docs: StudyDoc[]): Promise<boolean> => {
      if (!docs.length) return true;
      const generate = studyGenerate(app, plannerCandidates(app, models, input), context, stream.signal);
      const sheets = new Map<string, StudySheet>();
      const readSheet = async (doc: StudyDoc) => {
        sheets.set(doc.id, await studySheetFor(app, doc, generate, (done, total) => status({ stage: "reading", label: "Studying your files", detail: `Reading ${doc.name} (part ${done} of ${total})` })));
      };
      status({ stage: "reading", label: "Studying your files", detail: `${docs.map(d => d.name).join(", ")} · ${studyPlan.scope === "review" ? "checking every requirement" : studyPlan.scope === "whole" ? "reading everything" : "finding the relevant parts"}` });
      if (studyPlan.scope === "review") {
        // Instructions without numbered tasks are read in full first, so their requirements can be listed.
        for (const d of assignRoles(docs).docs) if ((d.role === "instructions" || d.role === "rubric") && outlineDocument(d.chunks).filter(s => s.level <= 2).length < 2) await readSheet(d);
        const checked = await reviewSubmission({
          docs, sheets, question, generate, signal: stream.signal, queryVector: async text => (await app.embedder.embed([text], "query"))[0],
          onProgress: (done, total, label) => status({ stage: "verifying", label: "Checking requirements", detail: done < total ? `${label} (${done + 1} of ${total})` : `${total} requirements checked` })
        });
        // Sources: instructions first, then the work, then screenshots, so the citations read naturally.
        const order = [...checked.instructions, ...checked.submissions, ...checked.screenshots].map(d => d.id);
        const ordered = [...docs].sort((a, b) => (order.indexOf(a.id) + 1 || 99) - (order.indexOf(b.id) + 1 || 99));
        const all = gatherMaterial({ question, plan: { scope: "whole", refs: [], reason: "review sources" }, docs: ordered, queryVector: [], budgetChars: 400_000 });
        evidence = all.evidence;
        await announceSources(all.evidence);
        grounding = citationRules;
        const ordinalOf = new Map(all.evidence.map(e => [String(e.source.metadata.documentId), e.ordinal]));
        reviewText = reviewAnswer(checked, id => ordinalOf.get(id));
        return !stream.signal.aborted;
      }
      const budget = studyBudget(input.selectedModel === "auto" ? models : models.filter(m => m.id === input.selectedModel));
      const total = docs.reduce((n, d) => n + d.chunks.reduce((m, c) => m + c.text.length, 0), 0);
      // The whole of a long document is understood through its study notes (built once, then reused).
      if (studyPlan.scope === "whole" && total > budget) { for (const d of docs) await readSheet(d); }
      else for (const d of docs) { const cached = await cachedStudySheet(app, d.id); if (cached) sheets.set(d.id, cached); }
      const [vector] = await app.embedder.embed([searchText], "query");
      material = gatherMaterial({ question: searchText, plan: studyPlan, docs, queryVector: vector, budgetChars: budget, sheets });
      files = { evidence: material.evidence, locators: new Map(), strongest: 1 };
      // Asking only about parts the files don't have is answered directly: it is not there, and here is what is.
      const known = missingUnitsAnswer(studyPlan, material);
      if (known) {
        evidence = material.evidence;
        await announceSources(material.evidence);
        grounding = citationRules;
        reviewText = known;
      }
      const modes = material.reading.map(r => `${r.name}: ${r.mode === "complete" ? "read completely" : r.mode === "sections" ? "relevant sections" : r.mode === "passages" ? "matching passages" : r.mode === "image-text" ? "text in image" : "image not readable"}`);
      status({ stage: "reading", label: "Studying your files", detail: modes.join(" · ") });
      return !stream.signal.aborted;
    };

    // Which of the user's documents this turn is about: the files attached now; files attached earlier in this
    // conversation when the message follows up on them; otherwise library documents the question refers to or that
    // match it very strongly. Scope "files"/"both" always looks, "web" never does.
    const scope = input.searchScope;
    const earlier = scope === "web" ? [] : (await app.documents.linkedIds("conversation", conversation.id)).filter(id => !input.documentIds.includes(id));
    let followsUp = earlier.length > 0 && (continuing || questionRefersToFiles(question) || aboutCoursework(question) || studyPlan.scope !== "lookup" || studyPlan.refs.length > 0);
    // Otherwise a real question that matches the conversation's files closely still uses them; greetings never do.
    if (earlier.length && !followsUp && question.split(/\s+/).length >= 4) {
      try { followsUp = (await fileEvidence(app, workspaceId, searchText, { documentIds: earlier, signal: stream.signal })).strongest >= CONVERSATION_FILE_MATCH; }
      catch { if (stream.signal.aborted) return stopped(); }
    }
    let studyIds = [...input.documentIds, ...(followsUp ? earlier : [])];
    const explicitFiles = studyIds.length > 0 || scope === "files" || scope === "both" || questionRefersToFiles(question);
    if (scope !== "web" && !studyIds.length && (input.searchMode !== "off" || explicitFiles) && await app.documents.readyCount(workspaceId) > 0) {
      if (explicitFiles) status({ stage: "reading", label: "Reading your files", detail: "Your library" });
      try { files = await fileEvidence(app, workspaceId, searchText, { signal: stream.signal }); }
      catch (error) {
        if (stream.signal.aborted) return stopped();
        console.warn("File search failed:", error instanceof Error ? error.message : error);
        if (explicitFiles) notice("Your files couldn't be searched right now.");
      }
      if (explicitFiles || strongFileMatch(files)) studyIds = [...new Set(files.evidence.map(e => String(e.source.metadata.documentId)))].slice(0, 3);
      if (!explicitFiles && studyIds.length) status({ stage: "reading", label: "Reading your files", detail: "A file in your library matches this question" });
      else if (explicitFiles && !studyIds.length) notice("Nothing in your files matched this question.");
      files = { evidence: [], locators: new Map(), strongest: 0 };
    }
    if (scope !== "web" && studyIds.length) {
      try { if (!(await studyFiles(await loadStudyDocs(app, workspaceId, studyIds)))) return stopped(); }
      catch (error) {
        if (stream.signal.aborted) return stopped();
        console.warn("Studying files failed:", error instanceof Error ? error.message : error);
        notice("Your files couldn't be studied right now.");
      }
    }
    const forcedWeb = scope === "web" || scope === "both";
    const intent = searchIntent(searchText, forcedWeb ? "on" : input.searchMode);
    // With files in play, Auto answers from them and only adds the web when search is set to Always or Scope asks for it.
    const useWeb = reviewText !== undefined ? false : scope === "files" ? false : forcedWeb ? true : files.evidence.length ? input.searchMode === "on" : intent.search;
    if (useWeb) { if (!(await runSearch(intent))) return stopped(); }
    else if (files.evidence.length && reviewText === undefined) await groundInFiles();
    let result = reviewText !== undefined ? deterministic(reviewText) : await answer();
    // An unsearched answer must not claim something doesn't exist or can't be found: check first, then answer again.
    if (!grounding && input.searchMode === "auto" && decision.mode !== "ambiguous" && result.event.type === "done" && claimsUnverifiable(result.content)) {
      stream.write({ type: "reset", reason: "Checking with a web search before answering." });
      notice("Arbor was unsure about this, so it searched before answering.");
      if (!(await runSearch(searchIntent(searchText, "on")))) return stopped();
      result = await answer();
    }

    const { event, content, meta } = result;
    // Citations and links are resolved by the backend: anything not backed by a retrieved source is removed,
    // each citation must support the exact detail beside it, and names found in no source are never kept.
    const allowed = new Set(ordinals.keys());
    const first = sanitizeCitations(content, allowed);
    // A completeness review is assembled from checked evidence, so it is not rewritten here.
    const precise = grounding && evidence.length && reviewText === undefined ? enforcePrecision(first.text, evidence, question) : undefined;
    if (precise && (precise.recited || precise.uncited || precise.droppedSentences.length)) console.warn(`Precision check: ${precise.recited} citation(s) moved, ${precise.uncited} removed, ${precise.droppedSentences.length} sentence(s) with unsourced names dropped.`);
    // For an answer about a specific event or from the user's files, claims that word overlap cannot confirm are
    // checked against their source by a model; sentences judged unsupported are removed.
    let checked = precise?.text;
    if (precise && (intent.event || material) && event.type === "done" && !stream.signal.aborted) {
      const claims = claimsToVerify(precise.text, evidence);
      if (claims.length) {
        status({ stage: "verifying", label: "Verifying result", detail: `${claims.length} claims checked against their sources` });
        try {
          const verdicts = await generateText({ candidates: plannerCandidates(app, models, input), providers: app.providerMap, signal: stream.signal, timeoutMs: 180_000, maxOutputTokens: 400, messages: verifyMessages(claims) });
          const applied = applyVerdicts(precise.text, claims, verdicts.text);
          checked = applied.text;
          if (applied.removed.length) console.warn(`Verification removed ${applied.removed.length} unsupported sentence(s).`);
          status({ stage: "verifying", label: "Verifying result", detail: `${claims.length} claims checked · ${applied.removed.length} unsupported removed` });
        } catch {
          status({ stage: "verifying", label: "Verifying result", detail: "verification unavailable" });
        }
      }
    }
    // People the sources mention but do not name are always reported as not identified, never left out.
    const identified = checked !== undefined && verifiedFacts.length ? ensureUnidentified(checked, verifiedFacts) : checked;
    // Final consistency check for study answers: named parts that are not in the files, and images not inspected, are said plainly.
    const studied = material;
    const completed = identified !== undefined && studied ? finalizeStudyAnswer(identified, studied, { question, plan: studyPlan, ordinalOf: id => studied.evidence.find(e => e.source.metadata.documentId === id)?.ordinal }) : identified;
    const cited = completed !== undefined ? sanitizeCitations(mentionOtherEvents(tidyAnswer(completed), matchedEvents, evidence), allowed) : first;
    const linked = sanitizeLinks(cited.text, [...sourceUrls, ...userUrls]);
    if (first.removed.length) console.warn(`Removed citation markers for unsupplied sources: ${first.removed.join(", ")}`);
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

/** How closely a message must match the conversation's own files to keep using them when nothing else says so. */
const CONVERSATION_FILE_MATCH = 0.62;
const fileRules = "Sources from \"Your files\" are the user's own documents: treat them as the authority on their own content, cite them like any other source, and mention the page, section or lines when that helps the user find the passage.";

/** The query planner uses the cheapest suitable model, or the user's chosen model so data stays with that provider. */
function plannerCandidates(app: App, models: ModelDefinition[], input: ChatRequest): ModelDefinition[] {
  if (input.selectedModel !== "auto") return models.filter(m => m.id === input.selectedModel);
  return rankModels(models, { prompt: "", mode: "fast", taskKind: "chat", modelChoice: "auto" }, new Set(models.map(m => m.provider)), "verifier");
}
