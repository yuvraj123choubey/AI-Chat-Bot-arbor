import { getJson } from "../net.ts";
import { classifySource } from "../url.ts";
import { normaliseDate } from "../extract.ts";
import type { SearchOptions, SearchProvider, SearchResult } from "../types.ts";

/**
 * General web search through a SearXNG instance (free, open-source, self-hostable metasearch).
 * Set SEARXNG_URL to an instance with the JSON format enabled, e.g. http://127.0.0.1:8888.
 */
export class SearxngSearch implements SearchProvider {
  readonly id = "searxng";
  readonly label = "SearXNG";
  readonly coverage = "web" as const;
  constructor(private readonly baseUrl = process.env.SEARXNG_URL) {}
  isConfigured() { return Boolean(this.baseUrl); }
  async search(query: string, { limit, signal }: SearchOptions): Promise<SearchResult[]> {
    const url = new URL("/search", this.baseUrl);
    url.searchParams.set("q", query.slice(0, 400));
    url.searchParams.set("format", "json");
    url.searchParams.set("language", "en");
    const data = await getJson(url, {}, signal);
    return (data.results || []).filter((r: any) => /^https?:\/\//.test(r.url)).slice(0, limit).map((r: any, rank: number): SearchResult => ({
      url: r.url, title: r.title || r.url, snippet: r.content || "", provider: this.id, query, rank, sourceType: classifySource(r.url),
      publishedAt: normaliseDate(r.publishedDate), metadata: { engines: r.engines }
    }));
  }
}
