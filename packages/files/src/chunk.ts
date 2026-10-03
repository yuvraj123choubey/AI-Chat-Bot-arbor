import type { Chunk, DocumentUnit } from "./types.ts";

const TARGET = 900;
const MAX = 1400;
const MAX_LINES = 60;

/**
 * Splits units into retrieval chunks without crossing a page or section, so every chunk has one exact locator.
 * Units with line numbers (text, Markdown, code) are split on lines and keep their line range; others on paragraphs.
 */
export function chunkDocument(units: DocumentUnit[]): Chunk[] {
  const chunks: Chunk[] = [];
  const push = (text: string, unit: DocumentUnit, lines?: [number, number]) => {
    const clean = text.trim();
    if (clean) chunks.push({ ordinal: chunks.length, text: clean, page: unit.page, section: unit.section, lines });
  };
  for (const unit of units) {
    if (unit.firstLine !== undefined) {
      const lines = unit.text.split("\n");
      let from = 0;
      while (from < lines.length) {
        let to = from, size = 0;
        while (to < lines.length && to - from < MAX_LINES && (size + lines[to].length < TARGET || to === from)) size += lines[to++].length + 1;
        // Prefer to end at a blank line (a paragraph or block boundary) when one is near.
        const blank = lines.slice(from + 1, to).lastIndexOf("");
        if (to < lines.length && blank > (to - from) / 2) to = from + 1 + blank;
        push(lines.slice(from, to).join("\n"), unit, [unit.firstLine + from, unit.firstLine + to - 1]);
        from = to;
      }
      continue;
    }
    const paragraphs = unit.text.split(/\n{2,}/);
    let buffer = "";
    for (const paragraph of paragraphs) {
      for (const piece of paragraph.length > MAX ? paragraph.match(new RegExp(`[\\s\\S]{1,${TARGET}}(?:\\s|$)`, "g")) || [paragraph] : [paragraph]) {
        if (buffer && buffer.length + piece.length > TARGET) { push(buffer, unit); buffer = ""; }
        buffer += (buffer ? "\n\n" : "") + piece.trim();
      }
    }
    push(buffer, unit);
  }
  return chunks;
}
