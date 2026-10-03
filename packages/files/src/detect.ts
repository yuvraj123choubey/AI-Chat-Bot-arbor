import { extname } from "node:path";
import { UnsupportedFileError, type FileType } from "./types.ts";

const code = new Set(["js", "mjs", "cjs", "ts", "tsx", "jsx", "py", "java", "c", "h", "cpp", "cc", "hpp", "cs", "go", "rs", "rb", "php", "swift", "kt", "scala", "sql", "sh", "ps1", "r", "m", "lua", "dart", "html", "css", "scss", "json", "yaml", "yml", "toml", "xml", "ipynb", "vue", "svelte"]);
const text = new Set(["txt", "csv", "tsv", "log", "tex", "rst"]);
export const supportedExtensions = ["pdf", "docx", "md", "markdown", ...text, ...code, "png", "jpg", "jpeg"];

function isUtf8Text(bytes: Buffer): boolean {
  const sample = bytes.subarray(0, 65_536);
  if (sample.includes(0)) return false;
  try { new TextDecoder("utf-8", { fatal: true }).decode(sample.length < bytes.length ? sample.subarray(0, sample.lastIndexOf(10) + 1 || sample.length) : sample); return true; } catch { return false; }
}

/**
 * Identifies an upload from its extension and checks the content really is that type (magic bytes or valid UTF-8),
 * so a renamed executable or an HTML page posing as a PDF is rejected.
 */
export function detectFileType(name: string, bytes: Buffer): FileType {
  const ext = extname(name).slice(1).toLowerCase();
  const head = bytes.subarray(0, 8);
  const unsupported = () => new UnsupportedFileError(`Unsupported file. Arbor reads PDF, Word (.docx), Markdown, plain text, source code, and PNG/JPEG images.`);
  if (ext === "pdf") { if (head.subarray(0, 5).toString("latin1") !== "%PDF-") throw unsupported(); return { kind: "pdf", mimeType: "application/pdf", extension: ext }; }
  if (ext === "docx") { if (head.readUInt32BE(0) !== 0x504b0304) throw unsupported(); return { kind: "docx", mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", extension: ext }; }
  if (ext === "png") { if (head.toString("hex") !== "89504e470d0a1a0a") throw unsupported(); return { kind: "image", mimeType: "image/png", extension: ext }; }
  if (ext === "jpg" || ext === "jpeg") { if (head[0] !== 0xff || head[1] !== 0xd8) throw unsupported(); return { kind: "image", mimeType: "image/jpeg", extension: ext }; }
  if (ext === "md" || ext === "markdown") { if (!isUtf8Text(bytes)) throw unsupported(); return { kind: "markdown", mimeType: "text/markdown; charset=utf-8", extension: ext }; }
  if (text.has(ext)) { if (!isUtf8Text(bytes)) throw unsupported(); return { kind: "text", mimeType: "text/plain; charset=utf-8", extension: ext }; }
  // Code (including HTML/XML/SVG-like formats) is always served back as plain text, never rendered.
  if (code.has(ext)) { if (!isUtf8Text(bytes)) throw unsupported(); return { kind: "code", mimeType: "text/plain; charset=utf-8", extension: ext }; }
  throw unsupported();
}
