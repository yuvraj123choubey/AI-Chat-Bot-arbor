import { getJson } from "../net.ts";
import { extractPlainText } from "../extract.ts";
import type { SearchOptions, SearchProvider, SearchResult } from "../types.ts";

/**
 * Technical Q&A from Stack Overflow through the free Stack Exchange API (no key; ~300 requests/day per IP).
 * The question and its top-voted answers come from the API, so pages are not scraped.
 */
export class StackExchangeSearch implements SearchProvider {
  readonly id = "stackexchange";
  readonly label = "Stack Overflow";
  readonly coverage = "technical" as const;
  constructor(private readonly site = "stackoverflow", private readonly key = process.env.STACKEXCHANGE_KEY) {}
  isConfigured() { return true; }
  async search(query: string, { limit, signal }: SearchOptions): Promise<SearchResult[]> {
    const params = (extra: Record<string, string>) => new URLSearchParams({ site: this.site, filter: "withbody", ...(this.key ? { key: this.key } : {}), ...extra });
    const found = await getJson(`https://api.stackexchange.com/2.3/search/advanced?${params({ q: query.slice(0, 250), order: "desc", sort: "relevance", answers: "1", pagesize: String(Math.min(limit, 10)) })}`, {}, signal);
    const questions: any[] = found.items || [];
    if (!questions.length) return [];
    const answers = await getJson(`https://api.stackexchange.com/2.3/questions/${questions.map(q => q.question_id).join(";")}/answers?${params({ order: "desc", sort: "votes", pagesize: "30" })}`, {}, signal).catch(() => ({ items: [] }));
    const byQuestion = new Map<number, any[]>();
    for (const a of answers.items || []) byQuestion.set(a.question_id, [...(byQuestion.get(a.question_id) || []), a]);
    return questions.map((q, rank): SearchResult => {
      const top = (byQuestion.get(q.question_id) || []).sort((a, b) => Number(b.is_accepted) - Number(a.is_accepted) || b.score - a.score).slice(0, 2);
      const body = [`Question: ${decode(q.title)}`, plain(q.body), ...top.map(a => `${a.is_accepted ? "Accepted answer" : "Answer"} (score ${a.score}):\n${plain(a.body)}`)].join("\n\n");
      return {
        url: q.link, title: decode(q.title), snippet: plain(q.body).slice(0, 300), provider: this.id, query, rank, sourceType: "forum",
        author: q.owner?.display_name ? decode(q.owner.display_name) : undefined, publisher: "Stack Overflow",
        publishedAt: q.creation_date ? new Date(q.creation_date * 1000).toISOString() : undefined, fullText: body,
        metadata: { score: q.score, answered: q.is_answered, acceptedAnswer: Boolean(q.accepted_answer_id), tags: q.tags }
      };
    });
  }
}
function decode(text: string): string {
  return text.replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">");
}
function plain(html: string | undefined): string {
  // Keep code blocks recognisable after tag stripping.
  return extractPlainText(decode((html || "").replace(/<pre[^>]*><code>/g, "\n```\n").replace(/<\/code><\/pre>/g, "\n```\n").replace(/<[^>]+>/g, " "))).text;
}
