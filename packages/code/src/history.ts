import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { IGNORED_DIRS } from "./paths.ts";

export interface Checkpoint { commit: string; message: string; author: "you" | "agent" | "system"; createdAt: string; files: FileChange[] }
export interface FileChange { path: string; status: "added" | "modified" | "deleted" | "renamed"; added: number; removed: number; oldPath?: string }
export interface Diff { files: FileChange[]; patch: string; truncated: boolean }

const authors = { you: "You <you@arbor.local>", agent: "Arbor agent <agent@arbor.local>", system: "Arbor <system@arbor.local>" } as const;
const MAX_PATCH = 400_000;

/**
 * Lightweight version history for a project, kept in a Git repository *outside* the project folder (a separate
 * git-dir with the project as its work tree). The project's own .git, if it has one, is excluded and untouched, so
 * the user's Git keeps working. Dependency and build folders are excluded too.
 */
export class ProjectHistory {
  constructor(readonly root: string, readonly gitDir: string) {}

  private git(args: string[], input?: { maxBuffer?: number }): Promise<string> {
    return new Promise((resolve, reject) => {
      execFile("git", ["--git-dir", this.gitDir, "--work-tree", this.root, "-c", "core.autocrlf=false", "-c", "core.quotepath=false", "-c", "commit.gpgsign=false", ...args],
        { cwd: this.root, maxBuffer: input?.maxBuffer ?? 20 * 1024 * 1024, windowsHide: true, env: { ...gitEnv(), GIT_TERMINAL_PROMPT: "0" } },
        (error, stdout, stderr) => (error ? reject(new Error(`git ${args[0]}: ${(stderr || error.message).trim().slice(0, 400)}`)) : resolve(stdout)));
    });
  }

  async init(): Promise<void> {
    if (existsSync(join(this.gitDir, "HEAD"))) return;
    await mkdir(this.gitDir, { recursive: true });
    await this.git(["init", "--quiet"]);
    await mkdir(join(this.gitDir, "info"), { recursive: true });
    await writeFile(join(this.gitDir, "info", "exclude"), [...IGNORED_DIRS].map(d => `${d}/`).concat(["*.log", ".DS_Store", "Thumbs.db"]).join("\n") + "\n");
  }

  /** Records the current state of every file. Returns undefined when nothing changed since the last checkpoint. */
  async checkpoint(message: string, author: Checkpoint["author"] = "you"): Promise<Checkpoint | undefined> {
    await this.init();
    await this.git(["add", "--all", "."]);
    const hasHead = await this.git(["rev-parse", "--verify", "--quiet", "HEAD"]).then(() => true, () => false);
    const pending = await this.git(["diff", "--cached", "--name-only"]);
    if (hasHead && !pending.trim()) return undefined;
    const [name, email] = authors[author].replace(">", "").split(" <");
    await this.git(["-c", `user.name=${name}`, "-c", `user.email=${email}`, "commit", "--quiet", "--allow-empty", "-m", message.slice(0, 500)]);
    return (await this.log(1))[0];
  }

  async log(limit = 50): Promise<Checkpoint[]> {
    if (!existsSync(join(this.gitDir, "HEAD"))) return [];
    const hasHead = await this.git(["rev-parse", "--verify", "--quiet", "HEAD"]).then(() => true, () => false);
    if (!hasHead) return [];
    const raw = await this.git(["log", `-n${limit}`, "--format=%x1e%H%x1f%an%x1f%aI%x1f%s", "--numstat", "-M"]);
    return raw.split("\x1e").filter(r => r.trim()).map(record => {
      const [head, ...stats] = record.split("\n");
      const [commit, authorName, createdAt, message] = head.split("\x1f");
      const files = stats.filter(l => l.trim()).map(parseNumstat);
      return { commit, message, createdAt, author: authorName === "Arbor agent" ? "agent" : authorName === "Arbor" ? "system" : "you", files };
    });
  }

  /** Changes between two checkpoints, or from a checkpoint to the current files when `to` is omitted. */
  async diff(from: string, to?: string): Promise<Diff> {
    await this.init();
    if (!to) await this.git(["add", "--all", "."]);
    const range = to ? [from, to] : ["--cached", from];
    const numstat = await this.git(["diff", "-M", "--numstat", ...range]);
    const names = await this.git(["diff", "-M", "--name-status", ...range]);
    const patch = await this.git(["diff", "-M", "--no-color", "--unified=3", ...range], { maxBuffer: 50 * 1024 * 1024 });
    const status = new Map(names.split("\n").filter(Boolean).map(l => { const [s, ...paths] = l.split("\t"); return [paths.at(-1)!, s[0]]; }));
    const files = numstat.split("\n").filter(Boolean).map(parseNumstat).map(f => ({ ...f, status: ({ A: "added", D: "deleted", R: "renamed" } as const)[status.get(f.path) as "A" | "D" | "R"] ?? "modified" }));
    return { files, patch: patch.slice(0, MAX_PATCH), truncated: patch.length > MAX_PATCH };
  }
  /** What changed since the last checkpoint (uncheckpointed work). */
  async pending(): Promise<Diff> {
    const head = await this.git(["rev-parse", "--verify", "--quiet", "HEAD"]).catch(() => "");
    if (!head.trim()) return { files: [], patch: "", truncated: false };
    return this.diff("HEAD");
  }
  /** The changes a single checkpoint made relative to its parent. */
  async changesIn(commit: string): Promise<Diff> {
    const parent = await this.git(["rev-parse", "--verify", "--quiet", `${commit}^`]).then(s => s.trim(), () => "");
    return parent ? this.diff(parent, commit) : this.diff("4b825dc642cb6eb9a060e54bf8d69288fbee4904", commit);
  }

  /**
   * Puts every versioned file back as it was at `commit`: files added since are removed, deleted ones restored.
   * The current state is checkpointed first, so a restore can itself be undone.
   */
  async restore(commit: string, label: string): Promise<Checkpoint | undefined> {
    if (!/^[0-9a-f]{7,40}$/i.test(commit)) throw new Error("Invalid checkpoint");
    await this.git(["cat-file", "-e", `${commit}^{commit}`]);
    await this.checkpoint(`Before restoring: ${label}`, "system");
    await this.git(["read-tree", "-u", "--reset", commit]);
    return this.checkpoint(`Restored: ${label}`, "system");
  }
}

function parseNumstat(line: string): FileChange {
  const [added, removed, ...rest] = line.split("\t");
  let path = rest.join("\t");
  let oldPath: string | undefined;
  const brace = path.match(/^(.*)\{(.*) => (.*)\}(.*)$/);
  if (brace) { oldPath = `${brace[1]}${brace[2]}${brace[4]}`.replace(/\/\//g, "/"); path = `${brace[1]}${brace[3]}${brace[4]}`.replace(/\/\//g, "/"); }
  else if (path.includes(" => ")) [oldPath, path] = path.split(" => ");
  return { path, oldPath, status: oldPath ? "renamed" : "modified", added: added === "-" ? 0 : Number(added), removed: removed === "-" ? 0 : Number(removed) };
}
/** Git needs PATH and a few system variables; secrets in the server's environment are not passed on. */
function gitEnv(): NodeJS.ProcessEnv {
  const keep = ["PATH", "Path", "PATHEXT", "SystemRoot", "SYSTEMROOT", "WINDIR", "TEMP", "TMP", "HOME", "USERPROFILE", "HOMEDRIVE", "HOMEPATH", "LANG", "ComSpec"];
  return Object.fromEntries(keep.filter(k => process.env[k] !== undefined).map(k => [k, process.env[k]]));
}
