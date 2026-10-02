import { safeFetch, type FetchedResource } from "./net.ts";
import { extractHtml, extractPlainText, tidy, type ExtractedPage } from "./extract.ts";
import { canonicalUrl, classifySource, domainOf } from "./url.ts";
import { Bm25, queryTerms, selectEvidence, type EvidenceLimits } from "./passages.ts";
import type { EvidenceSource, ResearchStatus, RetrievedSource, SearchProvider, SearchResult } from "./types.ts";
import type { SearchFocus } from "./intent.ts";

export type Depth = "fast" | "balanced" | "deep";
const budgets: Record<Depth, { perProvider: number; read: number; evidence: EvidenceLimits }> = {
  fast: { perProvider: 5, read: 5, evidence: { maxSources: 4, perSource: 2, maxPassages: 8 } },
  balanced: { perProvider: 6, read: 8, evidence: { maxSources: 6, perSource: 2, maxPassages: 12 } },
  deep: { perProvider: 8, read: 14, evidence: { maxSources: 10, perSource: 3, maxPassages: 24 } }
};

/** Parses fetched bytes into text; PDFs and other formats plug in here. */
export type DocumentReader = (resource: FetchedResource) => Promise<ExtractedPage | undefined>;
export interface GatherDeps {
  providers: SearchProvider[];
  fetch?: (url: string, signal?: AbortSignal) => Promise<FetchedResource>;
  readers?: DocumentReader[];
}
export interface GatherOptions {
  question: string;
  queries: string[];
  focus: SearchFocus;
  depth: Depth;
  signal?: AbortSignal;
  onStatus?: (status: ResearchStatus) => void;
  /** Canonical URLs already used in this research, so iterative searches add new sources. */
  exclude?: Set<string>;
}
export interface GatherResult { evidence: EvidenceSource[]; retrieved: RetrievedSource[]; providers: string[]; notices: string[] }

/**
 * Picks providers by what the question needs: general web (if one is set up) and the encyclopedia always;
 * scholarly works for research questions or when there is no general web search; news for time-sensitive
 * questions; technical Q&A for programming questions.
 */
export function chooseProviders(all: SearchProvider[], focus: SearchFocus): { chosen: SearchProvider[]; notices: string[] } {
  const configured = all.filter(p => p.isConfigured());
  const web = configured.some(p => p.coverage === "web");
  const wanted: Record<SearchProvider["coverage"], boolean> = { web: true, encyclopedia: true, academic: focus.academic || !web, news: focus.fresh, technical: focus.technical };
  const chosen = configured.filter(p => wanted[p.coverage]);
  const notices = web ? [] : ["General web search isn't set up, so results come from free sources (Wikipedia, OpenAlex, news and Q&A archives). Set SEARXNG_URL to a SearXNG instance for full web results."];
  return { chosen, notices };
}

export async function gatherEvidence(deps: GatherDeps, options: GatherOptions): Promise<GatherResult> {
  const budget = budgets[options.depth];
  const { chosen, notices } = chooseProviders(deps.providers, options.focus);
  if (!chosen.length) throw new Error("No search provider is available.");
  const status = options.onStatus || (() => {});

  status({ stage: "searching", label: "Searching", detail: options.queries.join(" · ") });
  // Rate-limited news search gets only the first query, so it adds at most one wait.
  const settled = await Promise.allSettled(chosen.flatMap(provider => (provider.coverage === "news" ? options.queries.slice(0, 1) : options.queries).map(q => provider.search(q, { limit: budget.perProvider, signal: options.signal }))));
  options.signal?.throwIfAborted();
  const results = settled.flatMap(s => s.status === "fulfilled" ? s.value : []);
  const failed = settled.filter(s => s.status === "rejected").length;
  if (failed === settled.length) throw new Error("Every search provider failed. Check the network connection.");
  if (failed) notices.push(`${failed} of ${settled.length} searches failed; results may be incomplete.`);

  const candidates = rankCandidates(mergeResults(results, options.exclude), options.question, options.queries).slice(0, budget.read);
  status({ stage: "reading", label: "Reading sources", detail: `${candidates.length} sources` });
  const retrieved = await mapLimit(candidates, 4, c => readCandidate(deps, c, options.signal));
  options.signal?.throwIfAborted();

  status({ stage: "comparing", label: "Comparing evidence", detail: `${retrieved.length} sources read` });
  const evidence = selectEvidence(retrieved, options.question, options.queries, budget.evidence);
  return { evidence, retrieved, providers: [...new Set(results.map(r => r.provider))], notices };
}

