export type SourceType = "web" | "academic" | "government" | "documentation" | "news" | "forum" | "encyclopedia" | "uploaded_file" | "course_material";

/** One hit from a search provider, before the page is read. */
export interface SearchResult {
  url: string;
  title: string;
  snippet: string;
  provider: string;
  query: string;
  /** Position in the provider's result list for this query (0-based). */
  rank: number;
  sourceType?: SourceType;
  author?: string;
  publisher?: string;
  publishedAt?: string;
  /** Text the provider already supplies (an abstract or article body), so the page need not be fetched. */
  fullText?: string;
  metadata?: Record<string, unknown>;
}
export interface SearchOptions { limit: number; signal?: AbortSignal }
export interface SearchProvider {
  readonly id: string;
  readonly label: string;
  /** What this provider covers; the planner picks providers by intent. */
  readonly coverage: "web" | "academic" | "encyclopedia" | "news" | "technical";
  isConfigured(): boolean;
  search(query: string, options: SearchOptions): Promise<SearchResult[]>;
}

/** A source after de-duplication and reading, ready to be stored and cited. */
export interface RetrievedSource {
  url: string;
  canonicalUrl: string;
  title: string;
  domain: string;
  author?: string;
  publisher?: string;
  publishedAt?: string;
  snippet: string;
  fullText: string;
  sourceType: SourceType;
  searchQuery: string;
  /** "page" when the full page was read; "snippet" when only the search snippet or abstract was available. */
  readMode: "page" | "abstract" | "snippet";
  metadata: Record<string, unknown>;
}
export interface Passage { text: string; start: number; score: number }
/** A source numbered for the model, with the passages it is allowed to see. */
export interface EvidenceSource { ordinal: number; source: RetrievedSource; passages: Passage[] }

export type ResearchStage = "searching" | "reading" | "comparing" | "writing";
export interface ResearchStatus { stage: ResearchStage; label: string; detail?: string }
