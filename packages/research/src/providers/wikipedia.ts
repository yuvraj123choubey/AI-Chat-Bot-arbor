import { getJson, safeFetch } from "../net.ts";
import { extractHtml } from "../extract.ts";
import type { SearchOptions, SearchProvider, SearchResult } from "../types.ts";

/**
 * Full plain-text article for one page. The API returns full text one page per request; if the API is unavailable
 * or rate-limited, the ordinary article page is read instead, so the most important source is never cut short.
 */
export async function wikipediaFullText(pageId: number, signal?: AbortSignal, host = "en.wikipedia.org", url?: string): Promise<string | undefined> {
  const data = await getJson(`https://${host}/w/api.php?${new URLSearchParams({ action: "query", prop: "extracts", explaintext: "1", exsectionformat: "wiki", exlimit: "1", pageids: String(pageId), format: "json", formatversion: "2" })}`, {}, signal).catch(() => undefined);
  const text = data?.query?.pages?.[0]?.extract;
  if (typeof text === "string" && text.length) return text;
  if (!url) return undefined;
  try {
    const page = await safeFetch(url, { signal, timeoutMs: 12_000 });
    if (page.status >= 400 || !page.contentType.includes("html")) return undefined;
    const extracted = extractHtml(page.body.toString("utf8"), page.url).text;
    return extracted.length > 500 ? extracted : undefined;
  } catch { return undefined; }
}

/**
 * English Wikipedia through the MediaWiki API (no key). Each search costs two requests: the search and the opening
 * sections of every hit. Full articles are fetched later, only for the pages that turn out to matter.
 * `recent` orders matches newest-created first, which surfaces articles about recent events.
 */
export class WikipediaSearch implements SearchProvider {
  readonly id = "wikipedia";
  readonly label = "Wikipedia";
  readonly coverage = "encyclopedia" as const;
  constructor(private readonly host = "en.wikipedia.org") {}
  isConfigured() { return true; }
  async search(query: string, { limit, signal, recent }: SearchOptions): Promise<SearchResult[]> {
    const api = `https://${this.host}/w/api.php`;
    const found = await getJson(`${api}?${new URLSearchParams({ action: "query", list: "search", srsearch: query.slice(0, 300), srlimit: String(Math.min(limit, 10)), srprop: "snippet|timestamp", ...(recent ? { srsort: "create_timestamp_desc" } : {}), format: "json", formatversion: "2" })}`, {}, signal);
    const hits: any[] = found.query?.search || [];
    if (!hits.length) return [];
    const intros = await getJson(`${api}?${new URLSearchParams({ action: "query", prop: "extracts|info", explaintext: "1", exintro: "1", exlimit: "20", inprop: "url", pageids: hits.map(h => h.pageid).join("|"), format: "json", formatversion: "2" })}`, {}, signal).catch(() => undefined);
    const byId = new Map<number, any>((intros?.query?.pages || []).map((p: any) => [p.pageid, p]));
    return hits.map((hit, rank): SearchResult => {
      const page = byId.get(hit.pageid);
      const url = page?.fullurl || `https://${this.host}/wiki/${encodeURIComponent(hit.title.replace(/ /g, "_"))}`;
      return {
        url, title: hit.title, snippet: String(hit.snippet || "").replace(/<[^>]+>/g, "").replace(/&quot;/g, '"').replace(/&amp;/g, "&"),
        provider: this.id, query, rank, sourceType: "encyclopedia", publisher: "Wikipedia", publishedAt: page?.touched || hit.timestamp,
        fullText: page?.extract || undefined, metadata: { pageId: hit.pageid, revisionTimestamp: hit.timestamp, host: this.host }
      };
    });
  }
}
