import { Bm25, queryTerms } from "../../research/src/passages.ts";
import { cosine } from "./embed.ts";
import type { Locator } from "./types.ts";

export interface StoredChunk extends Locator { id: string; documentId: string; text: string; embedding: number[] }
export interface RetrievedChunk extends StoredChunk { score: number; similarity: number; keyword: number }

/**
 * Hybrid retrieval over document chunks: keyword relevance (BM25, good for names, codes and exact terms) and
 * meaning (embedding similarity, good for paraphrases) are fused by reciprocal rank. Chunks with neither a
 * keyword match nor a meaningful similarity are never returned, and no document dominates the results.
 */
export function retrieveChunks(query: string, queryVector: number[], chunks: StoredChunk[], options: { k?: number; perDocument?: number; minSimilarity?: number } = {}): RetrievedChunk[] {
  const { k = 8, perDocument = 4, minSimilarity = 0.45 } = options;
  if (!chunks.length) return [];
  const bm25 = new Bm25(chunks.map(c => `${c.section ?? ""}\n${c.text}`));
  const terms = queryTerms(query, []);
  const scored = chunks.map((chunk, i) => ({ ...chunk, keyword: bm25.score(i, terms), similarity: chunk.embedding.length ? cosine(queryVector, chunk.embedding) : 0, score: 0 }));
  const rank = (values: number[]) => {
    const order = values.map((v, i) => [v, i] as const).sort((a, b) => b[0] - a[0]);
    const ranks = new Array<number>(values.length);
    order.forEach(([, i], r) => { ranks[i] = r; });
    return ranks;
  };
  const keywordRank = rank(scored.map(s => s.keyword));
  const meaningRank = rank(scored.map(s => s.similarity));
  for (const [i, s] of scored.entries()) s.score = (s.keyword > 0 ? 1 / (60 + keywordRank[i]) : 0) + (s.similarity >= minSimilarity ? 1 / (60 + meaningRank[i]) : 0);
  const perDoc = new Map<string, number>();
  return scored.filter(s => s.score > 0).sort((a, b) => b.score - a.score).filter(s => {
    const n = perDoc.get(s.documentId) ?? 0;
    perDoc.set(s.documentId, n + 1);
    return n < perDocument;
  }).slice(0, k);
}

/** Short human label for a locator: "page 4", "§ Grading", "lines 10–42". */
export function describeLocator(l: Locator): string {
  return [l.page ? `page ${l.page}` : "", l.section ? `§ ${l.section}` : "", l.lines ? `lines ${l.lines[0]}–${l.lines[1]}` : ""].filter(Boolean).join(", ");
}
