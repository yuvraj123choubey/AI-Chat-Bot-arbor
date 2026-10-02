import type { SourceType } from "./types.ts";

const trackingParams = /^(utm_\w+|fbclid|gclid|dclid|msclkid|mc_cid|mc_eid|igshid|ref|ref_src|source|cmpid|_hsenc|_hsmi|spm)$/i;

/**
 * Normalised identity of a URL, used to de-duplicate the same document found by different queries or providers:
 * lower-case host without "www.", no fragment or tracking parameters, sorted query, no trailing slash, DOIs unified.
 */
export function canonicalUrl(raw: string): string {
  const doi = extractDoi(raw);
  if (doi) return `https://doi.org/${doi}`;
  let url: URL;
  try { url = new URL(raw); } catch { return raw.trim(); }
  url.hash = "";
  url.hostname = url.hostname.toLowerCase().replace(/^(www|m|mobile)\./, "");
  if ((url.protocol === "https:" && url.port === "443") || (url.protocol === "http:" && url.port === "80")) url.port = "";
  url.protocol = "https:";
  const params = [...url.searchParams.entries()].filter(([k]) => !trackingParams.test(k)).sort(([a], [b]) => a.localeCompare(b));
  url.search = params.length ? `?${new URLSearchParams(params)}` : "";
  url.pathname = url.pathname.replace(/\/{2,}/g, "/").replace(/\/(index\.(html?|php))?$/i, "") || "/";
  return url.toString().replace(/\/$/, "");
}
export function extractDoi(raw: string): string | undefined {
  const match = raw.match(/(?:doi\.org\/|doi:\s*)(10\.\d{4,9}\/[^\s?#]+)/i);
  return match ? decodeURIComponent(match[1]).toLowerCase().replace(/[.)]+$/, "") : undefined;
}
export function domainOf(raw: string): string {
  try { return new URL(raw).hostname.toLowerCase().replace(/^www\./, ""); } catch { return ""; }
}

const academicHosts = /(^|\.)(doi\.org|arxiv\.org|biorxiv\.org|medrxiv\.org|ncbi\.nlm\.nih\.gov|pubmed\.ncbi\.nlm\.nih\.gov|scholar\.google\.com|semanticscholar\.org|openalex\.org|jstor\.org|springer\.com|link\.springer\.com|sciencedirect\.com|wiley\.com|tandfonline\.com|sagepub\.com|nature\.com|science\.org|cell\.com|plos\.org|frontiersin\.org|mdpi\.com|ieee\.org|ieeexplore\.ieee\.org|acm\.org|dl\.acm\.org|researchgate\.net|ssrn\.com|nber\.org|cambridge\.org|oup\.com|academic\.oup\.com|bmj\.com|thelancet\.com|nejm\.org|jamanetwork\.com|usenix\.org)$/;
const governmentHosts = /(\.gov|\.mil|\.gov\.[a-z]{2}|\.gc\.ca|\.gouv\.fr|\.bund\.de|(^|\.)europa\.eu|(^|\.)who\.int|(^|\.)un\.org|(^|\.)oecd\.org|(^|\.)worldbank\.org|(^|\.)nhs\.uk|(^|\.)nist\.gov|(^|\.)cisa\.gov)$/;
const newsHosts = /(^|\.)(reuters\.com|apnews\.com|bbc\.co\.uk|bbc\.com|nytimes\.com|washingtonpost\.com|theguardian\.com|wsj\.com|ft\.com|bloomberg\.com|cnn\.com|npr\.org|aljazeera\.com|economist\.com|theverge\.com|arstechnica\.com|wired\.com|techcrunch\.com|cnbc\.com|axios\.com|politico\.com|latimes\.com|time\.com|forbes\.com|independent\.co\.uk|abc\.net\.au|cbc\.ca|dw\.com|france24\.com|thehindu\.com|bleepingcomputer\.com|therecord\.media|securityweek\.com|zdnet\.com)$/;
const forumHosts = /(^|\.)(reddit\.com|stackoverflow\.com|stackexchange\.com|superuser\.com|serverfault\.com|quora\.com|news\.ycombinator\.com|discourse\.org)$/;

/** Classifies a source from its URL; providers may override (OpenAlex results are always academic). */
export function classifySource(raw: string): SourceType {
  let url: URL;
  try { url = new URL(raw); } catch { return "web"; }
  const host = url.hostname.toLowerCase().replace(/^www\./, "");
  if (/(^|\.)wikipedia\.org$|(^|\.)britannica\.com$/.test(host)) return "encyclopedia";
  if (academicHosts.test(host)) return "academic";
  if (governmentHosts.test(host)) return "government";
  if (/^(docs|developer|developers|learn|api|reference)\./.test(host) || /(^|\.)readthedocs\.io$|developer\.mozilla\.org$|(^|\.)python\.org$/.test(host) || /^\/(docs|documentation|reference|api)(\/|$)/.test(url.pathname)) return "documentation";
  if (newsHosts.test(host)) return "news";
  if (forumHosts.test(host) || (host === "github.com" && /^\/[^/]+\/[^/]+\/(issues|discussions)(\/|$)/.test(url.pathname))) return "forum";
  if (/\.(edu|ac\.[a-z]{2})$/.test(host)) return "academic";
  return "web";
}
