import { BraveSearch } from "./providers/brave.ts";
import { OpenAlexSearch } from "./providers/openalex.ts";
import { WikipediaSearch } from "./providers/wikipedia.ts";
import type { SearchProvider } from "./types.ts";

export * from "./types.ts";
export { gatherEvidence, chooseProviders, type Depth, type DocumentReader } from "./pipeline.ts";
export { searchIntent, heuristicQueries, parseQueries, type SearchMode } from "./intent.ts";
export { sanitizeCitations, citationClaims } from "./citations.ts";
export { groundedUserPrompt, citationRules, evidenceBlock } from "./prompt.ts";
export { canonicalUrl, classifySource, domainOf } from "./url.ts";

/** All search providers Arbor knows; unconfigured ones are skipped at search time. */
export function searchProviders(): SearchProvider[] {
  return [new BraveSearch(), new WikipediaSearch(), new OpenAlexSearch()];
}
