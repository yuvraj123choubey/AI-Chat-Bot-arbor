import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { createServer } from "node:net";
import { join } from "node:path";
import type { CommandRunner, RunInfo } from "./runner.ts";

export type ProjectKind = "static" | "vite" | "next" | "node" | "python" | "unknown";
export interface Detected { kind: ProjectKind; label: string; devCommand?: (port: number) => string; needsInstall: boolean; testCommand?: string; buildCommand?: string }
export interface PreviewState { kind: ProjectKind; status: "idle" | "installing" | "starting" | "running" | "failed" | "unsupported"; url?: string; port?: number; runId?: string; installRunId?: string; message?: string }

/** Works out what kind of project this is from its files, and how to run, test and build it. */
export async function detectProject(root: string): Promise<Detected> {
  const pkgPath = join(root, "package.json");
  if (existsSync(pkgPath)) {
    let pkg: any = {};
    try { pkg = JSON.parse(await readFile(pkgPath, "utf8")); } catch { /* malformed package.json: treated as plain node */ }
    const deps = { ...pkg.dependencies, ...pkg.devDependencies };
    const scripts = pkg.scripts ?? {};
    const needsInstall = Object.keys(deps).length > 0 && !existsSync(join(root, "node_modules"));
    const testCommand = scripts.test && !/no test specified/.test(scripts.test) ? "npm test" : undefined;
    const buildCommand = scripts.build ? "npm run build" : undefined;
    if (deps.next) return { kind: "next", label: "Next.js", needsInstall, testCommand, buildCommand, devCommand: port => `npx next dev -p ${port} -H 127.0.0.1` };
    if (deps.vite) return { kind: "vite", label: deps.react ? "Vite + React" : "Vite", needsInstall, testCommand, buildCommand, devCommand: port => `npx vite --port ${port} --host 127.0.0.1 --strictPort` };
    if (scripts.start || scripts.dev) return { kind: "node", label: "Node.js", needsInstall, testCommand, buildCommand, devCommand: () => (scripts.dev ? "npm run dev" : "npm start") };
    if (existsSync(join(root, "index.html"))) return { kind: "static", label: "HTML/CSS/JS", needsInstall: false, testCommand, buildCommand };
    return { kind: "node", label: "Node.js", needsInstall, testCommand, buildCommand };
  }
  if (existsSync(join(root, "index.html"))) return { kind: "static", label: "HTML/CSS/JS", needsInstall: false };
  if (["main.py", "app.py", "requirements.txt", "pyproject.toml"].some(f => existsSync(join(root, f)))) {
    return { kind: "python", label: "Python", needsInstall: false, testCommand: existsSync(join(root, "tests")) || existsSync(join(root, "test")) ? "python -m pytest" : undefined };
  }
  return { kind: "unknown", label: "Files", needsInstall: false };
}

async function freePort(from = 5400, to = 5499): Promise<number> {
  for (let port = from; port <= to; port++) {
    const free = await new Promise<boolean>(resolve => { const s = createServer().once("error", () => resolve(false)).listen(port, "127.0.0.1", () => s.close(() => resolve(true))); });
    if (free) return port;
  }
  throw new Error("No free preview port");
}
async function respond(url: string): Promise<boolean> {
  try { const r = await fetch(url, { signal: AbortSignal.timeout(2000) }); return r.status < 500; } catch { return false; }
}

/**
 * Live preview per project. Static sites need no process (the API serves them into a sandboxed frame); framework
 * projects get their dependencies installed if missing and a dev server on a free local port. A server that dies
 * is reported with its output, so the user or the agent can see the error.
 */
export class Previews {
  private readonly states = new Map<string, PreviewState>();
  constructor(private readonly runner: CommandRunner) {}

  get(projectId: string): PreviewState | undefined {
    const state = this.states.get(projectId);
    if (state?.runId && state.status === "running") {
      const run = this.runner.get(state.runId);
      if (run && run.status !== "running") { state.status = "failed"; state.message = "The dev server stopped. See its output in the terminal."; }
    }
    return state;
  }

  async start(projectId: string, root: string, staticUrl: string): Promise<PreviewState> {
    this.stop(projectId);
    const detected = await detectProject(root);
    if (detected.kind === "static") return this.set(projectId, { kind: "static", status: "running", url: staticUrl });
    if (!detected.devCommand) return this.set(projectId, { kind: detected.kind, status: "unsupported", message: detected.kind === "python" ? "Python projects can be run from the terminal; there is no web preview for them yet." : "This project has no index.html or dev server to preview." });
    const state = this.set(projectId, { kind: detected.kind, status: detected.needsInstall ? "installing" : "starting" });
    void (async () => {
      try {
        if (detected.needsInstall) {
          const install = this.runner.start({ projectId, cwd: root, command: "npm install", timeoutMs: 10 * 60_000 });
          state.installRunId = install.id;
          const done = await this.runner.wait(install.id);
          if (done.status !== "exited") { state.status = "failed"; state.message = "Installing dependencies failed. See the output."; return; }
          state.status = "starting";
        }
        const port = await freePort();
        const run: RunInfo = this.runner.start({ projectId, cwd: root, command: detected.devCommand!(port), kind: "server", timeoutMs: 0, env: { PORT: String(port), HOST: "127.0.0.1" } });
        Object.assign(state, { runId: run.id, port });
        const url = `http://127.0.0.1:${port}/`;
        for (let i = 0; i < 90; i++) {
          if (this.states.get(projectId) !== state) return;
          if (this.runner.get(run.id)?.status !== "running") { state.status = "failed"; state.message = "The dev server exited before it was ready. See the output."; return; }
          if (await respond(url)) { state.status = "running"; state.url = url; return; }
          await new Promise(r => setTimeout(r, 1000));
        }
        state.status = "failed";
        state.message = "The dev server did not respond within 90 seconds.";
      } catch (error) {
        state.status = "failed";
        state.message = error instanceof Error ? error.message : "Preview failed";
      }
    })();
    return state;
  }
  stop(projectId: string) {
    const state = this.states.get(projectId);
    if (state?.runId) this.runner.cancel(state.runId);
    if (state?.installRunId) this.runner.cancel(state.installRunId);
    this.states.delete(projectId);
  }
  private set(projectId: string, state: PreviewState): PreviewState { this.states.set(projectId, state); return state; }
}
