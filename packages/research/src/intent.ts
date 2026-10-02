import { entitySignals } from "./entities.ts";

export type SearchMode = "auto" | "on" | "off";
/** What kind of sources a question needs, which decides the search providers used. */
export interface SearchFocus {
  academic: boolean; fresh: boolean; technical: boolean; official: boolean;
  /** A specific real-world event (incident, case, attack, crash…): resolve it, read deeply, extract details. */
  event?: boolean;
}
/** Words naming a kind of real-world event; one of these makes a question an event lookup, whatever its casing. */
export const eventTerms = /\b(hijack(ed|ing|er|ers)?|crash(ed|es)?|attack(ed|s)?|bomb(ing|ings|ed)?|shoot(ing|ings)|explosion|blast|earthquake|tsunami|flood(ing|s)?|wildfire|fire|storm|hurricane|cyclone|typhoon|accident|incident|collision|derail(ed|ment)|disaster|emergency|diversion|emergency landing|case|scandal|lawsuit|sued|trial|verdict|ruling|indictment|arrest(ed)?|charged|murder(ed)?|killing|assassinat(ed|ion)|kidnap(ped|ping)?|hostage|protest(s)?|riot(s)?|strike|coup|war|invasion|ceasefire|outage|breach|hack(ed)?|leak(ed)?|recall(ed)?|bankruptcy|layoffs?|merger|acquisition|resign(ed|ation)|fired|died|death|election)\b/i;
export interface SearchIntent extends SearchFocus { search: boolean; reason: string }
const technicalTerms = /\b(api|sdk|library|framework|npm|pip|python|javascript|typescript|java|c\+\+|c#|rust|golang|react|vue|angular|node(\.js)?|django|flask|sql|postgres|docker|kubernetes|linux|windows|git|compiler|runtime|exception|error|bug|install|configure|version)\b/i;

const explicit = /\b(search|look ?up|google|browse|find (me )?(sources|articles|papers|studies|evidence|links)|with (sources|citations|references)|cite|citations?|sources?|references?|according to|fact[- ]check)\b/i;
const fresh = /\b(latest|recent(ly)?|current(ly)?|today|tonight|yesterday|this (week|month|year)|news|now|20[2-3]\d|upcoming|released?|announced?|price|stock|weather|score|election)\b/i;
const factual = /^(who|what|when|where|which|how (many|much|did|does|do|is|are|was|were)|is|are|was|were|did|does|has|have|can|why did|list|name|compare|summari[sz]e (the )?(research|evidence|literature))\b/i;
const academicTerms = /\b(paper|papers|study|studies|journal|peer[- ]reviewed|academic|literature( review)?|meta-?analys[ie]s|scholarly|systematic review|clinical trial|research (on|about|into)|empirical|evidence (for|on|that))\b/i;
const notSearch = /```|\b(write|draft|compose|rewrite|rephrase|paraphrase|translate|proofread|poem|story|essay outline|joke|debug|refactor|implement|function|class|regex|sql query|stack trace|error:|prove|derive|solve|integral|equation)\b/i;
const smallTalk = /^(hi|hello|hey|thanks|thank you|ok|okay|cool|great|good (morning|night|evening)|bye|how are you|how's it going|what's up)\b/i;
/** Requests about the user's own tasks ("help me plan my week") need no outside facts. */
const personal = /^(can you |could you |would you |please )?(help me|let's|let us|i want|i need|i'm|i am|i'd like|i would like|remind me|plan my|organi[sz]e my)\b/i;

/**
 * Deterministic, cheap decision on whether a message needs web evidence. "on" and "off" are user overrides.
 * "auto" always searches when the message names something checkable — a course code, a URL, an organisation,
 * a person's role, a law, a price — because a model must not guess whether such things exist. It also searches
 * for explicit requests, time-sensitive and factual questions, but not for writing, coding, maths or small talk.
 */
export function searchIntent(message: string, mode: SearchMode): SearchIntent {
  const text = message.trim();
  const entities = entitySignals(text);
  const focus: SearchFocus = {
    academic: academicTerms.test(text), fresh: fresh.test(text), technical: technicalTerms.test(text),
    official: entities.courses.length > 0 || entities.urls.length > 0 || entities.cue || entities.properName,
    event: eventTerms.test(text) && !notSearch.test(text) && text.split(/\s+/).length >= 2
  };
  const decide = (search: boolean, reason: string): SearchIntent => ({ search, reason, ...focus });
  if (mode === "off") return decide(false, "search turned off");
  if (mode === "on") return decide(true, "search turned on");
  if (entities.courses.length || entities.urls.length) return decide(true, "names a specific course or page");
  if (explicit.test(text)) return decide(true, "asked for sources");
  if (smallTalk.test(text) && text.length < 40) return decide(false, "small talk");
  if (notSearch.test(text)) return decide(false, "writing, coding or maths");
  if (personal.test(text) && !entities.cue && !entities.properName) return decide(false, "a personal task");
  if (focus.event) return decide(true, "asks about a specific event");
  if ((entities.cue || entities.properName) && text.split(/\s+/).length >= 2) return decide(true, "mentions a specific organisation, person or fact");
  if (/^(tell me|what do you know|give me (info|information|details)|explain what happened|what happened)\b/i.test(text) && text.split(/\s+/).length >= 4) return decide(true, "asks about a specific subject");
  if (focus.fresh) return decide(true, "time-sensitive");
  if (focus.academic) return decide(true, "asks about research");
  if (factual.test(text) && text.split(/\s+/).length >= 4) return decide(true, "factual question");
  return decide(false, "conversational");
}

/**
 * Phrases that, in an answer written without search, assert that something does not exist or could not be
 * found — exactly the claims a model cannot make from memory. Such an answer is checked with a search first.
 */
const unverifiable = /\b(not (a )?(recogni[sz]ed|real|valid|known)|(does not|doesn't|did not|didn't|do not|don't) (seem to )?(exist|appear to exist)|no (such|record of|information (about|on))|(could ?n[o']t|cannot|can't|was unable to|am unable to|unable to) (find|locate|verify|confirm)|i('m| am) not (aware of|familiar with|sure (whether|if|that))|not aware of any|as of my (last|knowledge)|(likely|possibly|perhaps) (referring|meant|a typo|confus)|might be referring|you may (mean|be thinking)|did you mean|alternatives? (such as|like|include)|(likely|possible) alternatives)\b/i;
export function claimsUnverifiable(answer: string): boolean {
  return unverifiable.test(answer);
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
