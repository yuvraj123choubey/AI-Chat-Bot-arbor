import { detectFileType } from "./detect.ts";
import { parseDocument } from "./parse.ts";

export type Preview =
  | { kind: "pages"; total: number; from: number; to: number; pages: { page: number; text: string }[] }
  | { kind: "sections"; total: number; from: number; to: number; sections: { index: number; section: string | null; text: string }[] }
  | { kind: "lines"; total: number; from: number; to: number; lines: { n: number; text: string }[] }
  | { kind: "image" };

const clamp = (value: number, min: number, max: number) => Math.min(Math.max(value, min), max);

/**
 * Readable preview of a stored file: page text for PDFs, sections for Word documents, numbered lines for text,
 * Markdown and code (the same numbering citations use). Images are previewed from the original bytes instead.
 */
export async function previewDocument(bytes: Buffer, name: string, range: { from?: number; to?: number } = {}): Promise<Preview> {
  const type = detectFileType(name, bytes);
  if (type.kind === "image") return { kind: "image" };
  if (type.kind === "text" || type.kind === "code" || type.kind === "markdown") {
    const raw = bytes.toString("utf8");
    const all = (raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw).replace(/\r\n?/g, "\n").split("\n");
    const from = clamp(range.from ?? 1, 1, Math.max(1, all.length));
    const to = clamp(range.to ?? from + 399, from, Math.min(all.length, from + 1999));
    return { kind: "lines", total: all.length, from, to, lines: all.slice(from - 1, to).map((text, i) => ({ n: from + i, text })) };
  }
  const parsed = await parseDocument(bytes, type, name);
  if (type.kind === "pdf") {
    const total = parsed.pageCount ?? parsed.units.length;
    const from = clamp(range.from ?? 1, 1, Math.max(1, total));
    const to = clamp(range.to ?? from + 4, from, Math.min(total, from + 19));
    const byPage = new Map(parsed.units.map(u => [u.page!, u.text]));
    return { kind: "pages", total, from, to, pages: Array.from({ length: to - from + 1 }, (_, i) => ({ page: from + i, text: byPage.get(from + i) ?? "" })) };
  }
  const total = parsed.units.length;
  const from = clamp(range.from ?? 1, 1, Math.max(1, total));
  const to = clamp(range.to ?? from + 9, from, Math.min(total, from + 49));
  return { kind: "sections", total, from, to, sections: parsed.units.slice(from - 1, to).map((u, i) => ({ index: from + i, section: u.section ?? null, text: u.text })) };
}
