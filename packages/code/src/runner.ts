import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

export type RunStatus = "running" | "exited" | "failed" | "cancelled" | "timeout";
export interface RunEvent { type: "output"; stream: "stdout" | "stderr" | "system"; text: string }
export interface RunInfo {
  id: string; projectId: string; command: string; status: RunStatus; exitCode: number | null;
  startedAt: string; endedAt: string | null; kind: "command" | "server"; outputBytes: number; truncated: boolean;
}
export class CommandError extends Error {}

/** Programs a project command may start. Anything else is refused; there is no general shell. */
const ALLOWED = new Set(["node", "npm", "npx", "pnpm", "yarn", "tsc", "vite", "python", "python3", "py", "pip", "pip3", "pytest", "git", "deno", "bun", "go", "cargo", "javac", "java", "gcc", "g++", "make"]);
/** Git is limited to commands that only read the repository. */
const GIT_READ_ONLY = new Set(["status", "log", "diff", "show", "branch", "rev-parse", "ls-files", "blame", "shortlog", "describe", "remote"]);
/** Shell syntax that could chain, redirect or substitute commands. */
const SHELL_SYNTAX = /[&|;<>^`$%!()\r\n]/;
const MAX_OUTPUT = 1024 * 1024;

/** Splits a command line into arguments, honouring simple double or single quotes. */
export function parseCommand(line: string): string[] {
  const args: string[] = [];
  let current = "", quote = "";
  for (const ch of line.trim()) {
    if (quote) { if (ch === quote) quote = ""; else current += ch; }
    else if (ch === '"' || ch === "'") quote = ch;
    else if (/\s/.test(ch)) { if (current) { args.push(current); current = ""; } }
    else current += ch;
  }
  if (quote) throw new CommandError("Unclosed quote in the command");
  if (current) args.push(current);
  return args;
}
/** Validates a command and returns its arguments, or throws with a reason the user can act on. */
export function checkCommand(line: string): string[] {
  if (line.length > 1000) throw new CommandError("Command is too long");
  if (SHELL_SYNTAX.test(line)) throw new CommandError("Run one command at a time: shell operators such as && | ; > $ % ( ) are not allowed");
  const args = parseCommand(line);
  if (!args.length) throw new CommandError("Enter a command");
  const program = args[0].toLowerCase().replace(/\.(exe|cmd|bat)$/, "");
  if (!ALLOWED.has(program)) throw new CommandError(`"${args[0]}" is not an allowed command. Allowed: ${[...ALLOWED].join(", ")}`);
  if (program === "git" && !GIT_READ_ONLY.has(args[1] ?? "")) throw new CommandError(`Only read-only git commands are allowed here (${[...GIT_READ_ONLY].join(", ")}); use version history to save and restore`);
  if (args.some(a => /^[a-zA-Z]:[\\/]|^\/|^\.\.([\\/]|$)/.test(a) && !a.startsWith("--"))) throw new CommandError("Arguments may not point outside the project (no absolute paths or '..')");
  return args;
}
/** The environment for project commands: system basics only, never the server's keys or database URL. */
export function commandEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v === undefined || /(KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|DATABASE_URL|PRIVATE|SESSION|COOKIE|AUTH)/i.test(k)) continue;
    if (/^(PATH|PATHEXT|SYSTEMROOT|WINDIR|COMSPEC|TEMP|TMP|HOME|USERPROFILE|HOMEDRIVE|HOMEPATH|APPDATA|LOCALAPPDATA|PROGRAMDATA|PROGRAMFILES|PROGRAMFILES\(X86\)|NUMBER_OF_PROCESSORS|PROCESSOR_ARCHITECTURE|OS|LANG|LC_ALL|TERM|SHELL|USER|USERNAME|NODE_OPTIONS)$/i.test(k)) env[k] = v;
  }
  // Tools run non-interactively and do not try to open browsers or watch forever.
  return { ...env, CI: "true", BROWSER: "none", FORCE_COLOR: "0", NO_COLOR: "1", npm_config_yes: "true", ...extra };
}

interface Run { info: RunInfo; child: ChildProcess; events: RunEvent[]; listeners: Set<(e: RunEvent | { type: "end"; info: RunInfo }) => void>; timer?: NodeJS.Timeout }

/**
 * Runs allowlisted commands inside a project folder with a timeout, an output cap, cancellation (the whole
 * process tree), and a log file per run. Output is kept for replay so a page reload can reattach to a run.
 */
export class CommandRunner {
  private readonly runs = new Map<string, Run>();
  constructor(private readonly logsDir: (projectId: string) => string) {}

  start(opts: { projectId: string; cwd: string; command: string; timeoutMs?: number; kind?: "command" | "server"; env?: Record<string, string> }): RunInfo {
    const args = checkCommand(opts.command);
    const running = [...this.runs.values()].filter(r => r.info.projectId === opts.projectId && r.info.status === "running" && r.info.kind === "command");
    if ((opts.kind ?? "command") === "command" && running.length >= 2) throw new CommandError("Two commands are already running in this project; stop one first");
    const info: RunInfo = { id: randomUUID(), projectId: opts.projectId, command: opts.command, status: "running", exitCode: null, startedAt: new Date().toISOString(), endedAt: null, kind: opts.kind ?? "command", outputBytes: 0, truncated: false };
    // On Windows, npm/npx and friends are .cmd scripts, which Node only starts through cmd.exe. The command line has
    // already been checked for shell syntax, and each argument is quoted, so cmd.exe cannot interpret anything.
    const windows = process.platform === "win32";
    const child = windows
      ? spawn(args.map(a => (/[\s"]/.test(a) ? `"${a.replace(/"/g, "")}"` : a)).join(" "), { cwd: opts.cwd, env: commandEnv(opts.env), shell: true, windowsHide: true })
      : spawn(args[0], args.slice(1), { cwd: opts.cwd, env: commandEnv(opts.env), detached: true });
    const run: Run = { info, child, events: [], listeners: new Set() };
    this.runs.set(info.id, run);
    const emit = (stream: RunEvent["stream"], text: string) => {
      if (info.truncated) return;
      const room = MAX_OUTPUT - info.outputBytes;
      const slice = Buffer.byteLength(text) > room ? text.slice(0, room) : text;
      info.outputBytes += Buffer.byteLength(slice);
      const event: RunEvent = { type: "output", stream, text: slice };
      run.events.push(event);
      for (const l of run.listeners) l(event);
      if (info.outputBytes >= MAX_OUTPUT) {
        info.truncated = true;
        const note: RunEvent = { type: "output", stream: "system", text: "\n[output limit reached; further output is not shown]\n" };
        run.events.push(note);
        for (const l of run.listeners) l(note);
      }
    };
    emit("system", `$ ${opts.command}\n`);
    child.stdout?.setEncoding("utf8").on("data", (d: string) => emit("stdout", d));
    child.stderr?.setEncoding("utf8").on("data", (d: string) => emit("stderr", d));
    const timeoutMs = opts.timeoutMs ?? 120_000;
    if (timeoutMs > 0) run.timer = setTimeout(() => { if (info.status === "running") { info.status = "timeout"; emit("system", `\n[stopped after ${Math.round(timeoutMs / 1000)}s time limit]\n`); this.kill(run); } }, timeoutMs);
    const finish = (code: number | null, error?: Error) => {
      if (info.endedAt) return;
      clearTimeout(run.timer);
      if (error) emit("system", `\n[could not start: ${error.message}]\n`);
      if (info.status === "running") info.status = error ? "failed" : code === 0 ? "exited" : "failed";
      info.exitCode = code;
      info.endedAt = new Date().toISOString();
      emit("system", `\n[${info.status === "exited" ? "exited with code 0" : info.status === "failed" ? `exited with code ${code ?? "?"}` : info.status}]\n`);
      for (const l of run.listeners) l({ type: "end", info });
      run.listeners.clear();
      void this.writeLog(run);
      // Finished runs are kept briefly for replay, then forgotten (the log file stays).
      setTimeout(() => this.runs.delete(info.id), 30 * 60_000).unref();
    };
    child.on("error", error => finish(null, error));
    child.on("close", code => finish(code));
    return info;
  }

  get(id: string): RunInfo | undefined { return this.runs.get(id)?.info; }
  list(projectId: string): RunInfo[] { return [...this.runs.values()].map(r => r.info).filter(i => i.projectId === projectId).sort((a, b) => b.startedAt.localeCompare(a.startedAt)); }
  output(id: string): string { return (this.runs.get(id)?.events ?? []).map(e => e.text).join(""); }

  /** Replays output so far, then streams new output until the run ends; returns an unsubscribe function. */
  subscribe(id: string, listener: (e: RunEvent | { type: "end"; info: RunInfo }) => void): () => void {
    const run = this.runs.get(id);
    if (!run) return () => {};
    for (const e of run.events) listener(e);
    if (run.info.endedAt) { listener({ type: "end", info: run.info }); return () => {}; }
    run.listeners.add(listener);
    return () => run.listeners.delete(listener);
  }
  /** Waits for a run to finish (used by the agent). */
  wait(id: string): Promise<RunInfo> {
    return new Promise(resolve => this.subscribe(id, e => { if (e.type === "end") resolve(e.info); }));
  }
  cancel(id: string): boolean {
    const run = this.runs.get(id);
    if (!run || run.info.status !== "running") return false;
    run.info.status = "cancelled";
    this.kill(run);
    return true;
  }
  stopAll(projectId?: string) {
    for (const run of this.runs.values()) if (run.info.status === "running" && (!projectId || run.info.projectId === projectId)) { run.info.status = "cancelled"; this.kill(run); }
  }
  private kill(run: Run) {
    const pid = run.child.pid;
    if (!pid) return;
    // The whole tree is stopped: a dev server started by npm is a grandchild of the process we spawned.
    if (process.platform === "win32") spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], { windowsHide: true });
    else { try { process.kill(-pid, "SIGKILL"); } catch { run.child.kill("SIGKILL"); } }
  }
  private async writeLog(run: Run) {
    try {
      const dir = this.logsDir(run.info.projectId);
      await mkdir(dir, { recursive: true });
      await writeFile(join(dir, `${run.info.startedAt.replace(/[:.]/g, "-")}-${run.info.id.slice(0, 8)}.log`), `${JSON.stringify(run.info)}\n\n${run.events.map(e => e.text).join("")}`);
    } catch { /* logging must never break a run */ }
  }
}
