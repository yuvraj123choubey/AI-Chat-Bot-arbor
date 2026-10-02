import { getJson } from "../net.ts";
import type { SearchOptions, SearchProvider, SearchResult } from "../types.ts";

/**
 * Scholarly works from OpenAlex (open catalogue of ~250M papers; no key needed). Results carry the abstract,
 * authors, venue and date, so they can be cited without fetching publisher pages, which are often paywalled.
 */
export class OpenAlexSearch implements SearchProvider {
  readonly id = "openalex";
  readonly label = "OpenAlex";
  readonly coverage = "academic" as const;
  constructor(private readonly apiKey = process.env.OPENALEX_API_KEY, private readonly mailto = process.env.ARBOR_CONTACT_EMAIL) {}
  isConfigured() { return true; }
  async search(query: string, { limit, signal }: SearchOptions): Promise<SearchResult[]> {
    const url = new URL("https://api.openalex.org/works");
    url.searchParams.set("search", query.slice(0, 300));
    url.searchParams.set("per_page", String(Math.min(limit, 25)));
    // Works without an abstract cannot supply evidence, so they are filtered out at the source.
    url.searchParams.set("filter", "has_abstract:true,is_retracted:false");
    url.searchParams.set("select", "id,doi,display_name,publication_date,authorships,primary_location,abstract_inverted_index,open_access,type,cited_by_count,language");
    if (this.apiKey) url.searchParams.set("api_key", this.apiKey);
    if (this.mailto) url.searchParams.set("mailto", this.mailto);
    const data = await getJson(url, {}, signal);
    return (data.results || []).flatMap((w: any, rank: number): SearchResult[] => {
      const landing = w.doi || w.primary_location?.landing_page_url || w.id;
      const abstract = reconstructAbstract(w.abstract_inverted_index);
      if (!landing || !abstract) return [];
      const authors = (w.authorships || []).map((a: any) => a.author?.display_name).filter(Boolean);
      return [{
        url: landing, title: w.display_name || "Untitled work", snippet: abstract.slice(0, 400), provider: this.id, query, rank, sourceType: "academic",
        author: authors.length > 3 ? `${authors.slice(0, 3).join(", ")} et al.` : authors.join(", ") || undefined,
        publisher: w.primary_location?.source?.display_name || undefined, publishedAt: w.publication_date ? new Date(w.publication_date).toISOString() : undefined,
        fullText: abstract,
        metadata: { openalexId: w.id, doi: w.doi, type: w.type, citedBy: w.cited_by_count, openAccessUrl: w.open_access?.oa_url, language: w.language }
      }];
    });
  }
}
/** OpenAlex stores abstracts as word → positions; rebuild the original word order. */
export function reconstructAbstract(index: Record<string, number[]> | null | undefined): string {
  if (!index) return "";
  const words: string[] = [];
  for (const [word, positions] of Object.entries(index)) for (const p of positions) words[p] = word;
  return words.filter(Boolean).join(" ").trim();
}
