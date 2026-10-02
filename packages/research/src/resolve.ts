import { tokenize } from "./passages.ts";
import { eventTerms } from "./intent.ts";
import type { RetrievedSource, SearchResult } from "./types.ts";

/** Words that carry no identity in an entity or event lookup. */
const filler = new Set(tokenize("tell me about know info information details detail part case story thing what happened happen news latest recent the a an of to from in on at for with and or about please explain give show regarding related"));
/** The distinctive terms of a question, e.g. "hijack part dubai to tel aviv" → hijack, dubai, tel, aviv. */
export function keyTerms(question: string): string[] {
  return [...new Set(tokenize(question).filter(t => !filler.has(t)))];
}

/** Titles of overview pages rather than a specific event or entity. */
const generic = /^(list of|lists of|timeline of|outline of|index of|category:|portal:|history of|\d{4} in )/i;
/** A specific thing usually has a proper name with a number or several capitalised words ("Flydubai Flight 1073"). */
function specificTitle(title: string): boolean {
  return /\d/.test(title) || (title.match(/\b\p{Lu}[\p{L}'-]+/gu) || []).length >= 2;
}

export interface Anchor { title: string; url: string; canonicalUrl?: string; coverage: number; date?: string }

/**
 * Finds pages that are about the specific event or entity asked for: their title and opening text contain most
 * of the question's key terms, and the title names one thing rather than a topic. Ordered best first; several
 * anchors mean the question may refer to more than one event.
 */
/** Event words too vague to identify an event by themselves ("the X case"). */
const weakEventWords = /^(case|incident|story|news|death|died|fired|election|war|fire|storm|strike|leak|recall)$/i;
const months = "january|february|march|april|may|june|july|august|september|october|november|december";
/** The first full date in a text ("On 30 September 2026" / "on September 30, 2026"), as YYYY-MM-DD. */
export function leadDate(text: string): string | undefined {
  const m = text.match(new RegExp(`\\b(\\d{1,2})\\s+(${months})\\s+(\\d{4})\\b|\\b(${months})\\s+(\\d{1,2}),?\\s+(\\d{4})\\b`, "i"));
  if (!m) return undefined;
  const [day, month, year] = m[1] ? [m[1], m[2], m[3]] : [m[5], m[4], m[6]];
  const index = months.split("|").indexOf(month.toLowerCase()) + 1;
  return `${year}-${String(index).padStart(2, "0")}-${day.padStart(2, "0")}`;
}

/**
 * Finds pages about the specific event or entity asked for. A page qualifies when its title and opening paragraph
 * contain most of the question's key terms, its title names one thing rather than a topic, and — for an event
 * question — the opening paragraph itself describes that kind of event. (A page about an airport mentions Dubai and
 * Tel Aviv, but its opening is not about a hijacking.) Best first; several anchors mean the question is ambiguous.
 */
export function findAnchors(question: string, items: { title: string; url: string; canonicalUrl?: string; text: string; publishedAt?: string }[]): Anchor[] {
  const terms = keyTerms(question);
  const noun = eventNoun(question);
  // One name plus an event word ("flydubai case") is enough when the page title is that name *and* more
  // ("Flydubai Flight 1073"); the page about the name itself ("Flydubai") is not an event.
  const single = terms.length === 1 && Boolean(noun);
  if (terms.length < 2 && !single) return [];
  const eventStem = noun && !weakEventWords.test(noun) ? tokenize(noun)[0] : undefined;
  const anchors: Anchor[] = [];
  for (const item of items) {
    if (generic.test(item.title) || !specificTitle(item.title)) continue;
    if (single) {
      const titleTerms = tokenize(item.title);
      if (!titleTerms.includes(terms[0]) || titleTerms.length < 2) continue;
    }
    const lead = item.text.slice(0, 1500);
    const present = new Set(tokenize(`${item.title}\n${lead}`));
    const coverage = terms.filter(t => present.has(t)).length / terms.length;
    // The title must share something with the question, so a page that merely mentions the terms is not taken.
    const titleTerms = new Set(tokenize(item.title));
    const inTitle = terms.some(t => titleTerms.has(t)) || /\b(flight|case|attack|crash|incident|shooting|bombing|hijacking|disaster|affair|scandal)\b/i.test(item.title);
    const describesEvent = !eventStem || present.has(eventStem) || tokenize(lead).some(t => t.startsWith(eventStem));
    if (coverage >= 0.75 && inTitle && describesEvent) anchors.push({ title: item.title, url: item.url, canonicalUrl: item.canonicalUrl, coverage, date: leadDate(lead) });
  }
  // Only matches as good as the best one are alternatives; equally good matches are listed newest first, since
  // "the X case" most often means the latest one.
  const best = Math.max(0, ...anchors.map(a => a.coverage));
  return anchors.filter(a => a.coverage >= best - 0.001).sort((a, b) => (b.date ?? "").localeCompare(a.date ?? ""))
    .filter((a, i, all) => all.findIndex(x => x.title.toLowerCase() === a.title.toLowerCase()) === i);
}
export function anchorsFromResults(question: string, results: SearchResult[]): Anchor[] {
  return findAnchors(question, results.map(r => ({ title: r.title, url: r.url, text: `${r.snippet}\n${r.fullText ?? ""}`, publishedAt: r.publishedAt })));
}
export function anchorsFromSources(question: string, sources: RetrievedSource[]): Anchor[] {
  return findAnchors(question, sources.map(s => ({ title: s.title, url: s.url, canonicalUrl: s.canonicalUrl, text: s.fullText || s.snippet, publishedAt: s.publishedAt })));
}

/** The canonical noun for an event word, which is how sources name such events ("hijack" → "hijacking"). */
export function eventNoun(question: string): string | undefined {
  const m = question.match(eventTerms);
  if (!m) return undefined;
  const w = m[0].toLowerCase();
  if (/^hijack/.test(w)) return "hijacking";
  if (/^crash/.test(w)) return "crash";
  if (/^(bomb)/.test(w)) return "bombing";
  if (/^shoot/.test(w)) return "shooting";
  if (/^kidnap/.test(w)) return "kidnapping";
  if (/^attack/.test(w)) return "attack";
  if (/^arrest/.test(w)) return "arrest";
  if (/^murder/.test(w)) return "murder";
  return w;
}

/**
 * Further searches when the first round did not identify the event: the key terms in a cleaner order with the
 * canonical event noun, and the terms without the event noun (which finds the page about the place or company).
 */
export function fallbackQueries(question: string, tried: string[]): string[] {
  const terms = (question.toLowerCase().match(/[\p{L}\p{N}]+/gu) || []).filter(w => { const t = tokenize(w)[0]; return t && !filler.has(t) && !eventTerms.test(w); });
  const noun = eventNoun(question);
  // A vague event word ("case") is swapped for the words sources actually use for events.
  const nouns = noun && weakEventWords.test(noun) ? ["incident", "accident"] : [noun];
  const candidates = [...nouns.map(n => [...terms, n].filter(Boolean).join(" ")), terms.join(" ")]
    .map(q => q.replace(/\s+/g, " ").trim()).filter(q => q.split(" ").length >= 2);
  const seen = new Set(tried.map(q => q.toLowerCase()));
  return [...new Set(candidates)].filter(q => !seen.has(q.toLowerCase())).slice(0, 2);
}
/** Searches that follow an identified event by its own name, to find full coverage and news reports of it. */
export function anchorQueries(anchor: Anchor, question: string): string[] {
  const noun = eventNoun(question);
  const title = anchor.title.replace(/\s*\(.*?\)\s*/g, " ").trim();
  return [...new Set([title, noun && !title.toLowerCase().includes(noun) ? `${title} ${noun}` : ""].filter(Boolean))];
}
