import { existsSync } from "node:fs";
import { mkdir, readFile, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import type { Db, Prisma } from "../../../../packages/db/src/client.ts";
import type { Chunk, StoredChunk } from "../../../../packages/files/src/index.ts";

export type LinkTarget = "conversation" | "research" | "assignment" | "project";
export interface DocumentLinkView { id: string; type: LinkTarget; targetId: string; role: string | null }
export interface DocumentView {
  id: string; name: string; displayName: string | null; mimeType: string; sizeBytes: number; kind: string;
  status: "processing" | "ready" | "failed"; error: string | null; pageCount: number | null; chunkCount: number; createdAt: string;
  links: DocumentLinkView[];
}
const withCount = { _count: { select: { chunks: true } }, links: true } as const;
type DocumentRow = Prisma.DocumentGetPayload<{ include: typeof withCount }>;
const targetColumn = { conversation: "conversationId", research: "researchProjectId", assignment: "assignmentId", project: "projectId" } as const;
function linkView(l: Prisma.DocumentLinkGetPayload<object>): DocumentLinkView {
  const [type, targetId] = (Object.entries(targetColumn) as [LinkTarget, keyof typeof l][]).map(([t, col]) => [t, l[col]] as const).find(([, v]) => v) ?? ["conversation", ""];
  return { id: l.id, type, targetId: String(targetId), role: l.role };
}
export function toDocumentView(d: DocumentRow): DocumentView {
  return {
    id: d.id, name: d.name, displayName: d.displayName, mimeType: d.mimeType, sizeBytes: d.sizeBytes, kind: d.kind, status: d.status, error: d.error,
    pageCount: d.pageCount, chunkCount: d._count.chunks, createdAt: d.createdAt.toISOString(), links: d.links.map(linkView)
  };
}
export interface DocumentFilter { q?: string; kind?: string; status?: string; linked?: { type: LinkTarget; id: string } }
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * Uploaded files: originals are stored once per content hash under data/files (content-addressed, so identical
 * uploads share storage), and their parsed chunks with embeddings live in PostgreSQL for retrieval.
 */
export class DocumentRepo {
  constructor(private readonly db: Db, private readonly storageRoot: string) {}

  storagePath(sha256: string, extension: string) { return `${sha256}.${extension}`; }
  absolutePath(relative: string) { return join(this.storageRoot, relative); }
  /** Moves a fully received upload into content-addressed storage (no-op if the same content is already stored). */
  async store(tempFile: string, relative: string) {
    await mkdir(this.storageRoot, { recursive: true });
    const target = this.absolutePath(relative);
    if (existsSync(target)) await rm(tempFile, { force: true });
    else await rename(tempFile, target);
  }
  read(relative: string) { return readFile(this.absolutePath(relative)); }

  async findBySha(workspaceId: string, sha256: string) {
    const d = await this.db.document.findUnique({ where: { workspaceId_sha256: { workspaceId, sha256 } }, include: withCount });
    return d ? toDocumentView(d) : undefined;
  }
  async create(data: { workspaceId: string; name: string; mimeType: string; sizeBytes: number; sha256: string; storagePath: string; kind?: "upload" | "course_material" | "assignment_instructions" | "rubric" | "lecture" }) {
    return toDocumentView(await this.db.document.create({ data: { ...data, kind: data.kind ?? "upload", status: "processing" }, include: withCount }));
  }
  async list(workspaceId: string, filter: DocumentFilter = {}): Promise<DocumentView[]> {
    const rows = await this.db.document.findMany({
      where: {
        workspaceId,
        ...(filter.q ? { OR: [{ name: { contains: filter.q, mode: "insensitive" } }, { displayName: { contains: filter.q, mode: "insensitive" } }] } : {}),
        ...(filter.kind ? { kind: filter.kind as never } : {}),
        ...(filter.status ? { status: filter.status as never } : {}),
        ...(filter.linked ? { links: { some: { [targetColumn[filter.linked.type]]: filter.linked.id } } } : {})
      },
      orderBy: { createdAt: "desc" }, include: withCount, take: 500
    });
    return rows.map(toDocumentView);
  }
  async rename(workspaceId: string, id: string, displayName: string | null) {
    if (!(await this.get(workspaceId, id))) return undefined;
    return toDocumentView(await this.db.document.update({ where: { id }, data: { displayName }, include: withCount }));
  }
  /** Attaches a document to a conversation, research project, assignment or project (idempotent; updates the role). */
  async link(workspaceId: string, id: string, type: LinkTarget, targetId: string, role: string | null): Promise<DocumentLinkView | "not-found"> {
    if (!(await this.get(workspaceId, id)) || !uuid.test(targetId)) return "not-found";
    const owned = await (type === "conversation" ? this.db.conversation.count({ where: { id: targetId, workspaceId } })
      : type === "research" ? this.db.researchProject.count({ where: { id: targetId, workspaceId } })
      : type === "assignment" ? this.db.assignment.count({ where: { id: targetId, course: { workspaceId } } })
      : this.db.project.count({ where: { id: targetId, workspaceId } }));
    if (!owned) return "not-found";
    const column = targetColumn[type];
    const existing = await this.db.documentLink.findFirst({ where: { documentId: id, [column]: targetId } });
    const row = existing
      ? await this.db.documentLink.update({ where: { id: existing.id }, data: { role } })
      : await this.db.documentLink.create({ data: { documentId: id, [column]: targetId, role } });
    return linkView(row);
  }
  async unlink(workspaceId: string, id: string, linkId: string): Promise<boolean> {
    if (!uuid.test(linkId)) return false;
    return (await this.db.documentLink.deleteMany({ where: { id: linkId, documentId: id, document: { workspaceId } } })).count > 0;
  }
  /** Ready documents linked to a target, optionally only with the given roles. */
  async linkedIds(type: LinkTarget, targetId: string, roles?: string[]): Promise<string[]> {
    const rows = await this.db.documentLink.findMany({ where: { [targetColumn[type]]: targetId, ...(roles ? { role: { in: roles } } : {}), document: { status: "ready" } }, select: { documentId: true } });
    return rows.map(r => r.documentId);
  }
  async get(workspaceId: string, id: string) {
    if (!uuid.test(id)) return undefined;
    return this.db.document.findFirst({ where: { id, workspaceId }, include: withCount });
  }
  /** Removes the document; the stored original is deleted only when no other document uses the same content. */
  async delete(workspaceId: string, id: string): Promise<boolean> {
    const doc = await this.get(workspaceId, id);
    if (!doc) return false;
    await this.db.source.deleteMany({ where: { documentId: id } });
    await this.db.document.delete({ where: { id } });
    if (!(await this.db.document.count({ where: { storagePath: doc.storagePath } }))) await rm(this.absolutePath(doc.storagePath), { force: true });
    return true;
  }
  async markReady(id: string, chunks: (Chunk & { embedding: number[] })[], pageCount?: number) {
    await this.db.$transaction([
      this.db.documentChunk.deleteMany({ where: { documentId: id } }),
      this.db.documentChunk.createMany({
        data: chunks.map(c => ({ documentId: id, ordinal: c.ordinal, text: c.text, page: c.page ?? null, section: c.section ?? null, lineStart: c.lines?.[0] ?? null, lineEnd: c.lines?.[1] ?? null, embedding: c.embedding, tokenCount: Math.ceil(c.text.length / 4) }))
      }),
      this.db.document.update({ where: { id }, data: { status: "ready", error: null, pageCount: pageCount ?? null } })
    ]);
  }
  markFailed(id: string, error: string) {
    return this.db.document.update({ where: { id }, data: { status: "failed", error: error.slice(0, 500) } });
  }
  /** Ready documents' chunks for retrieval — all of a workspace, or just the given documents. */
  async chunks(workspaceId: string, documentIds?: string[]): Promise<StoredChunk[]> {
    const rows = await this.db.documentChunk.findMany({
      where: { document: { workspaceId, status: "ready", ...(documentIds ? { id: { in: documentIds } } : {}) } },
      select: { id: true, documentId: true, text: true, embedding: true, page: true, section: true, lineStart: true, lineEnd: true }
    });
    return rows.map(r => ({ id: r.id, documentId: r.documentId, text: r.text, embedding: r.embedding, page: r.page ?? undefined, section: r.section ?? undefined, lines: r.lineStart && r.lineEnd ? [r.lineStart, r.lineEnd] : undefined }));
  }
  async readyCount(workspaceId: string) { return this.db.document.count({ where: { workspaceId, status: "ready" } }); }
  /** Documents left "processing" by a restart are failed, so the user can re-upload them. */
  markInterrupted() {
    return this.db.document.updateMany({ where: { status: "processing" }, data: { status: "failed", error: "Processing was interrupted by a server restart. Upload the file again." } });
  }
}
