import { BraveSearch } from "./providers/brave.ts";
import { GdeltNewsSearch } from "./providers/gdelt.ts";
import { OpenAlexSearch } from "./providers/openalex.ts";
import { SearxngSearch } from "./providers/searxng.ts";
import { StackExchangeSearch } from "./providers/stackexchange.ts";
import { WikipediaSearch } from "./providers/wikipedia.ts";
import type { SearchProvider } from "./types.ts";

export * from "./types.ts";
export { gatherEvidence, chooseProviders, type Depth, type DocumentReader } from "./pipeline.ts";
export { searchIntent, heuristicQueries, parseQueries, type SearchMode } from "./intent.ts";
export { sanitizeCitations, citationClaims } from "./citations.ts";
export { groundedUserPrompt, citationRules, evidenceBlock } from "./prompt.ts";
export { canonicalUrl, classifySource, domainOf } from "./url.ts";

/**
 * All search providers Arbor knows. Everything except Brave is free; unconfigured providers are skipped,
 * so Arbor searches with free sources out of the box and paid ones only when explicitly set up.
 */
export function searchProviders(): SearchProvider[] {
  return [new SearxngSearch(), new WikipediaSearch(), new OpenAlexSearch(), new GdeltNewsSearch(), new StackExchangeSearch(), new BraveSearch()];
}
