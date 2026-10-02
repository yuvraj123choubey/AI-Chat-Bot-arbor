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
