import { tokenize } from "./passages.ts";
import { fallbackQueries, keyTerms } from "./resolve.ts";
import type { EvidenceSource } from "./types.ts";

/**
 * Words a question is phrased with rather than what it is about: verbs (sources use other forms, "find" → "found")
 * and generic qualifiers ("best", "main", "ways"). They say nothing about whether the subject was covered.
 */
const questionVerbs = new Set(tokenize("find found say said make made happen happened use used work works mean means cause caused show shows get got take took give gave know known need needs want called call compare explain describe best good better main top most important common different difference differences way ways type types kind kinds example examples reason reasons step steps thing things exact exactly really actually basically specific specifically whole entire overall general detail details information info stuff"));

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
