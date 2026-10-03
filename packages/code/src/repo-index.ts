import { existsSync } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { join, posix } from "node:path";
import type { ProjectFiles } from "./workspace.ts";
import { languageOf, looksBinary } from "./workspace.ts";

export interface SymbolInfo { name: string; kind: "function" | "class" | "method" | "type" | "variable"; line: number; exported: boolean }
export interface FileIndex { path: string; language: string; size: number; lines: number; symbols: SymbolInfo[]; imports: { spec: string; file?: string; line: number }[]; head: string }
export interface RepoIndex { files: Map<string, FileIndex>; importedBy: Map<string, Set<string>>; packages: string[]; builtAt: number }

const MAX_INDEX_BYTES = 512 * 1024;
const JS_KEYWORDS = new Set(["if", "for", "while", "switch", "catch", "function", "return", "constructor", "super", "else", "do", "try", "with", "typeof", "new", "await", "yield"]);

/** Definitions per language, by line. Regular expressions are approximate but fast and dependency-free. */
export function extractSymbols(language: string, text: string): SymbolInfo[] {
  const out: SymbolInfo[] = [];
  const lines = text.split("\n");
  const add = (name: string | undefined, kind: SymbolInfo["kind"], line: number, exported: boolean) => { if (name && !JS_KEYWORDS.has(name)) out.push({ name, kind, line, exported }); };
  lines.forEach((raw, i) => {
    const line = i + 1;
    let m: RegExpMatchArray | null;
    switch (language) {
      case "typescript": case "tsx": case "javascript": case "jsx": {
        const exported = /^\s*export\b/.test(raw) || /^\s*module\.exports\b/.test(raw);
        if ((m = raw.match(/^\s*(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)/))) add(m[1], "function", line, exported);
        else if ((m = raw.match(/^\s*(?:export\s+)?(?:default\s+)?(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)/))) add(m[1], "class", line, exported);
        else if ((m = raw.match(/^\s*(?:export\s+)?(?:declare\s+)?(?:interface|type|enum)\s+([A-Za-z_$][\w$]*)/))) add(m[1], "type", line, exported);
        else if ((m = raw.match(/^\s*(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=]+)?=\s*(?:async\s+)?(?:function\b|\([^)]*\)\s*(?::[^=]+)?=>|[A-Za-z_$][\w$]*\s*=>)/))) add(m[1], "function", line, exported);
        else if ((m = raw.match(/^\s*(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*[:=]/)) && /^\s*export\b/.test(raw)) add(m[1], "variable", line, true);
        else if ((m = raw.match(/^\s+(?:public\s+|private\s+|protected\s+|static\s+|async\s+|readonly\s+|get\s+|set\s+)*([A-Za-z_$][\w$]*)\s*\([^)]*\)\s*(?::\s*[^{]+)?\{\s*$/))) add(m[1], "method", line, false);
        else if ((m = raw.match(/^\s*(?:module\.)?exports\.([A-Za-z_$][\w$]*)\s*=/))) add(m[1], "function", line, true);
        break;
      }
      case "python":
        if ((m = raw.match(/^(\s*)(?:async\s+)?def\s+([A-Za-z_]\w*)/))) add(m[2], m[1] ? "method" : "function", line, !m[2].startsWith("_"));
        else if ((m = raw.match(/^\s*class\s+([A-Za-z_]\w*)/))) add(m[1], "class", line, !m[1].startsWith("_"));
        break;
      case "java": case "csharp":
        if ((m = raw.match(/^\s*(?:public|private|protected|internal|static|final|abstract|sealed|partial|\s)*\s*(?:class|interface|enum|record|struct)\s+([A-Za-z_]\w*)/))) add(m[1], "class", line, /\bpublic\b/.test(raw));
        else if ((m = raw.match(/^\s*(?:public|private|protected|internal|static|final|abstract|override|virtual|async|synchronized|\s)+[\w<>[\],.?\s]+\s+([A-Za-z_]\w*)\s*\([^;]*$/))) add(m[1], "method", line, /\bpublic\b/.test(raw));
        break;
      case "go":
        if ((m = raw.match(/^func\s+(?:\([^)]*\)\s*)?([A-Za-z_]\w*)/))) add(m[1], raw.startsWith("func (") ? "method" : "function", line, /^[A-Z]/.test(m[1]));
        else if ((m = raw.match(/^type\s+([A-Za-z_]\w*)/))) add(m[1], "type", line, /^[A-Z]/.test(m[1]));
        break;
      case "rust":
        if ((m = raw.match(/^\s*(pub(?:\([^)]*\))?\s+)?(?:async\s+)?fn\s+([A-Za-z_]\w*)/))) add(m[2], "function", line, Boolean(m[1]));
        else if ((m = raw.match(/^\s*(pub\s+)?(?:struct|enum|trait|type)\s+([A-Za-z_]\w*)/))) add(m[2], "type", line, Boolean(m[1]));
        break;
      case "cpp":
        if ((m = raw.match(/^\s*(?:class|struct)\s+([A-Za-z_]\w*)\s*[:{]?/)) && !raw.trim().endsWith(";")) add(m[1], "class", line, true);
        else if ((m = raw.match(/^[A-Za-z_][\w:<>*&\s]*?\b([A-Za-z_][\w:]*)\s*\([^;]*\)\s*(?:const)?\s*\{?\s*$/)) && !/^\s*(if|for|while|switch|return|else)\b/.test(raw)) add(m[1], "function", line, true);
        break;
    }
  });
  return out;
}

/** Module references: JS/TS import/require/export-from/dynamic import, Python import/from, CSS @import, HTML script/link. */
export function extractImports(language: string, text: string): { spec: string; line: number }[] {
  const out: { spec: string; line: number }[] = [];
  text.split("\n").forEach((raw, i) => {
    const line = i + 1;
    if (["typescript", "tsx", "javascript", "jsx"].includes(language)) {
      for (const m of raw.matchAll(/(?:\bfrom\s*|\bimport\s*\(?\s*|\brequire\s*\(\s*)["']([^"']+)["']/g)) out.push({ spec: m[1], line });
    } else if (language === "python") {
      const from = raw.match(/^\s*from\s+(\.*[\w.]*)\s+import\b/);
      if (from) out.push({ spec: from[1], line });
      const imp = raw.match(/^\s*import\s+([\w.]+(?:\s*,\s*[\w.]+)*)/);
      if (imp) for (const name of imp[1].split(",")) out.push({ spec: name.trim(), line });
    } else if (language === "css") {
      for (const m of raw.matchAll(/@import\s+(?:url\()?["']?([^"')\s;]+)/g)) out.push({ spec: m[1], line });
    } else if (language === "html") {
      for (const m of raw.matchAll(/<(?:script|link|img)\b[^>]*\b(?:src|href)=["']([^"'#?]+)["']/g)) if (!/^(https?:)?\/\//.test(m[1])) out.push({ spec: m[1], line });
    }
  });
  return out;
}

const JS_EXTS = ["", ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", "/index.ts", "/index.tsx", "/index.js", "/index.jsx"];
/** Resolves a module reference to a project file, if it points at one (packages and built-ins resolve to nothing). */
export function resolveImport(fromPath: string, spec: string, language: string, paths: Set<string>): string | undefined {
  const dir = posix.dirname(fromPath);
  if (language === "python") {
    const dots = spec.match(/^\.*/)![0].length;
    let base = dots ? dir.split("/").slice(0, Math.max(0, dir.split("/").length - (dots - 1))).join("/") : "";
    if (base === ".") base = "";
    const mod = spec.slice(dots).replace(/\./g, "/");
    const stem = [base, mod].filter(Boolean).join("/");
    return [`${stem}.py`, `${stem}/__init__.py`].find(p => paths.has(p)) ?? (dots ? undefined : [`${dir}/${mod}.py`].find(p => paths.has(p)));
  }
  if (!spec.startsWith(".") && !spec.startsWith("/")) return undefined;
  const target = spec.startsWith("/") ? spec.slice(1) : posix.normalize(posix.join(dir === "." ? "" : dir, spec));
  // TypeScript sources import "./x.js" for "./x.ts".
  const stems = [target, target.replace(/\.(m|c)?js$/, "")];
  for (const stem of stems) for (const ext of JS_EXTS) if (paths.has(`${stem}${ext}`)) return `${stem}${ext}`;
  return undefined;
}

const cache = new Map<string, { index: RepoIndex; mtimes: Map<string, number> }>();

/** Builds (or incrementally refreshes) the index of a project: files, symbols, imports and who imports whom. */
export async function indexRepo(files: ProjectFiles): Promise<RepoIndex> {
  const paths = await files.listFiles();
  const pathSet = new Set(paths);
  const previous = cache.get(files.root);
  const entries = new Map<string, FileIndex>();
  const mtimes = new Map<string, number>();
  for (const path of paths) {
    const absolute = join(files.root, path);
    const info = await stat(absolute).catch(() => undefined);
    if (!info) continue;
    mtimes.set(path, info.mtimeMs);
    const old = previous?.index.files.get(path);
    if (old && previous!.mtimes.get(path) === info.mtimeMs) { entries.set(path, old); continue; }
    const language = languageOf(path);
    if (info.size > MAX_INDEX_BYTES) { entries.set(path, { path, language, size: info.size, lines: 0, symbols: [], imports: [], head: "" }); continue; }
    const buffer = await readFile(absolute);
    if (looksBinary(buffer)) { entries.set(path, { path, language: "binary", size: info.size, lines: 0, symbols: [], imports: [], head: "" }); continue; }
    const text = buffer.toString("utf8");
    entries.set(path, { path, language, size: info.size, lines: text.split("\n").length, symbols: extractSymbols(language, text), imports: extractImports(language, text).map(i => ({ ...i })), head: text.slice(0, 1500) });
  }
  // Imports are re-resolved every time, since files may have been added or removed.
  const importedBy = new Map<string, Set<string>>();
  for (const entry of entries.values()) for (const imp of entry.imports) {
    imp.file = resolveImport(entry.path, imp.spec, entry.language, pathSet);
    if (imp.file) { if (!importedBy.has(imp.file)) importedBy.set(imp.file, new Set()); importedBy.get(imp.file)!.add(entry.path); }
  }
  let packages: string[] = [];
  if (existsSync(join(files.root, "package.json"))) {
    try { const pkg = JSON.parse(await readFile(join(files.root, "package.json"), "utf8")); packages = Object.keys({ ...pkg.dependencies, ...pkg.devDependencies }); } catch { /* malformed */ }
  }
  for (const req of ["requirements.txt"]) if (existsSync(join(files.root, req))) packages.push(...(await readFile(join(files.root, req), "utf8")).split("\n").map(l => l.split(/[=<>~!\s]/)[0].trim()).filter(Boolean));
  const index: RepoIndex = { files: entries, importedBy, packages, builtAt: Date.now() };
  cache.set(files.root, { index, mtimes });
  return index;
}

/** Definitions whose name matches (exact first, then case-insensitive, then substring). */
export function findSymbol(index: RepoIndex, name: string): (SymbolInfo & { path: string })[] {
  const all = [...index.files.values()].flatMap(f => f.symbols.map(s => ({ ...s, path: f.path })));
  const exact = all.filter(s => s.name === name);
  if (exact.length) return exact;
  const lower = name.toLowerCase();
  const loose = all.filter(s => s.name.toLowerCase() === lower);
  return loose.length ? loose : all.filter(s => s.name.toLowerCase().includes(lower)).slice(0, 30);
}

const words = (text: string) => (text.toLowerCase().match(/[a-z0-9_]+/g) || []).flatMap(w => [w, ...w.split("_")]).filter(w => w.length > 2);
/**
 * Files most likely relevant to a task, best first: files the task names, files whose path, symbols or opening
 * lines share the task's words (rarer words count more), and then the files those import or are imported by.
 */
export function relevantFiles(index: RepoIndex, task: string, limit = 8): { path: string; reason: string }[] {
  const terms = new Set(words(task.replace(/([a-z])([A-Z])/g, "$1 $2")));
  const docs = [...index.files.values()].filter(f => f.language !== "binary");
  const df = new Map<string, number>();
  const bags = new Map<string, { path: Set<string>; symbols: Set<string>; body: Set<string> }>();
  for (const f of docs) {
    const bag = { path: new Set(words(f.path.replace(/[/.\\-]/g, " "))), symbols: new Set(f.symbols.flatMap(s => words(s.name.replace(/([a-z])([A-Z])/g, "$1 $2")).concat(s.name.toLowerCase()))), body: new Set(words(f.head)) };
    bags.set(f.path, bag);
    for (const t of new Set([...bag.path, ...bag.symbols, ...bag.body])) df.set(t, (df.get(t) ?? 0) + 1);
  }
  const idf = (t: string) => Math.log(1 + docs.length / (1 + (df.get(t) ?? 0)));
  const scored = docs.map(f => {
    const bag = bags.get(f.path)!;
    let score = 0;
    const why: string[] = [];
    if (task.includes(f.path) || task.includes(f.path.split("/").pop()!)) { score += 20; why.push("named in the task"); }
    for (const t of terms) {
      if (bag.path.has(t)) { score += 3 * idf(t); why.push(`path: ${t}`); }
      if (bag.symbols.has(t)) { score += 2.5 * idf(t); why.push(`defines ${t}`); }
      if (bag.body.has(t)) score += idf(t);
    }
    if (/test|spec/.test(f.path)) score *= 0.85;
    return { path: f.path, score, reason: [...new Set(why)].slice(0, 3).join(", ") || "mentions task terms" };
  }).filter(s => s.score > 0).sort((a, b) => b.score - a.score);
  const top = scored.slice(0, limit);
  // Direct neighbours in the import graph of the best matches are likely needed too.
  for (const hit of scored.slice(0, 3)) {
    const file = index.files.get(hit.path)!;
    const neighbours = [...file.imports.map(i => i.file).filter((p): p is string => Boolean(p)), ...(index.importedBy.get(hit.path) ?? [])];
    for (const n of neighbours) if (top.length < limit + 3 && !top.some(t => t.path === n)) top.push({ path: n, score: 0, reason: `imports or is imported by ${hit.path}` });
  }
  return top.map(({ path, reason }) => ({ path, reason }));
}

/** A one-line description of a file for the agent: size and its main definitions. */
export function describeFile(index: RepoIndex, path: string): string {
  const f = index.files.get(path);
  if (!f) return path;
  const defs = f.symbols.filter(s => s.kind !== "method").slice(0, 8).map(s => `${s.name}@${s.line}`).join(", ");
  const imports = f.imports.filter(i => i.file).map(i => i.file).slice(0, 5).join(", ");
  return `${path} (${f.lines} lines${defs ? `; defines ${defs}` : ""}${imports ? `; imports ${imports}` : ""})`;
}

