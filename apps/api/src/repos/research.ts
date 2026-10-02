import type { Db, Prisma } from "../../../../packages/db/src/client.ts";
import type { CitationClaim } from "../../../../packages/research/src/citations.ts";
import type { Note, RegisteredSource, ResearchPlan } from "../../../../packages/research/src/deep.ts";
import { toSourceView, type SourceRepo, type SourceView } from "./sources.ts";

export interface ResearchSummary { id: string; question: string; status: string; createdAt: string; updatedAt: string; taskId: string | null }
export interface ResearchDetail extends ResearchSummary {
  plan: ResearchPlan | null; queries: string[]; report: string | null; error: string | null;
  sources: { ordinal: number; cited: boolean; source: SourceView }[];
  notes: { topic: string | null; content: string; sourceOrdinals: number[] }[];
  steps: { id: string; ordinal: number; kind: string; title: string; status: string; startedAt: string | null; finishedAt: string | null; error: string | null }[];
}

export class ResearchRepo {
  constructor(private readonly db: Db, private readonly sources: SourceRepo) {}

  create(workspaceId: string, question: string) {
    return this.db.researchProject.create({ data: { workspaceId, question, status: "planning" } });
  }
  linkTask(id: string, taskId: string) {
    return this.db.researchProject.update({ where: { id }, data: { taskId } });
  }
  async list(workspaceId: string): Promise<ResearchSummary[]> {
    const rows = await this.db.researchProject.findMany({ where: { workspaceId }, orderBy: { createdAt: "desc" }, take: 50 });
    return rows.map(r => ({ id: r.id, question: r.question, status: r.status, createdAt: r.createdAt.toISOString(), updatedAt: r.updatedAt.toISOString(), taskId: r.taskId }));
  }
  async get(workspaceId: string, id: string): Promise<ResearchDetail | undefined> {
    if (!/^[0-9a-f-]{36}$/.test(id)) return undefined;
    const r = await this.db.researchProject.findFirst({
      where: { id, workspaceId },
      include: {
        sources: { orderBy: { ordinal: "asc" }, include: { source: true } },
        notes: { orderBy: { createdAt: "asc" } },
        citations: { select: { ordinal: true } },
        task: { include: { steps: { orderBy: { ordinal: "asc" } } } }
      }
    });
    if (!r) return undefined;
    const cited = new Set(r.citations.map(c => c.ordinal));
    return {
      id: r.id, question: r.question, status: r.status, createdAt: r.createdAt.toISOString(), updatedAt: r.updatedAt.toISOString(), taskId: r.taskId,
      plan: (r.plan as unknown as ResearchPlan) ?? null, queries: (r.queries as string[]) ?? [], report: r.report, error: r.error,
      sources: r.sources.map(s => ({ ordinal: s.ordinal, cited: cited.has(s.ordinal), source: toSourceView(s.source) })),
      notes: r.notes.map(n => ({ topic: n.topic, content: n.content, sourceOrdinals: n.sourceOrdinals })),
      steps: (r.task?.steps ?? []).map(s => ({ id: s.id, ordinal: s.ordinal, kind: s.kind, title: s.title, status: s.status, startedAt: s.startedAt?.toISOString() ?? null, finishedAt: s.finishedAt?.toISOString() ?? null, error: s.error }))
    };
  }
  setStatus(id: string, status: "planning" | "running" | "completed" | "failed" | "cancelled", error?: string) {
    return this.db.researchProject.update({ where: { id }, data: { status, error: error ?? null } });
  }
  savePlan(id: string, plan: ResearchPlan) {
    return this.db.researchProject.update({ where: { id }, data: { plan: plan as unknown as Prisma.InputJsonValue, status: "running" } });
  }
  saveQueries(id: string, queries: string[]) {
    return this.db.researchProject.update({ where: { id }, data: { queries } });
  }
  /** Stores newly found sources in the workspace library and numbers them within the project. */
  async addSources(workspaceId: string, id: string, added: RegisteredSource[]): Promise<Map<number, string>> {
    const ids = new Map<number, string>();
    for (const s of added) ids.set(s.ordinal, await this.sources.upsert(workspaceId, s.source));
    await this.db.researchSource.createMany({ data: added.map(s => ({ researchProjectId: id, sourceId: ids.get(s.ordinal)!, ordinal: s.ordinal, relevance: s.passages[0]?.score ?? null })), skipDuplicates: true });
    return ids;
  }
  saveNotes(id: string, notes: Note[]) {
    return this.db.researchNote.createMany({ data: notes.map(n => ({ researchProjectId: id, topic: n.topic.slice(0, 300), content: n.content, sourceOrdinals: n.sourceOrdinals })) });
  }
  async complete(id: string, report: string, claims: CitationClaim[]) {
    const links = await this.db.researchSource.findMany({ where: { researchProjectId: id }, select: { ordinal: true, sourceId: true } });
    const byOrdinal = new Map(links.map(l => [l.ordinal, l.sourceId]));
    const rows = claims.filter(c => byOrdinal.has(c.ordinal)).map(c => ({ researchProjectId: id, sourceId: byOrdinal.get(c.ordinal)!, ordinal: c.ordinal, claim: c.claim }));
    await this.db.$transaction([
      this.db.citation.deleteMany({ where: { researchProjectId: id } }),
      ...(rows.length ? [this.db.citation.createMany({ data: rows })] : []),
      this.db.researchProject.update({ where: { id }, data: { report, status: "completed", error: null } })
    ]);
  }
  async delete(workspaceId: string, id: string): Promise<boolean> {
    if (!/^[0-9a-f-]{36}$/.test(id)) return false;
    return (await this.db.researchProject.deleteMany({ where: { id, workspaceId } })).count > 0;
  }
  /** Projects whose task was interrupted by a restart are marked failed too. */
  markInterrupted() {
    return this.db.researchProject.updateMany({ where: { status: { in: ["planning", "running"] } }, data: { status: "failed", error: "Interrupted by a server restart." } });
  }
}
