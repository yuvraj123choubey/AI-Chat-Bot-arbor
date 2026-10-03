import { createReadStream } from "node:fs";
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, extname, join } from "node:path";
import { createInterface } from "node:readline";
import { IGNORED_DIRS, PathError, cleanRelative, insideProject } from "./paths.ts";

export interface TreeEntry { path: string; name: string; type: "file" | "dir"; size?: number; children?: TreeEntry[] }
export interface FileContent { path: string; content: string | null; size: number; binary: boolean; language: string; truncated: boolean }
export interface SearchHit { path: string; line: number; text: string }

export const MAX_EDIT_BYTES = 2 * 1024 * 1024;
const MAX_TREE_ENTRIES = 5000;

const languages: Record<string, string> = {
  ".ts": "typescript", ".tsx": "tsx", ".js": "javascript", ".jsx": "jsx", ".mjs": "javascript", ".cjs": "javascript", ".json": "json",
  ".html": "html", ".htm": "html", ".css": "css", ".scss": "css", ".md": "markdown", ".markdown": "markdown", ".py": "python",
  ".java": "java", ".c": "cpp", ".h": "cpp", ".cpp": "cpp", ".hpp": "cpp", ".cc": "cpp", ".cs": "csharp", ".go": "go", ".rs": "rust",
  ".rb": "ruby", ".php": "php", ".sql": "sql", ".sh": "shell", ".yml": "yaml", ".yaml": "yaml", ".xml": "xml", ".toml": "toml", ".txt": "text", ".csv": "text"
};
export const languageOf = (path: string) => languages[extname(path).toLowerCase()] ?? "text";

/** Heuristic binary check: NUL bytes or many control characters in the first 8 KB. */
export function looksBinary(buffer: Buffer): boolean {
  const sample = buffer.subarray(0, 8192);
  let control = 0;
  for (const byte of sample) {
    if (byte === 0) return true;
    if (byte < 9 || (byte > 13 && byte < 32)) control++;
  }
  return sample.length > 0 && control / sample.length > 0.1;
}

/** File operations on one project folder; every path is validated to stay inside it. */
export class ProjectFiles {
  constructor(readonly root: string) {}

  async tree(): Promise<TreeEntry[]> {
    let count = 0;
    const walk = async (rel: string): Promise<TreeEntry[]> => {
      const entries = await readdir(rel ? join(this.root, rel) : this.root, { withFileTypes: true });
      const out: TreeEntry[] = [];
      for (const entry of entries.sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name))) {
        if (++count > MAX_TREE_ENTRIES) break;
        const path = rel ? `${rel}/${entry.name}` : entry.name;
        if (entry.isSymbolicLink()) continue;
        if (entry.isDirectory()) {
          // Dependency and build folders are shown but not expanded.
          out.push(IGNORED_DIRS.has(entry.name) ? { path, name: entry.name, type: "dir" } : { path, name: entry.name, type: "dir", children: await walk(path) });
        } else if (entry.isFile()) {
          out.push({ path, name: entry.name, type: "file", size: (await stat(join(this.root, path))).size });
        }
      }
      return out;
    };
    return walk("");
  }
  /** Every editable file path (ignored folders skipped), for search and for the agent's overview. */
  async listFiles(): Promise<string[]> {
    const flat: string[] = [];
    const visit = (entries: TreeEntry[]) => { for (const e of entries) { if (e.type === "file") flat.push(e.path); else if (e.children) visit(e.children); } };
    visit(await this.tree());
    return flat;
  }

  async read(relPath: string): Promise<FileContent> {
    const path = cleanRelative(relPath);
    const absolute = insideProject(this.root, path);
    const info = await stat(absolute).catch(() => { throw new PathError(`File not found: ${path}`); });
    if (!info.isFile()) throw new PathError(`${path} is a folder`);
    const buffer = await readFile(absolute);
    const binary = looksBinary(buffer);
    const truncated = !binary && buffer.length > MAX_EDIT_BYTES;
    return { path, size: info.size, binary, language: languageOf(path), truncated, content: binary ? null : buffer.subarray(0, MAX_EDIT_BYTES).toString("utf8") };
  }
  async readBytes(relPath: string): Promise<Buffer> {
    return readFile(insideProject(this.root, relPath));
  }
  async write(relPath: string, content: string | Buffer): Promise<void> {
    const path = cleanRelative(relPath);
    if (!path) throw new PathError("A file name is required");
    if (Buffer.byteLength(content) > 20 * 1024 * 1024) throw new PathError("File is too large (20 MB limit)");
    const absolute = insideProject(this.root, path);
    const existing = await stat(absolute).catch(() => undefined);
    if (existing?.isDirectory()) throw new PathError(`${path} is a folder`);
    await mkdir(dirname(absolute), { recursive: true });
    await writeFile(absolute, content);
  }
  async mkdir(relPath: string): Promise<void> {
    const path = cleanRelative(relPath);
    if (!path) throw new PathError("A folder name is required");
    await mkdir(insideProject(this.root, path), { recursive: true });
  }
  async rename(from: string, to: string): Promise<void> {
    const source = insideProject(this.root, from);
    const target = insideProject(this.root, to);
    if (!cleanRelative(from) || !cleanRelative(to)) throw new PathError("Both paths are required");
    if (await stat(target).catch(() => undefined)) throw new PathError(`${cleanRelative(to)} already exists`);
    await stat(source).catch(() => { throw new PathError(`Not found: ${cleanRelative(from)}`); });
    await mkdir(dirname(target), { recursive: true });
    await rename(source, target);
  }
  async remove(relPath: string): Promise<void> {
    const path = cleanRelative(relPath);
    if (!path) throw new PathError("The project folder itself cannot be deleted here");
    const absolute = insideProject(this.root, path);
    await stat(absolute).catch(() => { throw new PathError(`Not found: ${path}`); });
    await rm(absolute, { recursive: true, force: true });
  }
  /** Literal, case-insensitive search across text files; dependency and build folders are skipped. */
  async search(query: string, limit = 200): Promise<SearchHit[]> {
    const needle = query.toLowerCase();
    if (!needle.trim()) return [];
    const hits: SearchHit[] = [];
    for (const path of await this.listFiles()) {
      const absolute = join(this.root, path);
      const info = await stat(absolute);
      if (info.size > MAX_EDIT_BYTES) continue;
      const head = await readFile(absolute).then(b => b.subarray(0, 8192));
      if (looksBinary(head)) continue;
      // Matching file names count too, so "where is the login page" finds login.html.
      if (path.toLowerCase().includes(needle)) hits.push({ path, line: 0, text: path });
      const lines = createInterface({ input: createReadStream(absolute, "utf8"), crlfDelay: Infinity });
      let n = 0;
      for await (const line of lines) {
        n++;
        if (line.toLowerCase().includes(needle)) { hits.push({ path, line: n, text: line.trim().slice(0, 300) }); if (hits.length >= limit) { lines.close(); return hits; } }
      }
    }
    return hits;
  }
}
