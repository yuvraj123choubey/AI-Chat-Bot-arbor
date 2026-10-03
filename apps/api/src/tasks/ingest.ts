import { chunkDocument, detectFileType, parseDocument, EmptyDocumentError, UnsupportedFileError } from "../../../../packages/files/src/index.ts";
import type { App } from "../app.ts";
import type { TaskContext } from "./engine.ts";

export interface IngestInput { documentId: string }

/** Parses an uploaded file, splits it into located chunks, embeds them locally, and marks the document ready. */
export function ingestHandler(app: App) {
  return async (ctx: TaskContext) => {
    const { documentId } = ctx.input as unknown as IngestInput;
    const doc = await app.db.document.findUniqueOrThrow({ where: { id: documentId } });
    try {
      const bytes = await app.documents.read(doc.storagePath);
      ctx.emit({ type: "progress", stage: "parsing", label: "Reading the file" });
      const parsed = await ctx.step("parse", `Read ${doc.name}`, { name: doc.name, bytes: doc.sizeBytes }, () => parseDocument(bytes, detectFileType(doc.name, bytes), doc.name), p => ({ units: p.units.length, pageCount: p.pageCount ?? null }));
      ctx.emit({ type: "progress", stage: "chunking", label: "Splitting into passages" });
      const chunks = chunkDocument(parsed.units);
      const embedded = await ctx.step("embed", `Index ${chunks.length} passages`, { chunks: chunks.length, model: app.embedder.id }, async () => {
        const vectors: number[][] = [];
        for (let i = 0; i < chunks.length; i += 32) {
          ctx.signal.throwIfAborted();
          vectors.push(...await app.embedder.embed(chunks.slice(i, i + 32).map(c => [c.section, c.text].filter(Boolean).join("\n")), "passage"));
          ctx.emit({ type: "progress", stage: "embedding", label: "Indexing passages", detail: `${Math.min(i + 32, chunks.length)} of ${chunks.length}` });
        }
        return chunks.map((c, i) => ({ ...c, embedding: vectors[i] }));
      }, e => ({ chunks: e.length }));
      await app.documents.markReady(documentId, embedded, parsed.pageCount);
      return { chunks: embedded.length, pageCount: parsed.pageCount ?? null };
    } catch (error) {
      const readable = error instanceof EmptyDocumentError || error instanceof UnsupportedFileError;
      await app.documents.markFailed(documentId, ctx.signal.aborted ? "Processing was cancelled." : readable ? (error as Error).message : "This file could not be read. It may be damaged or password-protected.");
      if (!readable && !ctx.signal.aborted) console.warn(`Ingest failed for ${documentId}:`, error instanceof Error ? error.message : error);
      throw error;
    }
  };
}
