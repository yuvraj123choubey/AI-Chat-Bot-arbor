import { getJson } from "../net.ts";
import type { SearchOptions, SearchProvider, SearchResult } from "../types.ts";

/** English Wikipedia through the MediaWiki API (no key). Article text comes from the API, not by scraping. */
export class WikipediaSearch implements SearchProvider {
  readonly id = "wikipedia";
  readonly label = "Wikipedia";
  readonly coverage = "encyclopedia" as const;
  constructor(private readonly host = "en.wikipedia.org") {}
  isConfigured() { return true; }
  async search(query: string, { limit, signal }: SearchOptions): Promise<SearchResult[]> {
    const api = `https://${this.host}/w/api.php`;
    const found = await getJson(`${api}?${new URLSearchParams({ action: "query", list: "search", srsearch: query.slice(0, 300), srlimit: String(Math.min(limit, 10)), srprop: "snippet|timestamp", format: "json", formatversion: "2" })}`, {}, signal);
    const hits: any[] = found.query?.search || [];
    if (!hits.length) return [];
    // One request returns plain-text extracts for every hit (exlimit allows up to 20 intro-length extracts).
    const pages = await getJson(`${api}?${new URLSearchParams({ action: "query", prop: "extracts|info", explaintext: "1", exsectionformat: "plain", exintro: "0", exlimit: "1", inprop: "url", pageids: String(hits[0].pageid), format: "json", formatversion: "2" })}`, {}, signal).catch(() => undefined);
    const fullFirst = pages?.query?.pages?.[0];
    const intros = await getJson(`${api}?${new URLSearchParams({ action: "query", prop: "extracts|info", explaintext: "1", exintro: "1", exlimit: "20", inprop: "url", pageids: hits.map(h => h.pageid).join("|"), format: "json", formatversion: "2" })}`, {}, signal).catch(() => undefined);
    const byId = new Map<number, any>((intros?.query?.pages || []).map((p: any) => [p.pageid, p]));
    return hits.map((hit, rank): SearchResult => {
      const page = hit.pageid === fullFirst?.pageid ? fullFirst : byId.get(hit.pageid);
      const url = page?.fullurl || `https://${this.host}/wiki/${encodeURIComponent(hit.title.replace(/ /g, "_"))}`;
      return {
        url, title: hit.title, snippet: String(hit.snippet || "").replace(/<[^>]+>/g, "").replace(/&quot;/g, '"').replace(/&amp;/g, "&"),
        provider: this.id, query, rank, sourceType: "encyclopedia", publisher: "Wikipedia", publishedAt: page?.touched || hit.timestamp,
        fullText: page?.extract || undefined, metadata: { pageId: hit.pageid, revisionTimestamp: hit.timestamp }
      };
    });
  }
}