interface Candidate { result: SearchResult; canonical: string; queries: Set<string>; fusion: number }
/** De-duplicates by canonical URL (and DOI) and by identical titles from different hosts of the same work. */
export function mergeResults(results: SearchResult[], exclude?: Set<string>): Candidate[] {
  const byUrl = new Map<string, Candidate>();
  for (const result of results) {
    const doi = typeof result.metadata?.doi === "string" ? result.metadata.doi.replace(/^(https?:\/\/(dx\.)?doi\.org\/|doi:\s*)/i, "").toLowerCase() : undefined;
    const canonical = doi ? `https://doi.org/${doi}` : canonicalUrl(result.url);
    if (exclude?.has(canonical)) continue;
    const fusion = 1 / (60 + result.rank);
    const existing = byUrl.get(canonical);
    if (!existing) { byUrl.set(canonical, { result, canonical, queries: new Set([result.query]), fusion }); continue; }
    existing.fusion += fusion;
    existing.queries.add(result.query);
    if (!existing.result.fullText && result.fullText) existing.result = { ...result, rank: Math.min(result.rank, existing.result.rank) };
  }
  const byTitle = new Map<string, Candidate>();
  for (const candidate of byUrl.values()) {
    const key = candidate.result.title.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
    const existing = key.length > 20 ? byTitle.get(key) : undefined;
    if (existing) { existing.fusion += candidate.fusion; continue; }
    byTitle.set(key.length > 20 ? key : candidate.canonical, candidate);
  }
  return [...byTitle.values()];
}
/** Reciprocal-rank fusion across queries and providers, blended with how well the snippet matches the question. */
export function rankCandidates(candidates: Candidate[], question: string, queries: string[]): Candidate[] {
  if (!candidates.length) return [];
  const bm25 = new Bm25(candidates.map(c => `${c.result.title} ${c.result.snippet}`));
  const terms = queryTerms(question, queries);
  const lexical = candidates.map((_, i) => bm25.score(i, terms));
  const maxLexical = Math.max(...lexical, 1e-9);
  const maxFusion = Math.max(...candidates.map(c => c.fusion));
  return candidates.map((c, i) => ({ c, score: 0.6 * c.fusion / maxFusion + 0.4 * lexical[i] / maxLexical }))
    .sort((a, b) => b.score - a.score).map(x => x.c);
}

async function readCandidate(deps: GatherDeps, candidate: Candidate, signal?: AbortSignal): Promise<RetrievedSource> {
  const r = candidate.result;
  const base: RetrievedSource = {
    url: r.url, canonicalUrl: candidate.canonical, title: r.title, domain: domainOf(r.url), author: r.author, publisher: r.publisher, publishedAt: r.publishedAt,
    snippet: r.snippet, fullText: r.fullText ? tidy(r.fullText) : r.snippet, sourceType: r.sourceType || classifySource(r.url), searchQuery: [...candidate.queries][0],
    readMode: r.fullText ? (r.provider === "openalex" ? "abstract" : "page") : "snippet", metadata: { ...r.metadata, provider: r.provider, queries: [...candidate.queries] }
  };
  if (r.fullText && r.fullText.length > 1500) return base;
  if (r.provider === "openalex") return base;
  try {
    const resource = await (deps.fetch || ((url, s) => safeFetch(url, { signal: s })))(r.url, signal);
    if (resource.status >= 400) return base;
    const page = await readResource(deps, resource);
    if (!page || page.text.length < Math.max(200, base.fullText.length)) return base;
    return {
      // Encyclopedia pages credit "contributors", which is not a citable author.
      ...base, title: base.title || page.title || r.url, author: base.author || (base.sourceType === "encyclopedia" ? undefined : page.author), publisher: base.publisher || page.publisher,
      publishedAt: base.publishedAt || page.publishedAt, fullText: page.text, readMode: "page", metadata: { ...base.metadata, finalUrl: resource.url, pageCanonical: page.canonical }
    };
  } catch {
    return base;
  }
}
async function readResource(deps: GatherDeps, resource: FetchedResource): Promise<ExtractedPage | undefined> {
  for (const reader of deps.readers || []) {
    const page = await reader(resource).catch(() => undefined);
    if (page) return page;
  }
  const type = resource.contentType.toLowerCase();
  if (type.includes("html") || type.includes("xml")) return extractHtml(resource.body.toString("utf8"), resource.url);
  if (type.startsWith("text/")) return extractPlainText(resource.body.toString("utf8"));
  return undefined;
}
async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) { const i = next++; out[i] = await fn(items[i]); }
  }));
  return out;
}
