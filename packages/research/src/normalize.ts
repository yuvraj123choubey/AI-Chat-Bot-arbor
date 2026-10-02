import { getJson } from "./net.ts";

export interface Normalized { text: string; corrections: { from: string; to: string }[] }

export function editDistance(a: string, b: string): number {
  if (a === b) return 0;
  const row = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let previous = row[0];
    row[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const saved = row[j];
      row[j] = Math.min(row[j] + 1, row[j - 1] + 1, previous + (a[i - 1] === b[j - 1] ? 0 : 1));
      previous = saved;
    }
  }
  return row[b.length];
}

const words = (text: string): string[] => text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];

/**
 * Applies a search engine's "did you mean" suggestion word by word, and only where it is safe: a misspelled or
 * run-together name ("telaviv", "telaviiv" → "tel aviv"; "fly dubai" → "flydubai") is corrected, but an ordinary
 * short word is never swapped for a similar one ("part" stays "part", not "park"). The user's wording is kept for
 * everything the suggestion does not clearly fix.
 */
export function applySuggestion(original: string, suggestion: string | undefined): Normalized {
  if (!suggestion) return { text: original, corrections: [] };
  const from = words(original);
  const to = words(suggestion);
  const toSet = new Set(to);
  const corrections: { from: string; to: string }[] = [];
  let text = original;
  const close = (a: string, b: string) => editDistance(a, b) <= (a.length >= 8 ? 2 : 1);
  for (let i = 0; i < from.length; i++) {
    const word = from[i];
    if (toSet.has(word)) continue;
    // One word that the suggestion splits into two ("telaviv" → "tel aviv").
    let replacement: string | undefined;
    if (word.length >= 6) {
      for (let j = 0; j < to.length - 1 && !replacement; j++) {
        const pair = `${to[j]} ${to[j + 1]}`;
        if (!from.includes(to[j]) && !from.includes(to[j + 1]) && close(word, pair.replace(" ", ""))) replacement = pair;
      }
      if (!replacement) replacement = to.find(t => !from.includes(t) && t.length >= 6 && close(word, t));
    }
    // Two words that the suggestion joins into one ("fly dubai" → "flydubai").
    if (!replacement && i < from.length - 1) {
      const joined = word + from[i + 1];
      const single = to.find(t => !from.includes(t) && joined.length >= 6 && close(joined, t));
      if (single) {
        text = text.replace(new RegExp(`\\b${word}\\s+${from[i + 1]}\\b`, "i"), single);
        corrections.push({ from: `${word} ${from[i + 1]}`, to: single });
        i++;
        continue;
      }
    }
    if (replacement) {
      text = text.replace(new RegExp(`\\b${word}\\b`, "i"), replacement);
      corrections.push({ from: word, to: replacement });
    }
  }
  return { text, corrections };
}

const cache = new Map<string, Promise<string | undefined>>();
/** Wikipedia's search suggestion for a phrase (free, no key); undefined when it has none or is unreachable. */
export function wikipediaSuggestion(text: string, signal?: AbortSignal): Promise<string | undefined> {
  const key = text.toLowerCase().trim();
  if (!cache.has(key)) {
    const params = new URLSearchParams({ action: "query", list: "search", srsearch: key.slice(0, 300), srlimit: "1", srinfo: "suggestion", srprop: "", format: "json", formatversion: "2" });
    cache.set(key, getJson(`https://en.wikipedia.org/w/api.php?${params}`, {}, signal, 6000).then(d => d.query?.searchinfo?.suggestion as string | undefined, () => { cache.delete(key); return undefined; }));
    if (cache.size > 500) cache.delete(cache.keys().next().value!);
  }
  return cache.get(key)!;
}

const common = new Set("the and for with about tell what when where which who how why from into this that part case news more some have has was were are not but you your our can could would should will".split(" "));
const labelCache = new Map<string, Promise<boolean>>();
/** True when Wikidata has an item whose name is exactly this word ("flydubai"), ignoring case and spaces. */
function isKnownName(word: string, signal?: AbortSignal): Promise<boolean> {
  if (!labelCache.has(word)) {
    const params = new URLSearchParams({ action: "wbsearchentities", search: word, language: "en", type: "item", limit: "5", format: "json" });
    labelCache.set(word, getJson(`https://www.wikidata.org/w/api.php?${params}`, {}, signal, 6000)
      .then(d => (d.search || []).some((s: any) => typeof s.label === "string" && s.label.toLowerCase().replace(/[\s-]+/g, "") === word && s.description), () => { labelCache.delete(word); return false; }));
    if (labelCache.size > 1000) labelCache.delete(labelCache.keys().next().value!);
  }
  return labelCache.get(word)!;
}
/**
 * Joins words that are really one name written apart ("fly dubai" → "flydubai") when Wikidata knows the joined
 * name. Only pairs of ordinary-looking words are tried, a few at most, and checks run in parallel.
 */
export async function joinCompounds(text: string, signal?: AbortSignal): Promise<Normalized> {
  const list = words(text);
  const pairs: [string, string][] = [];
  for (let i = 0; i < list.length - 1; i++) {
    const [a, b] = [list[i], list[i + 1]];
    if (/^\p{L}{2,}$/u.test(a) && /^\p{L}{3,}$/u.test(b) && !common.has(a) && !common.has(b) && a.length + b.length >= 6) pairs.push([a, b]);
  }
  const known = await Promise.all(pairs.slice(0, 5).map(([a, b]) => isKnownName(a + b, signal)));
  let out = text;
  const corrections: { from: string; to: string }[] = [];
  pairs.slice(0, 5).forEach(([a, b], i) => {
    if (!known[i]) return;
    const next = out.replace(new RegExp(`\\b${a}\\s+${b}\\b`, "i"), a + b);
    if (next !== out) { out = next; corrections.push({ from: `${a} ${b}`, to: a + b }); }
  });
  return { text: out, corrections };
}

/** Corrects likely misspellings and split names before searching; never fails (returns the input unchanged). */
export async function normalizeQuestion(text: string, signal?: AbortSignal): Promise<Normalized> {
  try {
    const [spelled, joined] = await Promise.all([wikipediaSuggestion(text, signal).then(s => applySuggestion(text, s)), joinCompounds(text, signal)]);
    // Joined names are applied on top of spelling fixes; both only change words they are sure about.
    let out = spelled.text;
    for (const c of joined.corrections) out = out.replace(new RegExp(`\\b${c.from.replace(" ", "\\s+")}\\b`, "i"), c.to);
    return { text: out, corrections: [...spelled.corrections, ...joined.corrections] };
  } catch { return { text, corrections: [] }; }
}
