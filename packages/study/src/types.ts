import type { Message } from "../../ai/src/types.ts";

/** One stored passage of a document, in reading order, with its exact place for citations. */
export interface StudyChunk { id: string; documentId: string; ordinal: number; text: string; page?: number; section?: string; lines?: [number, number]; embedding?: number[] }

/** A document as the study engine sees it: its passages in order, and how its text was obtained. */
export interface StudyDoc {
  id: string; name: string; mimeType: string; chunks: StudyChunk[];
  /** Images carry no layout or visual information here: at most the text read from them by OCR. */
  image?: boolean;
  /** What the user or the upload said this document is (instructions, rubric, submission, …), if known. */
  role?: DocRole;
}
export type DocRole = "instructions" | "rubric" | "submission" | "screenshot" | "reference";

/** Where something sits in a document. */
export interface Place { documentId: string; page?: number; section?: string; lines?: [number, number] }

/** Asks a model for text. Every study step goes through this, so any model can be plugged in. */
export type Generate = (messages: Message[], options?: { maxTokens?: number }) => Promise<string>;

export function describePlace(p: Omit<Place, "documentId">): string {
  return [p.page ? `p. ${p.page}` : "", p.section ? `§ ${p.section}` : "", p.lines ? `lines ${p.lines[0]}–${p.lines[1]}` : ""].filter(Boolean).join(", ");
}
