import { describeLocator, retrieveChunks, type Locator, type RetrievedChunk } from "../../../packages/files/src/index.ts";
import type { EvidenceSource } from "../../../packages/research/src/types.ts";
import type { App } from "./app.ts";

/** Questions that point at the user's own material ("my notes", "the attached PDF", "according to the syllabus"). */
const refersToFiles = /\b(my|the|this|these|attached|uploaded|our)\s+(own\s+)?(notes?|files?|documents?|docs?|pdfs?|slides?|lectures?|syllabus|syllabi|readings?|handouts?|papers?|essays?|reports?|assignments?|rubrics?|instructions|transcripts?|code|spreadsheets?|uploads?)\b|\b(in|from|according to|based on)\s+(my|the)\s+(file|document|notes|pdf|slides|upload)/i;
export function questionRefersToFiles(question: string): boolean { return refersToFiles.test(question); }

/** A passage this strong is used even when the question does not mention the files explicitly. */
const STRONG_MATCH = 0.72;

export interface FileEvidence { evidence: EvidenceSource[]; locators: Map<number, Locator>; strongest: number }

/**
 * Retrieves the passages of the user's uploaded documents that answer a question, grouped per document and
 * numbered from 1. Each passage is labelled with its page, section or line range so the model can cite it,
 * and each source keeps the locator of its best passage for the citation card.
 */
export async function fileEvidence(app: App, workspaceId: string, question: string, options: { documentIds?: string[]; signal?: AbortSignal } = {}): Promise<FileEvidence> {
  const chunks = await app.documents.chunks(workspaceId, options.documentIds?.length ? options.documentIds : undefined);
  if (!chunks.length) return { evidence: [], locators: new Map(), strongest: 0 };
  options.signal?.throwIfAborted();
  const [vector] = await app.embedder.embed([question], "query");
  const hits = retrieveChunks(question, vector, chunks, { k: 8, perDocument: 4 });
  if (!hits.length) return { evidence: [], locators: new Map(), strongest: 0 };
  const docs = await app.db.document.findMany({ where: { id: { in: [...new Set(hits.map(h => h.documentId))] } }, select: { id: true, name: true, createdAt: true } });
  const byId = new Map(docs.map(d => [d.id, d]));
  const groups = new Map<string, RetrievedChunk[]>();
  for (const hit of hits) groups.set(hit.documentId, [...(groups.get(hit.documentId) ?? []), hit]);
  const evidence: EvidenceSource[] = [];
  const locators = new Map<number, Locator>();
  for (const [documentId, group] of groups) {
    const doc = byId.get(documentId);
    if (!doc) continue;
    const ordinal = evidence.length + 1;
    const best = group[0];
    const locator: Locator = { page: best.page, section: best.section, lines: best.lines };
    locators.set(ordinal, locator);
    // Passages keep document order and carry their location, so the model can say "page 4" accurately.
    const passages = [...group].sort((a, b) => (a.page ?? 0) - (b.page ?? 0) || (a.lines?.[0] ?? 0) - (b.lines?.[0] ?? 0))
      .map(c => ({ text: `(${describeLocator(c) || "excerpt"}) ${c.text}`, start: c.lines?.[0] ?? c.page ?? 0, score: c.score }));
    evidence.push({
      ordinal, passages,
      source: {
        url: `/api/documents/${documentId}/file`, canonicalUrl: `arbor-document:${documentId}`, title: doc.name, domain: "Your files", publisher: "Uploaded file",
        publishedAt: doc.createdAt.toISOString(), snippet: best.text.slice(0, 300), fullText: group.map(c => c.text).join("\n\n"), sourceType: "uploaded_file",
        searchQuery: question.slice(0, 500), readMode: "page", metadata: { documentId, locator }
      }
    });
  }
  return { evidence, locators, strongest: Math.max(...hits.map(h => h.similarity)) };
}

export function strongFileMatch(found: FileEvidence): boolean { return found.strongest >= STRONG_MATCH; }
