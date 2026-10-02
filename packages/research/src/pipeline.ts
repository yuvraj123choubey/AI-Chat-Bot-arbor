import { safeFetch, type FetchedResource } from "./net.ts";
import { extractHtml, extractPlainText, tidy, type ExtractedPage } from "./extract.ts";
import { canonicalUrl, classifySource, domainOf } from "./url.ts";
import { Bm25, queryTerms, selectEvidence, type EvidenceLimits } from "./passages.ts";
import type { EvidenceSource, ResearchStatus, RetrievedSource, SearchProvider, SearchResult } from "./types.ts";
import type { SearchFocus } from "./intent.ts";
import { anchorQueries, anchorsFromResults, anchorsFromSources, fallbackQueries, keyTerms, type Anchor } from "./resolve.ts";
import { wikipediaFullText } from "./providers/wikipedia.ts";

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
export interface GatherResult {
  evidence: EvidenceSource[]; retrieved: RetrievedSource[]; providers: string[]; notices: string[];
  /** For event questions: the specific events identified, best first (more than one means the question is ambiguous). */
  anchors?: Anchor[];
  /** Every query actually searched, including follow-up rounds. */
  queries?: string[];
}
/** Event questions read more sources and many passages from the page that is about the event itself. */
const eventEvidence: EvidenceLimits = { maxSources: 8, perSource: 3, maxPassages: 28, primaryPerSource: 14 };

/**
 * Picks providers by what the question needs: general web (if one is set up) and the encyclopedia always;
 * scholarly works for research questions or when there is no general web search; news for time-sensitive
 * questions; technical Q&A for programming questions.
 */
export function chooseProviders(all: SearchProvider[], focus: SearchFocus): { chosen: SearchProvider[]; notices: string[] } {
  const configured = all.filter(p => p.isConfigured());
  const web = configured.some(p => p.coverage === "web");
  const wanted: Record<SearchProvider["coverage"], boolean> = { official: focus.official, web: true, encyclopedia: true, academic: focus.academic || (!web && !focus.event), news: focus.fresh || Boolean(focus.event), technical: focus.technical };
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
  let searched = 0, failed = 0;
  const failedBy = new Map<string, number>();
  type Query = string | { query: string; recent: boolean };
  const run = async (providers: SearchProvider[], queriesFor: (p: SearchProvider) => Query[]) => {
    const jobs = providers.flatMap(provider => queriesFor(provider).map(q => ({ provider, q })));
    const settled = await Promise.allSettled(jobs.map(({ provider, q }) => typeof q === "string"
      ? provider.search(q, { limit: budget.perProvider, signal: options.signal })
      : provider.search(q.query, { limit: 10, signal: options.signal, recent: q.recent })));
    options.signal?.throwIfAborted();
    searched += settled.length;
    settled.forEach((s, i) => { if (s.status === "rejected") { failed++; failedBy.set(jobs[i].provider.label, (failedBy.get(jobs[i].provider.label) ?? 0) + 1); } });
    return settled.flatMap(s => s.status === "fulfilled" ? s.value : []);
  };
  // Rate-limited news search gets only the first query, so it adds at most one wait.
  // Official-source lookup reads entities from the user's own wording; generated queries can drop the institution.
  const results = await run(chosen, p => p.coverage === "official" ? [options.question] : p.coverage === "news" ? options.queries.slice(0, 1) : options.queries);
  const tried = [...options.queries];
  let anchors: Anchor[] = [];

  if (options.focus.event) {
    // Keep searching until the specific event is identified or the reasonable rephrasings are used up.
    const followUp = chosen.filter(p => p.coverage !== "official" && p.coverage !== "academic" && p.coverage !== "technical");
    anchors = anchorsFromResults(options.question, results);
    // A question naming only one thing ("the flydubai case") may mean any of several events, so one more search
    // looks for the others even when a match was found.
    const onlyOneName = keyTerms(options.question).length === 1;
    for (let round = 0; round < 2 && (!anchors.length || (onlyOneName && round === 0)); round++) {
      const more = fallbackQueries(options.question, tried);
      if (!more.length) break;
      status({ stage: "resolving", label: "Identifying the event", detail: `searching again: ${more.join(" · ")}` });
      tried.push(...more);
      // The encyclopedia is also asked for its newest matches, so a recent event is not buried under older pages.
      results.push(...await run(followUp.filter(p => p.coverage !== "news" || round === 0), p => p.coverage === "news" ? more.slice(0, 1)
        : p.coverage === "encyclopedia" ? [...more.map(q => ({ query: q, recent: false })), { query: more[0], recent: true }] : more));
      anchors = anchorsFromResults(options.question, results);
    }
    if (anchors.length) {
      // Follow the event by its own name: the full article about it, and news coverage of it.
      const byName = anchors.slice(0, 2).flatMap(a => anchorQueries(a, options.question)).filter(q => !tried.some(t => t.toLowerCase() === q.toLowerCase()));
      status({ stage: "resolving", label: "Identified the event", detail: anchors.slice(0, 2).map(a => a.title).join(" · ") });
      if (byName.length) {
        tried.push(...byName);
        // The encyclopedia already returned the event's page while identifying it, so only news and general web
        // search are asked again (keeping requests to rate-limited APIs down).
        results.push(...await run(followUp.filter(p => p.coverage !== "encyclopedia"), p => p.coverage === "news" ? byName.slice(0, 1) : byName));
      }
    }
  }
  if (searched && failed === searched) throw new Error("Every search provider failed. Check the network connection.");
  if (failed) notices.push(`${failed} of ${searched} searches failed (${[...failedBy].map(([label, n]) => `${label} ×${n}`).join(", ")}); results may be incomplete.`);

  const anchorUrls = new Set(anchors.map(a => canonicalUrl(a.url)));
  const ranked = rankCandidates(mergeResults(results, options.exclude), options.question, tried);
  // The pages about the identified event are always read, ahead of everything else.
  const ordered = [...ranked.filter(c => anchorUrls.has(c.canonical)), ...ranked.filter(c => !anchorUrls.has(c.canonical))];
  const candidates = ordered.slice(0, options.focus.event ? Math.max(budget.read, 10) : budget.read);
  status({ stage: "reading", label: "Reading sources", detail: `${candidates.length} sources` });
  const retrieved = await mapLimit(candidates, 4, c => readCandidate(deps, c, options.signal, anchorUrls.has(c.canonical)));
  options.signal?.throwIfAborted();

  status({ stage: "comparing", label: "Comparing evidence", detail: `${retrieved.length} sources read` });
  if (options.focus.event) anchors = mergeAnchors(anchors, anchorsFromSources(options.question, retrieved));
  const primary = new Set(anchors.slice(0, 2).map(a => a.canonicalUrl ?? canonicalUrl(a.url)));
  const limits = options.focus.event ? { ...eventEvidence, primary } : budget.evidence;
  const evidence = selectEvidence(retrieved, options.question, tried, limits);
  return { evidence, retrieved, providers: [...new Set(results.map(r => r.provider))], notices, anchors, queries: tried };
}
/** Adds anchors found among the read sources, keeping only the best-matching ones (newest first among equals). */
function mergeAnchors(a: Anchor[], b: Anchor[]): Anchor[] {
  const out = [...a];
  for (const x of b) if (!out.some(y => y.title.toLowerCase() === x.title.toLowerCase())) out.push(x);
  for (const x of out) x.canonicalUrl ??= b.find(y => y.title.toLowerCase() === x.title.toLowerCase())?.canonicalUrl;
  const best = Math.max(0, ...out.map(x => x.coverage));
  return out.filter(x => x.coverage >= best - 0.001).sort((p, q) => (q.date ?? "").localeCompare(p.date ?? ""));
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
  return candidates.map((c, i) => ({ c, score: (0.6 * c.fusion / maxFusion + 0.4 * lexical[i] / maxLexical) * authority(c.result) }))
    .sort((a, b) => b.score - a.score).map(x => x.c);
}

