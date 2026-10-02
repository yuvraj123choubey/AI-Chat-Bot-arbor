/**
 * Backend-side citation handling. The model is shown numbered sources; afterwards every [n] marker is checked
 * against the numbers the backend actually supplied, and anything else is removed, so no citation can point
 * at a source that was not retrieved.
 */
const marker = /\[(\d{1,3}(?:\s*[,;–-]\s*\d{1,3})*)\]/g;

export function parseMarker(inner: string): number[] {
  const out: number[] = [];
  for (const part of inner.split(/\s*[,;]\s*/)) {
    const range = part.match(/^(\d+)\s*[–-]\s*(\d+)$/);
    if (range) {
      const [from, to] = [Number(range[1]), Number(range[2])];
      if (to >= from && to - from <= 20) for (let n = from; n <= to; n++) out.push(n);
    } else if (/^\d+$/.test(part)) out.push(Number(part));
  }
  return out;
}

/** Applies `fn` to prose only, leaving fenced and inline code untouched (`arr[0]` is not a citation). */
function outsideCode(text: string, fn: (prose: string) => string): string {
  return text.split(/(```[\s\S]*?(?:```|$)|`[^`\n]*`)/g).map((part, i) => i % 2 ? part : fn(part)).join("");
}

export interface SanitizedAnswer { text: string; cited: number[]; removed: number[] }
export function sanitizeCitations(text: string, allowed: Set<number>): SanitizedAnswer {
  const cited = new Set<number>();
  const removed = new Set<number>();
  const cleaned = outsideCode(text, prose => prose.replace(new RegExp(` ?${marker.source}`, "g"), (whole, inner: string) => {
    const numbers = parseMarker(inner);
    const valid = [...new Set(numbers.filter(n => allowed.has(n)))];
    for (const n of numbers) (allowed.has(n) ? cited : removed).add(n);
    if (!valid.length) return "";
    return `${whole.startsWith(" ") ? " " : ""}${valid.map(n => `[${n}]`).join("")}`;
  }));
  return { text: cleaned, cited: [...cited].sort((a, b) => a - b), removed: [...removed].sort((a, b) => a - b) };
}

/**
 * Links are allowed only to real, retrieved sources or to URLs the user supplied. Any other Markdown link keeps
 * its text without the URL; any other bare URL or "www." address is removed. Code is left untouched.
 */
export function sanitizeLinks(text: string, allowedUrls: Iterable<string>): { text: string; removed: string[] } {
  const allowed = new Set([...allowedUrls].map(normaliseLink));
  const removed: string[] = [];
  const ok = (url: string) => allowed.has(normaliseLink(url));
  const cleaned = outsideCode(text, prose => prose
    .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, (whole, label: string, url: string) => {
      if (ok(url)) return whole;
      removed.push(url);
      return label;
    })
    .replace(/(?<!\]\()(?<![\w/])((?:https?:\/\/|www\.)[^\s<>()[\]"']+[^\s<>()[\]"'.,;:!?])/gi, (url: string) => {
      if (ok(url)) return url;
      removed.push(url);
      return "";
    })
    .replace(/\(\s*\)/g, "").replace(/[ \t]{2,}/g, " ").replace(/ +([.,;:])/g, "$1").replace(/[ \t]+(?=\n)/g, ""));
  return { text: cleaned.replace(/[ \t]+$/, ""), removed };
}
function normaliseLink(url: string): string {
  let value = url.trim();
  try { value = decodeURI(value); } catch { /* keep as written */ }
  return value.toLowerCase().replace(/^https?:\/\//, "").replace(/^www\./, "").replace(/#.*$/, "").replace(/\/+(?=$|\?)/, "");
}

export interface CitationClaim { ordinal: number; claim: string }
/** The sentence each valid marker is attached to, for storing Citation rows. */
export function citationClaims(text: string, allowed: Set<number>): CitationClaim[] {
  const claims: CitationClaim[] = [];
  outsideCode(text, prose => {
    for (const sentence of prose.split(/(?<=[.!?])\s+|\n+/)) {
      const numbers = [...sentence.matchAll(marker)].flatMap(m => parseMarker(m[1])).filter(n => allowed.has(n));
      const claim = sentence.replace(marker, "").replace(/\s+/g, " ").replace(/\s+([.,;:!?])/g, "$1").trim().slice(0, 500);
      if (claim) for (const ordinal of new Set(numbers)) claims.push({ ordinal, claim });
    }
    return prose;
  });
  return claims;
}
