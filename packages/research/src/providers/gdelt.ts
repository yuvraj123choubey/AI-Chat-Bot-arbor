import { userAgent } from "../net.ts";
import { classifySource } from "../url.ts";
import { tokenize } from "../passages.ts";
import type { SearchOptions, SearchProvider, SearchResult } from "../types.ts";

const SPACING_MS = 6_500;
let nextAllowed = 0;
/** GDELT asks for at most one request every five seconds, shared across all callers in this process. */
async function throttle(signal?: AbortSignal) {
  const wait = nextAllowed - Date.now();
  nextAllowed = Math.max(Date.now(), nextAllowed) + SPACING_MS;
  if (wait > 0) await sleep(wait, signal);
}
function sleep(ms: number, signal?: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => { clearTimeout(t); reject(signal.reason); }, { once: true });
  });
}
/** GDELT rejects keywords shorter than three letters, so queries are reduced to their meaningful terms. */
export function gdeltQuery(query: string): string {
  const words = query.toLowerCase().normalize("NFKD").match(/[\p{L}\p{N}]+/gu) || [];
  const meaningful = new Set(tokenize(query).length ? words.filter(w => w.length >= 3 && tokenize(w).length) : []);
  for (const filler of ["latest", "recent", "recently", "current", "currently", "today", "news", "year", "this", "week", "month"]) meaningful.delete(filler);
  return [...meaningful].slice(0, 6).join(" ");
}

/**
 * Recent news coverage from the GDELT 2.0 DOC API (free, no key): article links from news sites worldwide,
 * which the pipeline then reads like any web page. Used for time-sensitive questions.
 */
export class GdeltNewsSearch implements SearchProvider {
  readonly id = "gdelt";
  readonly label = "GDELT news";
  readonly coverage = "news" as const;
  isConfigured() { return process.env.GDELT !== "off"; }
  async search(query: string, { limit, signal }: SearchOptions): Promise<SearchResult[]> {
    const terms = gdeltQuery(query);
    if (!terms) return [];
    const url = `https://api.gdeltproject.org/api/v2/doc/doc?${new URLSearchParams({ query: `${terms} sourcelang:english`, mode: "artlist", format: "json", sort: "hybridrel", maxrecords: String(Math.min(limit * 2, 30)), timespan: "3months" })}`;
    let data: any;
    for (let attempt = 0; attempt < 2 && !data; attempt++) {
      await throttle(signal);
      const timeout = AbortSignal.timeout(15_000);
      const response = await fetch(url, { headers: { "user-agent": userAgent() }, signal: signal ? AbortSignal.any([signal, timeout]) : timeout });
      const body = await response.text();
      if (body.trimStart().startsWith("{")) data = JSON.parse(body);
      else if (!/limit requests/i.test(body) || attempt === 1) throw new Error(`GDELT: ${body.trim().split("\n")[0].slice(0, 120)}`);
    }
    const seen = new Set<string>();
    return (data.articles || []).filter((a: any) => /^https?:\/\//.test(a.url) && !seen.has(a.domain) && seen.add(a.domain)).slice(0, limit).map((a: any, rank: number): SearchResult => ({
      url: a.url, title: a.title || a.url, snippet: "", provider: this.id, query, rank, sourceType: classifySource(a.url) === "web" ? "news" : classifySource(a.url),
      publisher: a.domain, publishedAt: parseSeenDate(a.seendate), metadata: { sourceCountry: a.sourcecountry, language: a.language }
    }));
  }
}
/** GDELT dates look like 20260930T141500Z. */
function parseSeenDate(value?: string): string | undefined {
  const m = value?.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/);
  return m ? `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}.000Z` : undefined;
}
