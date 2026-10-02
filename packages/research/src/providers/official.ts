import { parseHTML } from "linkedom";
import { getJson, safeFetch } from "../net.ts";
import { extractHtml, tidy } from "../extract.ts";
import { courseCodes, organizationName, urls, type CourseCode } from "../entities.ts";
import { domainOf } from "../url.ts";
import type { SearchOptions, SearchProvider, SearchResult } from "../types.ts";

export interface OfficialSite { label: string; description: string; url: string; domain: string; wikidataId: string }
type Fetcher = typeof safeFetch;

const educational = /universit|college|institut|school|polytechnic|academy/i;
const cache = new Map<string, Promise<OfficialSite | undefined>>();

/**
 * Finds an organisation's official website through Wikidata (free API, no key): search the name, then take
 * the "official website" property (P856) of the best match. For course questions only educational bodies count.
 */
export function resolveOfficialSite(name: string, options: { educational?: boolean; signal?: AbortSignal } = {}): Promise<OfficialSite | undefined> {
  const key = `${options.educational ? "edu:" : ""}${name.toLowerCase()}`;
  if (!cache.has(key)) {
    cache.set(key, lookup(name, options).catch(() => { cache.delete(key); return undefined; }));
    if (cache.size > 500) cache.delete(cache.keys().next().value!);
  }
  return cache.get(key)!;
}
async function lookup(name: string, options: { educational?: boolean; signal?: AbortSignal }): Promise<OfficialSite | undefined> {
  const api = "https://www.wikidata.org/w/api.php";
  const names = options.educational && !educational.test(name) ? [`${name} university`, name] : [name];
  for (const query of names) {
    const found = await getJson(`${api}?${new URLSearchParams({ action: "wbsearchentities", search: query, language: "en", uselang: "en", type: "item", limit: "8", format: "json" })}`, {}, options.signal);
    const candidates: any[] = (found.search || []).filter((s: any) => !options.educational || educational.test(`${s.label} ${s.description || ""}`));
    if (!candidates.length) continue;
    const entities = await getJson(`${api}?${new URLSearchParams({ action: "wbgetentities", ids: candidates.map(c => c.id).join("|"), props: "claims", format: "json" })}`, {}, options.signal);
    for (const c of candidates) {
      const website = entities.entities?.[c.id]?.claims?.P856?.find((claim: any) => claim.rank !== "deprecated")?.mainsnak?.datavalue?.value;
      if (typeof website === "string" && /^https?:\/\//.test(website)) return { label: c.label, description: c.description || "", url: website, domain: domainOf(website), wikidataId: c.id };
    }
  }
  return undefined;
}

/** The subject and number as they may appear on a page: "CPRE 4300", "CPR E 4300", "CPRE4300". */
export function courseMatcher(code: CourseCode): RegExp {
  const letters = code.subject.split("").join("\\s?");
  return new RegExp(`\\b${letters}\\s?-?${code.number}\\b`, "i");
}

/**
 * University catalogs mostly run on a few platforms with predictable course-search URLs. Each candidate page is
 * accepted only if it actually contains the course code, so a course is never "found" by assumption.
 */
export function catalogUrls(domain: string, code: CourseCode): string[] {
  const root = domain.replace(/^www\./, "");
  const query = encodeURIComponent(`${code.subject} ${code.number}`);
  return [
    `https://catalog.${root}/search/?P=${query}`,
    `https://bulletin.${root}/search/?P=${query}`,
    `https://catalogue.${root}/search/?P=${query}`,
    `https://${root}/catalog/search/?P=${query}`
  ];
}
/** Pulls the course's own entry out of a catalog page (CourseLeaf "courseblock" markup, else the whole page). */
export function extractCourse(html: string, url: string, code: CourseCode): { title?: string; text: string } | undefined {
  const matcher = courseMatcher(code);
  const { document } = parseHTML(html);
  const blocks = Array.from(document.querySelectorAll(".courseblock, .search-courseresult, .searchresult, .course, .courseblocktitle")).map(b => tidy(b.textContent || "")).filter(t => matcher.test(t));
  if (blocks.length) {
    const text = [...new Set(blocks)].join("\n\n");
    return { title: text.split("\n")[0].slice(0, 200), text };
  }
  const page = extractHtml(html, url);
  return matcher.test(page.text) ? { title: page.title, text: page.text } : undefined;
}

/**
 * Primary sources for named entities: an institution's own course catalog for course codes, the official
 * website of a named organisation, and any URL the user gave. Uses only free, keyless public endpoints.
 */
export class OfficialSourcesSearch implements SearchProvider {
  readonly id = "official";
  readonly label = "Official sources";
  readonly coverage = "official" as const;
  constructor(private readonly fetchPage: Fetcher = safeFetch) {}
  isConfigured() { return process.env.OFFICIAL_SOURCES !== "off"; }

  async search(query: string, { signal }: SearchOptions): Promise<SearchResult[]> {
    const results: SearchResult[] = [];
    for (const url of urls(query).slice(0, 3)) {
      const page = await this.read(url, signal);
      if (page) results.push({ url: page.url, title: page.title || url, snippet: page.text.slice(0, 300), provider: this.id, query, rank: results.length, sourceType: "official", fullText: page.text, metadata: { requestedUrl: url } });
    }
    const courses = courseCodes(query);
    const org = organizationName(query, courses);
    if (!org) return results;
    const site = await resolveOfficialSite(org, { educational: courses.length > 0, signal });
    if (!site) return results;
    for (const code of courses.slice(0, 2)) {
      for (const url of catalogUrls(site.domain, code)) {
        try {
          const resource = await this.fetchPage(url, { signal, timeoutMs: 8000 });
          if (resource.status >= 400 || !resource.contentType.includes("html")) continue;
          const course = extractCourse(resource.body.toString("utf8"), resource.url, code);
          if (!course) continue;
          results.push({
            url: resource.url, title: course.title ? `${course.title} — ${site.label} catalog` : `${code.subject} ${code.number} — ${site.label} catalog`, snippet: course.text.slice(0, 300),
            provider: this.id, query, rank: results.length, sourceType: "official", publisher: site.label, fullText: course.text,
            metadata: { institution: site.label, wikidata: site.wikidataId, course: `${code.subject} ${code.number}`, verified: true }
          });
          break;
        } catch { /* try the next catalog layout */ }
      }
    }
    if (!courses.length) {
      const page = await this.read(site.url, signal);
      results.push({ url: page?.url || site.url, title: page?.title || site.label, snippet: site.description, provider: this.id, query, rank: results.length, sourceType: "official", publisher: site.label, fullText: page ? `${site.label}: ${site.description}\n\n${page.text}` : `${site.label}: ${site.description}`, metadata: { wikidata: site.wikidataId, officialWebsite: site.url } });
    }
    return results;
  }
  private async read(url: string, signal?: AbortSignal) {
    try {
      const resource = await this.fetchPage(url, { signal, timeoutMs: 8000 });
      if (resource.status >= 400 || !/html|text\/plain/.test(resource.contentType)) return undefined;
      return { url: resource.url, ...extractHtml(resource.body.toString("utf8"), resource.url) };
    } catch { return undefined; }
  }
}
