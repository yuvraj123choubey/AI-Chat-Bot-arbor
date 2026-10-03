import { generateText } from "../../../packages/ai/src/structured.ts";
import type { ModelDefinition } from "../../../packages/ai/src/types.ts";
import { buildStudySheet, STUDY_VERSION, type Generate, type SheetItem, type StudyDoc, type StudySheet } from "../../../packages/study/src/index.ts";
import type { App } from "./app.ts";

/** The user's documents as the study engine reads them: every passage, in reading order, with its place. */
export async function loadStudyDocs(app: App, workspaceId: string, ids: string[]): Promise<StudyDoc[]> {
  if (!ids.length) return [];
  const docs = await app.db.document.findMany({
    where: { id: { in: ids }, workspaceId, status: "ready" },
    select: { id: true, name: true, displayName: true, mimeType: true, chunks: { orderBy: { ordinal: "asc" }, select: { id: true, ordinal: true, text: true, page: true, section: true, lineStart: true, lineEnd: true, embedding: true } } }
  });
  const order = new Map(ids.map((id, i) => [id, i]));
  return docs.sort((a, b) => order.get(a.id)! - order.get(b.id)!).map(d => ({
    id: d.id, name: d.displayName || d.name, mimeType: d.mimeType, image: d.mimeType.startsWith("image/"),
    chunks: d.chunks.map(c => ({ id: c.id, documentId: d.id, ordinal: c.ordinal, text: c.text, page: c.page ?? undefined, section: c.section ?? undefined, lines: c.lineStart && c.lineEnd ? [c.lineStart, c.lineEnd] as [number, number] : undefined, embedding: c.embedding }))
  }));
}

/** A model call for study steps (reading windows, judging requirements), recorded like every other call. */
export function studyGenerate(app: App, candidates: ModelDefinition[], context: { conversationId?: string; workspaceId: string }, signal?: AbortSignal, role = "study"): Generate {
  return async (messages, options) => (await generateText({
    candidates, providers: app.providerMap, signal, messages, maxOutputTokens: options?.maxTokens ?? 1200, timeoutMs: 240_000, temperature: 0.1,
    onCall: call => app.recordUsage({ provider: call.model.provider, model: call.model.modelId, registryId: call.model.id, task: "study", role, status: call.ok ? "complete" : "failed", ...call.usage, ...context })
  })).text;
}

/**
 * The study sheet of a document: read from the cache when it was built by the current study version, else built by
 * reading the whole document (window by window) and stored for every later question.
 */
export async function studySheetFor(app: App, doc: StudyDoc, generate: Generate, onProgress?: (done: number, total: number) => void): Promise<StudySheet> {
  const cached = await cachedStudySheet(app, doc.id);
  if (cached) return cached;
  const sheet = await buildStudySheet(doc, generate, onProgress);
  const data = { version: sheet.version, items: sheet.items as never, windows: sheet.windows, rejected: sheet.rejected };
  await app.db.documentStudy.upsert({ where: { documentId: doc.id }, create: { documentId: doc.id, ...data }, update: { ...data, createdAt: new Date() } });
  return sheet;
}

/** A document's study sheet if one was already built by the current version (never builds one). */
export async function cachedStudySheet(app: App, documentId: string): Promise<StudySheet | undefined> {
  const cached = await app.db.documentStudy.findUnique({ where: { documentId } });
  return cached && cached.version === STUDY_VERSION ? { version: cached.version, documentId, items: cached.items as unknown as SheetItem[], windows: cached.windows, rejected: cached.rejected } : undefined;
}

/** How many characters of document text fit in a model's context, leaving room for instructions and the answer. */
export function studyBudget(models: ModelDefinition[]): number {
  const windows = models.map(m => m.contextWindow || 32_768);
  const tokens = Math.min(...windows, 128_000);
  return Math.max(8_000, Math.min(150_000, Math.floor((tokens - 6_000) * 3)));
}
