import { parseHTML } from "linkedom";
import { EmptyDocumentError, type DocumentUnit, type FileType, type ParsedDocument } from "./types.ts";

/** Turns an upload into units that keep their place (page, section, first line) for citations. */
export async function parseDocument(bytes: Buffer, type: FileType, name: string): Promise<ParsedDocument> {
  const parsed = await (type.kind === "pdf" ? parsePdf(bytes)
    : type.kind === "docx" ? parseDocx(bytes)
    : type.kind === "markdown" ? parseMarkdown(bytes.toString("utf8"))
    : type.kind === "code" ? { units: [{ text: normalise(bytes.toString("utf8")), firstLine: 1 }] }
    : type.kind === "text" ? { units: [{ text: normalise(bytes.toString("utf8")), firstLine: 1 }] }
    : Promise.reject(new EmptyDocumentError("Text recognition for images isn't available yet, so this image can't be searched.")));
  const units = parsed.units.filter(u => u.text.trim());
  if (!units.length) {
    throw new EmptyDocumentError(type.kind === "pdf" ? "This PDF has no extractable text (it may be a scanned image)." : "This file has no text to read.");
  }
  return { ...parsed, units, title: parsed.title || name };
}

function normalise(text: string): string {
  return (text.charCodeAt(0) === 0xfeff ? text.slice(1) : text).replace(/\r\n?/g, "\n");
}

async function parsePdf(bytes: Buffer): Promise<ParsedDocument> {
  const { getDocument } = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const task = getDocument({ data: new Uint8Array(bytes), useSystemFonts: false, disableFontFace: true, verbosity: 0 });
  const doc = await task.promise;
  const units: DocumentUnit[] = [];
  try {
    for (let page = 1; page <= doc.numPages; page++) {
      const content = await (await doc.getPage(page)).getTextContent();
      // pdf.js marks line ends; joining on them keeps paragraphs readable for chunking.
      const text = content.items.map(item => ("str" in item ? item.str + (item.hasEOL ? "\n" : "") : "")).join("").replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
      if (text) units.push({ text, page });
    }
    const info = (await doc.getMetadata().catch(() => undefined))?.info as { Title?: string } | undefined;
    return { units, pageCount: doc.numPages, title: info?.Title?.trim() || undefined };
  } finally { await task.destroy(); }
}

async function parseDocx(bytes: Buffer): Promise<ParsedDocument> {
  const mammoth = (await import("mammoth")).default;
  const { value: html } = await mammoth.convertToHtml({ buffer: bytes });
  const { document } = parseHTML(`<html><body>${html}</body></html>`);
  const units: DocumentUnit[] = [];
  let section: string | undefined;
  let lines: string[] = [];
  const flush = () => { if (lines.length) units.push({ text: lines.join("\n\n"), section }); lines = []; };
  for (const node of Array.from(document.body.children)) {
    const tag = node.tagName.toLowerCase();
    const text = (node.textContent || "").replace(/\s+/g, " ").trim();
    if (!text) continue;
    if (/^h[1-4]$/.test(tag)) { flush(); section = text.slice(0, 200); continue; }
    if (tag === "ul" || tag === "ol") lines.push(Array.from(node.querySelectorAll("li")).map(li => `- ${(li.textContent || "").replace(/\s+/g, " ").trim()}`).join("\n"));
    else if (tag === "table") lines.push(Array.from(node.querySelectorAll("tr")).map(tr => Array.from(tr.querySelectorAll("td,th")).map(c => (c.textContent || "").replace(/\s+/g, " ").trim()).join(" | ")).join("\n"));
    else lines.push(text);
  }
  flush();
  return { units };
}

function parseMarkdown(raw: string): ParsedDocument {
  const lines = normalise(raw).split("\n");
  const units: DocumentUnit[] = [];
  let section: string | undefined;
  let start = 1;
  let buffer: string[] = [];
  let inFence = false;
  const flush = (nextStart: number) => { if (buffer.join("").trim()) units.push({ text: buffer.join("\n"), section, firstLine: start }); buffer = []; start = nextStart; };
  lines.forEach((line, i) => {
    if (/^\s*(```|~~~)/.test(line)) inFence = !inFence;
    const heading = !inFence && line.match(/^#{1,4}\s+(.+?)\s*#*\s*$/);
    if (heading) { flush(i + 1); section = heading[1].slice(0, 200); }
    buffer.push(line);
  });
  flush(lines.length + 1);
  return { units, title: units.find(u => u.section)?.section };
}
