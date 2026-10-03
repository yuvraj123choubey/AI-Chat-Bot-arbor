import { realpathSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

/** Folders that are never listed, searched, versioned or edited by the agent (dependencies and build output). */
export const IGNORED_DIRS = new Set(["node_modules", ".git", "dist", "build", ".next", ".nuxt", ".svelte-kit", ".turbo", ".cache", ".venv", "venv", "__pycache__", ".pytest_cache", "coverage", "target", ".idea", ".vscode"]);

export class PathError extends Error {}

/**
 * Normalises a project-relative path ("src/app.ts") and rejects anything that could leave the project: absolute
 * paths, "..", drive letters, NUL bytes, and paths through ignored folders such as .git.
 */
export function cleanRelative(input: string): string {
  if (typeof input !== "string") throw new PathError("Path must be a string");
  const raw = input.replace(/\\/g, "/").replace(/^\.\/+/, "").replace(/\/+$/, "").trim();
  if (!raw) return "";
  if (raw.includes("\0") || isAbsolute(raw) || /^[a-zA-Z]:/.test(raw) || raw.startsWith("/")) throw new PathError("Paths must be relative to the project");
  const parts = raw.split("/").filter(p => p && p !== ".");
  if (parts.some(p => p === "..")) throw new PathError("Paths may not contain '..'");
  if (parts.some(p => p === ".git")) throw new PathError("The project's .git folder is managed by Git, not edited here");
  if (parts.some(p => /[<>:"|?*]/.test(p))) throw new PathError("Path contains characters that are not allowed in file names");
  return parts.join("/");
}

/**
 * Resolves a project-relative path to an absolute one inside the project root, also following symlinks of the
 * existing part of the path so a link cannot point outside the project.
 */
export function insideProject(root: string, relPath: string): string {
  const clean = cleanRelative(relPath);
  const rootReal = realpathSync(root);
  const inside = (p: string) => { const rel = relative(rootReal, p); return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel)); };
  const absolute = resolve(rootReal, clean);
  if (!inside(absolute)) throw new PathError("Path is outside the project");
  // The nearest part of the path that exists is resolved through any symlinks and must still be inside.
  let probe = absolute;
  for (;;) {
    let real: string | undefined;
    try { real = realpathSync(probe); } catch { /* does not exist yet */ }
    if (real !== undefined) { if (!inside(real)) throw new PathError("Path leads outside the project"); break; }
    const parent = resolve(probe, "..");
    if (parent === probe) break;
    probe = parent;
  }
  return absolute;
}

export const toPosix = (p: string) => p.split(sep).join("/");
export const projectDir = (dataRoot: string, id: string) => join(dataRoot, "projects", id);
export const historyDir = (dataRoot: string, id: string) => join(dataRoot, "project-history", `${id}.git`);
export const runsDir = (dataRoot: string, id: string) => join(dataRoot, "project-runs", id);
