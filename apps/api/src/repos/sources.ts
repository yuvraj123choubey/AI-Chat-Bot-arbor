import type { Db, Prisma } from "../../../../packages/db/src/client.ts";
import type { EvidenceSource, RetrievedSource } from "../../../../packages/research/src/types.ts";
import type { CitationClaim } from "../../../../packages/research/src/citations.ts";

export interface SourceView {
  id: string; url: string; title: string; domain: string; author: string | null; publisher: string | null; publicationDate: string | null;
  retrievedAt: string; snippet: string; sourceType: string; searchQuery: string | null; saved: boolean; metadata: Record<string, unknown>;
}
export function toSourceView(s: Prisma.SourceGetPayload<object>): SourceView {
  return {
    id: s.id, url: s.url, title: s.title, domain: s.domain, author: s.author, publisher: s.publisher, publicationDate: s.publicationDate?.toISOString() ?? null,
    retrievedAt: s.retrievedAt.toISOString(), snippet: s.snippet, sourceType: s.sourceType, searchQuery: s.searchQuery, saved: s.saved, metadata: s.metadata as Record<string, unknown>
  };
}
function validDate(value?: string): Date | null {
  if (!value) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

export class SourceRepo {
  constructor(private readonly db: Db) {}

  /** Stores retrieved sources once per workspace (keyed by canonical URL), refreshing their text on re-retrieval. */
  async upsert(workspaceId: string, source: RetrievedSource): Promise<string> {
    const data = {
      url: source.url, title: source.title.slice(0, 500), domain: source.domain, author: source.author?.slice(0, 300) ?? null, publisher: source.publisher?.slice(0, 300) ?? null,
      publicationDate: validDate(source.publishedAt), retrievedAt: new Date(), snippet: source.snippet.slice(0, 2000), fullText: source.fullText.slice(0, 200_000),
      sourceType: source.sourceType, searchQuery: source.searchQuery?.slice(0, 500) ?? null, metadata: { ...source.metadata, readMode: source.readMode } as Prisma.InputJsonValue
    };
    const row = await this.db.source.upsert({
      where: { workspaceId_canonicalUrl: { workspaceId, canonicalUrl: source.canonicalUrl } },
      update: data, create: { workspaceId, canonicalUrl: source.canonicalUrl, ...data }, select: { id: true }
    });
    return row.id;
  }
  /** Records which numbered sources (and which passages) the model was given for an answer. */
  async attachToMessage(workspaceId: string, messageId: string, evidence: EvidenceSource[]): Promise<Map<number, string>> {
    const ids = new Map<number, string>();
    for (const e of evidence) ids.set(e.ordinal, await this.upsert(workspaceId, e.source));
    await this.db.messageSource.createMany({
      data: evidence.map(e => ({ messageId, sourceId: ids.get(e.ordinal)!, ordinal: e.ordinal, evidence: e.passages.map(p => ({ text: p.text, start: p.start })) as Prisma.InputJsonValue })),
      skipDuplicates: true
    });
    return ids;
  }
  async recordCitations(messageId: string, ordinalsToIds: Map<number, string>, cited: number[], claims: CitationClaim[]) {
    if (cited.length) await this.db.messageSource.updateMany({ where: { messageId, ordinal: { in: cited } }, data: { cited: true } });
    const rows = claims.filter(c => ordinalsToIds.has(c.ordinal)).map(c => ({ messageId, sourceId: ordinalsToIds.get(c.ordinal)!, ordinal: c.ordinal, claim: c.claim }));
    if (rows.length) await this.db.citation.createMany({ data: rows });
  }
  async list(workspaceId: string, options: { saved?: boolean; query?: string; take?: number } = {}): Promise<SourceView[]> {
    const rows = await this.db.source.findMany({
      where: {
        workspaceId, ...(options.saved ? { saved: true } : {}),
        ...(options.query ? { OR: [{ title: { contains: options.query, mode: "insensitive" } }, { domain: { contains: options.query, mode: "insensitive" } }] } : {})
      },
      orderBy: { retrievedAt: "desc" }, take: options.take ?? 100
    });
    return rows.map(toSourceView);
  }
  async get(workspaceId: string, id: string) {
    const row = await this.db.source.findFirst({ where: { workspaceId, id } });
    return row ? { ...toSourceView(row), fullText: row.fullText } : undefined;
  }
  async setSaved(workspaceId: string, id: string, saved: boolean): Promise<boolean> {
    return (await this.db.source.updateMany({ where: { workspaceId, id }, data: { saved } })).count > 0;
  }
}
