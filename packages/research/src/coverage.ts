import { tokenize } from "./passages.ts";
import { fallbackQueries, keyTerms } from "./resolve.ts";
import type { EvidenceSource } from "./types.ts";

/**
 * Words a question is phrased with rather than what it is about: verbs (sources use other forms, "find" → "found")
 * and generic qualifiers ("best", "main", "ways"). They say nothing about whether the subject was covered.
 */
const questionVerbs = new Set(tokenize("find found say said make made happen happened use used work works mean means cause caused show shows get got take took give gave know known need needs want called call compare explain describe best good better main top most important common different difference differences way ways type types kind kinds example examples reason reasons step steps thing things exact exactly really actually basically specific specifically whole entire overall general detail details information info stuff during after before while since until regarding concerning around"));

export interface Coverage { coverage: number; covered: string[]; missing: string[] }

/**
 * How much of the question the gathered evidence speaks to: the share of the question's key terms that appear in
 * some passage. A low share means the first search missed part of the question (a name, a code, a sub-topic).
 */
export function evidenceCoverage(question: string, evidence: EvidenceSource[]): Coverage {
  const terms = keyTerms(question).filter(t => (t.length > 2 || /\d/.test(t)) && !questionVerbs.has(t));
  if (!terms.length) return { coverage: 1, covered: [], missing: [] };
  const seen = new Set(tokenize(evidence.flatMap(e => [e.source.title, ...e.passages.map(p => p.text)]).join(" ")));
  const covered = terms.filter(t => seen.has(t)), missing = terms.filter(t => !seen.has(t));
  return { coverage: covered.length / terms.length, covered, missing };
}

/** Coverage below this, or no evidence at all, triggers one more search aimed at what is missing. */
export const RESEARCH_AGAIN_BELOW = 0.67;

/**
 * Follow-up searches for the parts of a question the first results missed: the missing terms together with the
 * question's strongest covered terms (so the search stays on the same subject), then a plain keyword version of
 * the question. Queries already tried are not repeated.
 */
export function gapQueries(question: string, gap: Coverage, tried: string[]): string[] {
  const seen = new Set(tried.map(q => q.toLowerCase().trim()));
  const words = (question.match(/[\p{L}\p{N}][\p{L}\p{N}'.-]*/gu) || []);
  // Use the user's own spelling of each missing term (tokens are stemmed).
  const original = (term: string) => words.find(w => tokenize(w)[0] === term) ?? term;
  const anchor = [...gap.covered].sort((a, b) => b.length - a.length).slice(0, 2).map(original);
  const focused = [...anchor, ...gap.missing.map(original)].join(" ").trim();
  return [...new Set([focused, ...fallbackQueries(question, tried)])].filter(q => q.split(/\s+/).length >= 2 && !seen.has(q.toLowerCase())).slice(0, 2);
}

/** A note for the model listing what the sources do not mention, so it says so instead of filling the gap. */
export function gapNote(gap: Coverage, question: string): string {
  if (!gap.missing.length) return "";
  const words = (question.match(/[\p{L}\p{N}][\p{L}\p{N}'.-]*/gu) || []);
  const shown = gap.missing.map(t => words.find(w => tokenize(w)[0] === t) ?? t);
  return `Note: none of the sources mention ${shown.map(s => `"${s}"`).join(", ")}. For anything that depends on ${shown.length > 1 ? "these" : "it"}, say you could not verify it in the sources.`;
}

/**
 * For a question about one specific event: whether the thing it names was found at all. When no source matched the
 * event and the question's identifying terms (flight or case numbers, unusual names) appear in none of the sources,
 * the honest answer is that no record was found, not a template filled with "unknown".
 */
export function eventNotFound(gap: Coverage, anchorsFound: number): boolean {
  if (anchorsFound > 0 || !gap.missing.length) return false;
  const numbers = gap.missing.filter(t => /\d{3,}/.test(t));
  return numbers.length > 0 || gap.coverage < 0.5;
}

export function notFoundAnswer(question: string, gap: Coverage, searched: { queries: string[]; sources: number }): string {
  const words = (question.match(/[\p{L}\p{N}][\p{L}\p{N}'.-]*/gu) || []);
  // The identifying terms first (numbers, then the rarest-looking words), at most four.
  const ranked = [...gap.missing].sort((a, b) => Number(/\d{3,}/.test(b)) - Number(/\d{3,}/.test(a)) || b.length - a.length).slice(0, 4);
  const shown = ranked.map(t => words.find(w => tokenize(w)[0] === t) ?? t);
  const queries = searched.queries.slice(0, 3).map(q => `"${q}"`).join(", ");
  return [
    searched.sources
      ? `I couldn't find any record of this. I searched for ${queries} and read ${searched.sources} source${searched.sources === 1 ? "" : "s"}, and none of them mention ${shown.map(s => `"${s}"`).join(", ")}.`
      : `I couldn't find any record of this. I searched for ${queries}, and none of the searches returned a source about it.`,
    "So I can't tell you what happened, and I won't guess. It may not exist, or it may be known by a different name, number or date — if you can check those details, I'll search again."
  ].join("\n\n");
}
