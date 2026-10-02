import { getJson } from "../net.ts";
import { classifySource } from "../url.ts";
import { normaliseDate } from "../extract.ts";
import type { SearchOptions, SearchProvider, SearchResult } from "../types.ts";

/** General web search through the Brave Search API (requires BRAVE_SEARCH_API_KEY). */
export class BraveSearch implements SearchProvider {
  readonly id = "brave";
  readonly label = "Brave Search";
  readonly coverage = "web" as const;
  constructor(private readonly key = process.env.BRAVE_SEARCH_API_KEY) {}
  isConfigured() { return Boolean(this.key); }
  async search(query: string, { limit, signal }: SearchOptions): Promise<SearchResult[]> {
    const url = new URL("https://api.search.brave.com/res/v1/web/search");
    url.searchParams.set("q", query.slice(0, 400));
    url.searchParams.set("count", String(Math.min(limit, 20)));
    url.searchParams.set("extra_snippets", "true");
    const data = await getJson(url, { "x-subscription-token": this.key || "" }, signal);
    return (data.web?.results || []).filter((r: any) => /^https?:\/\//.test(r.url)).map((r: any, rank: number): SearchResult => ({
      url: r.url, title: stripMarkup(r.title || r.url), snippet: stripMarkup([r.description, ...(r.extra_snippets || [])].filter(Boolean).join(" … ")),
      provider: this.id, query, rank, sourceType: classifySource(r.url), publisher: r.profile?.name || r.meta_url?.hostname,
      publishedAt: normaliseDate(r.page_age), metadata: { age: r.age }
    }));
  }
}
function stripMarkup(text: string): string {
  return text.replace(/<[^>]+>/g, "").replace(/&#x27;|&#39;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, "&").trim();
}
