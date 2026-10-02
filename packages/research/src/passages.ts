import type { EvidenceSource, Passage, RetrievedSource, SourceType } from "./types.ts";

const stopwords = new Set("a an and are as at be been but by can could did do does for from had has have how i if in into is it its may might more most my no not of on or our should so some such than that the their them then there these they this those to was we were what when where which while who whom why will with would you your about after also any before between both each few other over same very".split(" "));

export function tokenize(text: string): string[] {
  return (text.toLowerCase().normalize("NFKD").match(/[\p{L}\p{N}]+/gu) || [])
    .filter(t => t.length > 1 && !stopwords.has(t))
    .map(stem);
}
/** Light suffix stripping so "attacks", "attacked" and "attacking" match "attack". */
function stem(t: string): string {
  if (t.length > 5 && t.endsWith("ies")) return `${t.slice(0, -3)}y`;
  for (const suffix of ["ing", "edly", "ed", "es", "ly", "s"]) if (t.length > suffix.length + 3 && t.endsWith(suffix)) return t.slice(0, -suffix.length);
  return t;
}

/** Splits text into passages of about `target` characters, breaking at paragraphs, then sentences, then hard limits. */
export function splitPassages(text: string, target = 700, max = 1200): { text: string; start: number }[] {
  const units: { text: string; start: number }[] = [];
  for (const para of text.matchAll(/[^\n]+/g)) {
    if (!para[0].trim()) continue;
    if (para[0].length <= max) { units.push({ text: para[0].trim(), start: para.index! }); continue; }
    for (const sentence of para[0].matchAll(/[^.!?]+(?:[.!?]+["')\]]*|$)\s*/g)) {
      for (let i = 0; i < sentence[0].length; i += max) {
        const piece = sentence[0].slice(i, i + max).trim();
        if (piece) units.push({ text: piece, start: para.index! + sentence.index! + i });
      }
    }
  }
  const out: { text: string; start: number }[] = [];
  let current: { text: string; start: number } | undefined;
  for (const unit of units) {
    if (current && current.text.length < target && current.text.length + unit.text.length + 1 <= max) current.text += `\n${unit.text}`;
    else { if (current) out.push(current); current = { ...unit }; }
  }
  if (current) out.push(current);
  return out;
}

/** Okapi BM25 over a small in-memory corpus. */
export class Bm25 {
  private readonly docs: string[][];
  private readonly df = new Map<string, number>();
  private readonly avgLength: number;
  constructor(texts: string[], private readonly k1 = 1.4, private readonly b = 0.75) {
    this.docs = texts.map(tokenize);
    for (const doc of this.docs) for (const term of new Set(doc)) this.df.set(term, (this.df.get(term) || 0) + 1);
    this.avgLength = this.docs.reduce((n, d) => n + d.length, 0) / Math.max(1, this.docs.length);
  }
  score(index: number, query: Map<string, number>): number {
    const doc = this.docs[index];
    if (!doc.length) return 0;
    const tf = new Map<string, number>();
    for (const term of doc) tf.set(term, (tf.get(term) || 0) + 1);
    let total = 0;
    for (const [term, weight] of query) {
      const f = tf.get(term);
      if (!f) continue;
      const n = this.df.get(term) || 0;
      const idf = Math.log(1 + (this.docs.length - n + 0.5) / (n + 0.5));
      total += weight * idf * (f * (this.k1 + 1)) / (f + this.k1 * (1 - this.b + this.b * doc.length / this.avgLength));
    }
    return total;
  }
}
/** Question terms count fully; terms that only appear in generated queries count half. */
export function queryTerms(question: string, queries: string[]): Map<string, number> {
  const terms = new Map<string, number>();
  for (const t of tokenize(question)) terms.set(t, 1);
  for (const q of queries) for (const t of tokenize(q)) if (!terms.has(t)) terms.set(t, 0.5);
  return terms;
}

const typePrior: Partial<Record<SourceType, number>> = { academic: 1.12, government: 1.1, documentation: 1.08, encyclopedia: 1.03, news: 1.02, forum: 0.92 };
export interface EvidenceLimits { maxSources: number; perSource: number; maxPassages: number }

/**
 * Chooses which sources and passages the model may see. Each source keeps its best passages; sources are
 * ranked by their best passage (with a mild preference for scholarly, official and documentation sources and a
 * penalty for repeating a domain); sources with no relevant passage are dropped rather than padded in.
 */
export function selectEvidence(sources: RetrievedSource[], question: string, queries: string[], limits: EvidenceLimits): EvidenceSource[] {
  const all: { source: number; text: string; start: number }[] = [];
  sources.forEach((source, i) => {
    const text = source.fullText || source.snippet;
    for (const p of splitPassages(text)) all.push({ source: i, ...p });
  });
  if (!all.length) return [];
  const bm25 = new Bm25(all.map(p => `${sources[p.source].title}\n${p.text}`));
  const terms = queryTerms(question, queries);
  const scored = all.map((p, i) => ({ ...p, score: bm25.score(i, terms) }));
  const perSource = new Map<number, Passage[]>();
  for (const p of scored.sort((a, b) => b.score - a.score)) {
    if (p.score <= 0) break;
    const list = perSource.get(p.source) || [];
    if (list.length < limits.perSource) { list.push({ text: p.text, start: p.start, score: p.score }); perSource.set(p.source, list); }
  }
  const domains = new Map<string, number>();
  const ranked = [...perSource.entries()]
    .map(([i, passages]) => ({ i, passages, score: passages[0].score * (typePrior[sources[i].sourceType] ?? 1) }))
    .sort((a, b) => b.score - a.score)
    .map(entry => {
      const seen = domains.get(sources[entry.i].domain) || 0;
      domains.set(sources[entry.i].domain, seen + 1);
      return { ...entry, score: entry.score * Math.pow(0.8, seen) };
    })
    .sort((a, b) => b.score - a.score)
    .slice(0, limits.maxSources);
  let budget = limits.maxPassages;
  const chosen: EvidenceSource[] = [];
  for (const entry of ranked) {
    if (budget <= 0) break;
    const passages = entry.passages.slice(0, budget).sort((a, b) => a.start - b.start);
    budget -= passages.length;
    chosen.push({ ordinal: chosen.length + 1, source: sources[entry.i], passages });
  }
  return chosen;
}
