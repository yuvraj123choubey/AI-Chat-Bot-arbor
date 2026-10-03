/** Where a piece of text sits in its document, so a citation can point at it exactly. */
export interface Locator { page?: number; section?: string; lines?: [number, number] }

/** A natural region of a document: a PDF page, a DOCX/Markdown section, or a whole text/code file. */
export interface DocumentUnit { text: string; page?: number; section?: string; firstLine?: number }

export interface ParsedDocument { units: DocumentUnit[]; pageCount?: number; title?: string; /** Set for images: how sure text recognition was (0–100). */ ocr?: { confidence: number } }

export interface Chunk extends Locator { ordinal: number; text: string }

export type FileKind = "pdf" | "docx" | "markdown" | "text" | "code" | "image";
export interface FileType { kind: FileKind; mimeType: string; extension: string }

export class UnsupportedFileError extends Error {}
export class EmptyDocumentError extends Error {}
