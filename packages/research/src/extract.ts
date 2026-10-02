import { Readability } from "@mozilla/readability";
import { parseHTML } from "linkedom";

export interface ExtractedPage {
  title?: string;
  text: string;
  author?: string;
  publisher?: string;
  publishedAt?: string;
  canonical?: string;
  description?: string;
}

const MAX_TEXT = 60_000;

/** Main-content extraction for a fetched HTML page, with metadata from meta tags and JSON-LD. */
export function extractHtml(html: string, url: string): ExtractedPage {
  const { document } = parseHTML(html);
  const meta = (selector: string) => document.querySelector(selector)?.getAttribute("content")?.trim() || undefined;
  const ld = jsonLd(document);
  const canonicalHref = document.querySelector('link[rel="canonical"]')?.getAttribute("href") || undefined;
  const info = {
    title: meta('meta[property="og:title"]') || document.querySelector("title")?.textContent?.trim() || ld.headline,
    author: meta('meta[name="author"]') || meta('meta[property="article:author"]') || meta('meta[name="citation_author"]') || ld.author,
    publisher: meta('meta[property="og:site_name"]') || meta('meta[name="citation_journal_title"]') || ld.publisher,
    publishedAt: normaliseDate(meta('meta[property="article:published_time"]') || meta('meta[name="citation_publication_date"]') || meta('meta[name="date"]') || meta('meta[name="dc.date"]') || ld.datePublished || document.querySelector("time[datetime]")?.getAttribute("datetime") || undefined),
    canonical: canonicalHref ? safeResolve(canonicalHref, url) : undefined,
    description: meta('meta[name="description"]') || meta('meta[property="og:description"]')
  };
  let text = "";
  try {
    // Readability mutates the document, so it runs after metadata has been read.
    const article = new Readability(document as unknown as Document, { charThreshold: 300 }).parse();
    // Use the cleaned HTML rather than textContent, which runs adjacent blocks together ("TitleFirst paragraph").
    text = article?.content ? tidy(stripTags(article.content)) : "";
    if (!info.author && article?.byline) info.author = article.byline.trim();
    if (!info.title && article?.title) info.title = article.title;
  } catch { /* fall back to stripped text below */ }
  if (text.length < 200) text = tidy(stripTags(html));
  return { ...info, text: text.slice(0, MAX_TEXT) };
}

export function extractPlainText(body: string): ExtractedPage {
  return { text: tidy(body).slice(0, MAX_TEXT) };
}

function jsonLd(document: { querySelectorAll(selector: string): ArrayLike<{ textContent: string | null }> }) {
  const out: { headline?: string; author?: string; publisher?: string; datePublished?: string } = {};
  for (const script of Array.from(document.querySelectorAll('script[type="application/ld+json"]'))) {
    try {
      const data = JSON.parse(script.textContent || "");
      for (const node of [data, ...(Array.isArray(data) ? data : []), ...(Array.isArray(data?.["@graph"]) ? data["@graph"] : [])]) {
        if (!node || typeof node !== "object") continue;
        out.headline ??= typeof node.headline === "string" ? node.headline : undefined;
        out.datePublished ??= typeof node.datePublished === "string" ? node.datePublished : undefined;
        const author = Array.isArray(node.author) ? node.author[0] : node.author;
        out.author ??= typeof author === "string" ? author : typeof author?.name === "string" ? author.name : undefined;
        out.publisher ??= typeof node.publisher?.name === "string" ? node.publisher.name : undefined;
      }
    } catch { /* malformed JSON-LD is common and ignorable */ }
  }
  return out;
}
export function normaliseDate(value?: string): string | undefined {
  if (!value) return undefined;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) || date.getFullYear() < 1800 ? undefined : date.toISOString();
}
function safeResolve(href: string, base: string): string | undefined {
  try { return new URL(href, base).toString(); } catch { return undefined; }
}
function stripTags(html: string): string {
  return html.replace(/<(script|style|noscript|svg|nav|footer|header|aside|form)\b[^>]*>[\s\S]*?<\/\1>/gi, " ")
    .replace(/<(br|p|div|li|h[1-6]|tr)\b[^>]*>/gi, "\n").replace(/<[^>]+>/g, " ")
    .replace(/&#(\d+);/g, (_, n) => safeChar(Number(n))).replace(/&#x([0-9a-f]+);/gi, (_, n) => safeChar(parseInt(n, 16)))
    .replace(/&nbsp;/g, " ").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&mdash;/g, "—").replace(/&ndash;/g, "–").replace(/&hellip;/g, "…").replace(/&rsquo;|&lsquo;/g, "'").replace(/&rdquo;|&ldquo;/g, '"').replace(/&amp;/g, "&");
}
function safeChar(code: number): string {
  return code > 0 && code < 0x110000 ? String.fromCodePoint(code) : " ";
}
/** Collapses whitespace but keeps paragraph breaks, which passage splitting relies on. */
export function tidy(text: string): string {
  return text.replace(/\r/g, "").replace(/[ \t\f\v]+/g, " ").replace(/ *\n */g, "\n").replace(/\n{3,}/g, "\n\n").trim();
}