/** Homework-mirror and answer-farm sites copy primary material without authority; they rank below it. */
export const lowAuthorityHosts = /(^|\.)(coursehero\.com|chegg\.com|studocu\.com|quizlet\.com|scribd\.com|brainly\.com|numerade\.com|bartleby\.com|studypool\.com|gradesaver\.com|ipl\.org|essaypro\.com|ukessays\.com)$/;
/** Ranking weight for primary sources: official pages first, then scholarly and government sources. */
export function authority(result: { sourceType?: string; url: string }): number {
  if (result.sourceType === "official") return 2;
  if (lowAuthorityHosts.test(domainOf(result.url))) return 0.4;
  return result.sourceType === "academic" || result.sourceType === "government" ? 1.15 : 1;
}
async function readCandidate(deps: GatherDeps, candidate: Candidate, signal?: AbortSignal, primary = false): Promise<RetrievedSource> {
  const r = candidate.result;
  // Encyclopedia hits already carry their opening section. Only the page about the identified event is worth its
  // full article, which the API returns as clean text; other pages are not fetched again.
  if (r.provider === "wikipedia" && typeof r.metadata?.pageId === "number") {
    const full = primary ? await wikipediaFullText(r.metadata.pageId, signal, String(r.metadata.host ?? "en.wikipedia.org"), r.url) : undefined;
    const text = tidy(full ?? r.fullText ?? r.snippet);
    return {
      url: r.url, canonicalUrl: candidate.canonical, title: r.title, domain: domainOf(r.url), publisher: r.publisher, publishedAt: r.publishedAt,
      snippet: r.snippet, fullText: text, sourceType: r.sourceType || "encyclopedia", searchQuery: [...candidate.queries][0],
      readMode: "page", metadata: { ...r.metadata, provider: r.provider, queries: [...candidate.queries], article: full ? "full" : "opening" }
    };
  }
  return readOther(deps, candidate, signal);
}
async function readOther(deps: GatherDeps, candidate: Candidate, signal?: AbortSignal): Promise<RetrievedSource> {
  const r = candidate.result;
  const base: RetrievedSource = {
    url: r.url, canonicalUrl: candidate.canonical, title: r.title, domain: domainOf(r.url), author: r.author, publisher: r.publisher, publishedAt: r.publishedAt,
    snippet: r.snippet, fullText: r.fullText ? tidy(r.fullText) : r.snippet, sourceType: r.sourceType || classifySource(r.url), searchQuery: [...candidate.queries][0],
    readMode: r.fullText ? (r.provider === "openalex" ? "abstract" : "page") : "snippet", metadata: { ...r.metadata, provider: r.provider, queries: [...candidate.queries] }
  };
  if (r.fullText && r.fullText.length > 1500) return base;
  if (r.provider === "openalex") return base;
  // Official results were already read and trimmed to the relevant entry (e.g. one course in a catalog).
  if (r.sourceType === "official" && r.fullText) return { ...base, readMode: "page" };
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
