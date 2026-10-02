export type SearchMode = "auto" | "on" | "off";
/** What kind of sources a question needs, which decides the search providers used. */
export interface SearchFocus { academic: boolean; fresh: boolean; technical: boolean }
export interface SearchIntent extends SearchFocus { search: boolean; reason: string }
const technicalTerms = /\b(api|sdk|library|framework|npm|pip|python|javascript|typescript|java|c\+\+|c#|rust|golang|react|vue|angular|node(\.js)?|django|flask|sql|postgres|docker|kubernetes|linux|windows|git|compiler|runtime|exception|error|bug|install|configure|version)\b/i;

const explicit = /\b(search|look ?up|google|browse|find (me )?(sources|articles|papers|studies|evidence|links)|with (sources|citations|references)|cite|citations?|sources?|references?|according to|fact[- ]check)\b/i;
const fresh = /\b(latest|recent(ly)?|current(ly)?|today|tonight|yesterday|this (week|month|year)|news|now|20[2-3]\d|upcoming|released?|announced?|price|stock|weather|score|election)\b/i;
const factual = /^(who|what|when|where|which|how (many|much|did|does|do|is|are|was|were)|is|are|was|were|did|does|has|have|can|why did|list|name|compare|summari[sz]e (the )?(research|evidence|literature))\b/i;
const academicTerms = /\b(paper|papers|study|studies|journal|peer[- ]reviewed|academic|literature( review)?|meta-?analys[ie]s|scholarly|systematic review|clinical trial|research (on|about|into)|empirical|evidence (for|on|that))\b/i;
const notSearch = /```|\b(write|draft|compose|rewrite|rephrase|paraphrase|translate|proofread|poem|story|essay outline|joke|debug|refactor|implement|function|class|regex|sql query|stack trace|error:|prove|derive|solve|integral|equation)\b/i;
const smallTalk = /^(hi|hello|hey|thanks|thank you|ok|okay|cool|great|good (morning|night|evening)|bye)\b/i;

/**
 * Deterministic, cheap decision on whether a message needs web evidence. "on" and "off" are user overrides;
 * "auto" searches for explicit requests, time-sensitive questions and factual questions, but not for writing,
 * coding, maths or small talk, which search would only slow down.
 */
export function searchIntent(message: string, mode: SearchMode): SearchIntent {
  const text = message.trim();
  const focus: SearchFocus = { academic: academicTerms.test(text), fresh: fresh.test(text), technical: technicalTerms.test(text) };
  const decide = (search: boolean, reason: string): SearchIntent => ({ search, reason, ...focus });
  if (mode === "off") return decide(false, "search turned off");
  if (mode === "on") return decide(true, "search turned on");
  if (explicit.test(text)) return decide(true, "asked for sources");
  if (smallTalk.test(text) && text.length < 40) return decide(false, "small talk");
  if (notSearch.test(text)) return decide(false, "writing, coding or maths");
  if (focus.fresh) return decide(true, "time-sensitive");
  if (focus.academic) return decide(true, "asks about research");
  if (factual.test(text) && text.split(/\s+/).length >= 4) return decide(true, "factual question");
  return decide(false, "conversational");
}

/** Fallback queries when no model is available to write them: the question without conversational filler. */
export function heuristicQueries(message: string, previous?: string): string[] {
  let stripped = message;
  // Lead-in phrases stack ("can you tell me…"), so strip until none is left.
  for (let previousLength = -1; previousLength !== stripped.length;) {
    previousLength = stripped.length;
    stripped = stripped.replace(/^\s*(please|can you|could you|would you|i want you to|help me|tell me|search( the web)? for|look up|find( me)?|research)\b[\s,:]*/i, "");
  }
  const core = stripped
    .replace(/\b(with|and)\s+(sources|citations|references)\b/gi, "")
    // Search engines match keywords, so the interrogative lead-in ("what are the", "how does a") is dropped.
    .replace(/^((what|how) about|(what|which|who|how|why|when|where)('s|\s+(is|are|was|were|do|does|did|can|could|should|would|has|have))?)\s+((the|a|an)\s+)?/i, "")
    .replace(/[?!.]+$/g, "").replace(/\s+/g, " ").trim();
  // A short follow-up ("what about Europe?") needs the earlier question for context.
  const query = core.split(/\s+/).length < 5 && previous ? `${heuristicQueries(previous)[0]} ${core}` : core;
  return [query.slice(0, 200)].filter(Boolean);
}

export function parseQueries(text: string, max: number): string[] {
  try {
    const data = JSON.parse(text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1));
    const list = Array.isArray(data?.queries) ? data.queries : [];
    return [...new Set(list.filter((q: unknown): q is string => typeof q === "string").map((q: string) => q.trim().slice(0, 200)).filter(Boolean))].slice(0, max) as string[];
  } catch { return []; }
}
