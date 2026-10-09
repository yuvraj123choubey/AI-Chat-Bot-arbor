import type { Message } from "../../ai/src/types.ts";
import { detectChecks, needsInstall, pytestMissing, type Check } from "./checks.ts";
import type { Diff, ProjectHistory } from "./history.ts";
import { applyEdits, type Edit } from "./patch.ts";
import { detectProject } from "./preview.ts";
import { describeFile, findSymbol, indexRepo, relevantFiles, type RepoIndex } from "./repo-index.ts";
import type { CommandRunner, RunInfo } from "./runner.ts";
import { checkCommand } from "./runner.ts";
import { describeLayout, viewPage, type ViewportName } from "./browser.ts";
import { introducedSyntaxError } from "./syntax.ts";
import type { ProjectFiles } from "./workspace.ts";
import { cleanRelative } from "./paths.ts";
import { isQuestion, looksLikeBugReport } from "./intent.ts";

type Note = { note: string };
export type PlanStep = { step: string; status: "todo" | "doing" | "done" };
export type AgentAction = (
  | { action: "update_plan"; plan: PlanStep[] }
  | { action: "list_directory"; path: string }
  | { action: "read_file"; path: string }
  | { action: "read_range"; path: string; start_line: number; end_line: number }
  | { action: "search_code"; query: string }
  | { action: "find_symbol"; name: string }
  | { action: "find_references"; name: string }
  | { action: "inspect_dependencies"; path: string }
  | { action: "apply_patch"; path: string; edits: Edit[] }
  | { action: "create_file"; path: string; content: string }
  | { action: "write_file"; path: string; content: string }
  | { action: "delete_file"; path: string }
  | { action: "rename_file"; path: string; new_path: string }
  | { action: "rename_symbol"; from: string; to: string }
  | { action: "run_command"; command: string }
  | { action: "run_tests" } | { action: "run_build" } | { action: "run_checks" } | { action: "run_typecheck" } | { action: "run_lint" }
  | { action: "git_status" } | { action: "git_diff"; path: string }
  | { action: "checkpoint"; label: string } | { action: "revert" }
  | { action: "view_page"; path: string; click: string; viewport?: "desktop" | "mobile" | "both" }
  | { action: "finish"; summary: string }
) & Partial<Note>;

export interface AgentEvent { kind: "plan" | "inspect" | "read" | "search" | "edit" | "run" | "check" | "state" | "finish" | "error"; title: string; detail?: string; state?: MemoryView }
export interface MemoryView { goal: string; plan: PlanStep[]; relevant: { path: string; reason: string }[]; edits: { path: string; summary: string }[]; commands: { command: string; status: string }[]; failures: string[]; remainingChecks: string[] }
export interface AgentDeps {
  files: ProjectFiles; history: ProjectHistory; runner: CommandRunner; projectId: string;
  /** Asks the model for the next action; any model behind the AI provider layer can be used. */
  next(messages: Message[]): Promise<AgentAction>;
  event(e: AgentEvent): void;
  /** URL of a running dev server, for view_page on framework projects. */
  pageUrl?: () => string | undefined;
  signal?: AbortSignal;
  now?: () => number;
}
export interface AgentMetrics { success: boolean; finished: boolean; checksPassing: boolean | null; filesChanged: number; linesAdded: number; linesRemoved: number; retries: number; checkRuns: number; steps: number; elapsedMs: number; finalChecks: { name: string; status: string }[] }
export interface AgentResult { summary: string; baseCommit?: string; commit?: string; diff?: Diff; steps: number; edited: string[]; commands: { command: string; status: string; exitCode: number | null }[]; stoppedEarly: boolean; metrics: AgentMetrics }

const s = { type: "string" } as const;
const variant = (action: string, props: Record<string, unknown> = {}) => ({ type: "object", properties: { action: { const: action }, note: s, ...props } });
/** One variant per tool, so a constrained local model can only produce well-formed calls with exactly the fields each tool needs. */
export const actionSchema = {
  oneOf: [
    variant("update_plan", { plan: { type: "array", items: { type: "object", properties: { step: s, status: { enum: ["todo", "doing", "done"] } } } } }),
    variant("list_directory", { path: s }), variant("read_file", { path: s }),
    variant("read_range", { path: s, start_line: { type: "integer" }, end_line: { type: "integer" } }),
    variant("search_code", { query: s }), variant("find_symbol", { name: s }), variant("find_references", { name: s }), variant("inspect_dependencies", { path: s }),
    variant("apply_patch", { path: s, edits: { type: "array", items: { type: "object", properties: { find: s, replace: s } } } }),
    variant("create_file", { path: s, content: s }), variant("write_file", { path: s, content: s }), variant("delete_file", { path: s }), variant("rename_file", { path: s, new_path: s }), variant("rename_symbol", { from: s, to: s }),
    variant("run_command", { command: s }), variant("run_tests"), variant("run_build"), variant("run_checks"), variant("run_typecheck"), variant("run_lint"),
    variant("git_status"), variant("git_diff", { path: s }), variant("checkpoint", { label: s }), variant("revert"),
    variant("view_page", { path: s, click: s, viewport: { enum: ["desktop", "mobile", "both"] } }), variant("finish", { summary: s })
  ]
};

/** Names other coding agents use for the same tools. */
const aliases: Record<string, string> = {
  inspect_git_status: "git_status", inspect_diff: "git_diff", create_checkpoint: "checkpoint", revert_checkpoint: "revert",
  open_preview: "view_page", inspect_browser: "view_page", run_typecheck_check: "run_typecheck", read: "read_file", grep: "search_code", ls: "list_directory"
};

/** Checks a model reply and turns it into an action, or says what is wrong with it (fed back for a retry). */
export function validateAction(data: any): AgentAction | string {
  const str = (v: unknown) => (typeof v === "string" ? v : undefined);
  const note = str(data?.note)?.slice(0, 300);
  const need = (...keys: string[]) => keys.find(k => str(data?.[k]) === undefined);
  const a = aliases[data?.action] ?? data?.action;
  switch (a) {
    case "update_plan": {
      const plan = Array.isArray(data.plan) ? data.plan.filter((p: any) => str(p?.step)).map((p: any) => ({ step: p.step.slice(0, 200), status: ["todo", "doing", "done"].includes(p.status) ? p.status : "todo" })).slice(0, 12) : [];
      return plan.length ? { action: a, plan, note } : "update_plan needs a non-empty plan";
    }
    case "list_directory": return { action: a, path: str(data.path) ?? "", note };
    case "read_file": case "delete_file": return need("path") ? `${a} needs path` : { action: a, path: data.path, note };
    case "read_range": return need("path") || !Number.isFinite(data.start_line) ? "read_range needs path, start_line, end_line" : { action: a, path: data.path, start_line: Math.max(1, Math.floor(data.start_line)), end_line: Math.floor(data.end_line) || Math.floor(data.start_line) + 200, note };
    case "search_code": return str(data.query)?.trim() ? { action: a, query: data.query, note } : "search_code needs a query";
    case "find_symbol": case "find_references": return str(data.name)?.trim() ? { action: a, name: data.name.trim(), note } : `${a} needs a name`;
    case "inspect_dependencies": return { action: a, path: str(data.path) ?? "", note };
    case "rename_symbol": {
      const ident = /^[A-Za-z_$][\w$]*$/;
      const from = str(data.from)?.trim(), to = str(data.to)?.trim();
      return from && to && ident.test(from) && ident.test(to) && from !== to ? { action: a, from, to, note } : "rename_symbol needs from and to: two different identifiers (letters, digits, _ or $)";
    }
    case "rename_file": return need("path") || !str(data.new_path ?? data.to)?.trim() ? "rename_file needs path and new_path" : { action: a, path: data.path, new_path: (data.new_path ?? data.to).trim(), note };
    case "apply_patch": {
      const edits = Array.isArray(data.edits) ? data.edits.filter((e: any) => str(e?.find) !== undefined && str(e?.replace) !== undefined) : [];
      return need("path") || !edits.length ? "apply_patch needs path and edits [{find, replace}]" : { action: a, path: data.path, edits: edits.map((e: any) => ({ find: e.find, replace: e.replace })), note };
    }
    case "create_file": case "write_file": return need("path", "content") ? `${a} needs path and content` : { action: a, path: data.path, content: data.content, note };
    case "run_command": return str(data.command)?.trim() ? { action: a, command: data.command.trim(), note } : "run_command needs a command";
    case "run_tests": case "run_build": case "run_checks": case "run_typecheck": case "run_lint": case "git_status": case "revert": return { action: a, note };
    case "git_diff": return { action: a, path: str(data.path) ?? "", note };
    case "checkpoint": return { action: a, label: str(data.label)?.trim() || "Checkpoint", note };
    case "view_page": return { action: a, path: str(data.path) ?? "", click: str(data.click) ?? "", viewport: ["mobile", "both"].includes(data.viewport) ? data.viewport : "desktop", note };
    case "finish": return { action: a, summary: str(data.summary)?.trim() || note || "Done.", note };
    default: return `action must be one of ${actionSchema.oneOf.map(v => (v.properties.action as { const: string }).const).join(", ")}`;
  }
}

/** Lines removed and added between two versions, counted as a multiset difference (enough for metrics and summaries). */
function lineChanges(before: string[], after: string[]): { added: number; removed: number } {
  const counts = new Map<string, number>();
  for (const l of before) counts.set(l, (counts.get(l) ?? 0) + 1);
  let added = 0;
  for (const l of after) { const n = counts.get(l) ?? 0; if (n) counts.set(l, n - 1); else added++; }
  return { added, removed: [...counts.values()].reduce((a, b) => a + b, 0) };
}
const numbered = (lines: string[], from = 1) => lines.map((l, i) => `${String(i + from).padStart(4)}| ${l}`).join("\n");
const clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, max)}\n… [${text.length - max} more characters]` : text);
const tail = (text: string, max: number) => (text.length > max ? `[… earlier output omitted]\n${text.slice(-max)}` : text);
/** What identifies a failure across runs: its first error lines, without temp paths, timings or line numbers. */
export function failureKey(output: string): string {
  return failureDigest(output, 400).split("\n").slice(0, 2).join(" ")
    .replace(/file:\/\/\/?\S+?\/(?=[\w.-]+\.\w+)/g, "").replace(/[A-Za-z]:\\\S+\\/g, "").replace(/\(\d+(\.\d+)?ms\)/g, "").replace(/:\d+(:\d+)?/g, "").replace(/\s+/g, " ").trim();
}

/** The most informative lines of a failing command: errors, assertion messages, file:line references. */
export function failureDigest(output: string, max = 600): string {
  const lines = output.split("\n").filter(l => /error|fail|assert|expected|actual|not ok|traceback|exception|cannot|undefined|✖|×|\w+\.\w+:\d+/i.test(l) && !/^\s*(at\s+(node:|internal\/)|ℹ)/.test(l));
  return clip((lines.length ? lines : output.trim().split("\n").slice(-12)).map(l => l.trim()).filter(Boolean).slice(0, 14).join("\n"), max);
}

export function agentSystemPrompt(): string {
  return [
    "You are Arbor's coding agent. You work inside one real project and act only through tools. Work like a strong senior engineer:",
    "INSPECT: never assume a file, function, route, dependency or framework exists. Use list_directory, search_code, find_symbol and read_file to look first. For an error, find the file and line it names and read that code.",
    "UNDERSTAND: before changing a function, find_references shows every place that uses it (rename_symbol renames an identifier everywhere at once); inspect_dependencies shows what a file imports and who imports it, or the project's packages and scripts. Follow the patterns the code already uses.",
    "PLAN: for anything beyond a one-line fix, call update_plan with short steps, and update it as steps are done.",
    "EDIT: make the smallest correct change with apply_patch. Each edit's `find` is copied exactly from read_file output (without the line-number prefix) and must be unique; include a few surrounding lines. For a small file (under 200 lines) that needs several changes, write_file with its complete new content is safer than many patches. Use create_file only for new files. Do not rewrite or reformat unrelated code. Follow the project's existing style and structure.",
    "REPRODUCE: for a reported bug, if the existing tests pass they do not cover it. First read the module under test so the test uses its real exports, then add a small test for the exact reported case (patch the existing test file, or create_file for a new one in the same style), run it to see it fail, then fix the code until it passes. Fix the root cause in the module that computes the value, not a workaround where it is displayed.",
    "VERIFY: after editing, run_tests (or run_checks for tests, typecheck, lint and build). Read failures, fix the cause, and run again until they pass. run_typecheck and run_lint run just those checks. For web pages, view_page shows what renders, console errors and whether the layout fits; use viewport \"mobile\" or \"both\" for layout and responsive work. Never repeat a failed action unchanged: read the error and change the approach.",
    "FINISH: call finish with a short summary of what changed, which checks pass, and anything still failing or not verified. You cannot finish while checks you broke are failing unless you explain why you are blocked.",
    "If the task is unclear or impossible in this project, inspect enough to explain why, then finish without editing.",
    "Reply with exactly one JSON tool call per turn. `note` is one short sentence shown to the user describing what you are doing (not private reasoning). Paths are relative to the project root."
  ].join("\n");
}

/** Facts about the project that every turn starts from; no file contents, so the model must read what it needs. */
export async function projectOverview(files: ProjectFiles, index?: RepoIndex, checks?: Check[]): Promise<string> {
  const idx = index ?? await indexRepo(files);
  const detected = await detectProject(files.root);
  const paths = [...idx.files.keys()];
  const found = checks ?? await detectChecks(files.root, paths);
  return [
    `Project type: ${detected.label}.`,
    found.length ? `Checks: ${found.map(c => `${c.name} = \`${c.command}\``).join("; ")}.` : "No test, typecheck, lint or build command detected.",
    idx.packages.length ? `Dependencies: ${idx.packages.slice(0, 30).join(", ")}.` : "",
    `Files (${paths.length}${paths.length > 200 ? ", first 200" : ""}):\n${paths.slice(0, 200).join("\n") || "(empty project)"}`
  ].filter(Boolean).join("\n");
}

/** file:line references in an error message or task text, so the agent starts at the failing code. */
/**
 * Where a failure points: the first project file and line in the output, preferring source files over test files
 * (a failing test usually reports the test's line first, but the cause is in the code it calls).
 */
export function failureLocation(output: string, paths: Set<string>): { path: string; line: number } | undefined {
  const found: { path: string; line: number }[] = [];
  for (const m of output.matchAll(/([\w./\\-]+\.(?:[jt]sx?|mjs|cjs|py|java|go|rs|rb|php|cs|c|cpp|h|vue|svelte))(?::|", line |\()(\d+)/g)) {
    const rel = m[1].replace(/\\/g, "/").replace(/^\.?\//, "");
    const hit = [...paths].find(p => p === rel || p.endsWith(`/${rel}`) || rel.endsWith(`/${p}`));
    if (hit) found.push({ path: hit, line: Number(m[2]) });
  }
  return found.find(f => !isTestFile(f.path)) ?? found[0];
}

export function referencedFiles(text: string, paths: Set<string>): string[] {
  const out = new Set<string>();
  for (const m of text.matchAll(/([\w./\\-]+\.(?:[jt]sx?|mjs|cjs|py|java|go|rs|rb|php|cs|c|cpp|h|css|html|json|vue|svelte))(?::(\d+))?/g)) {
    const rel = m[1].replace(/\\/g, "/").replace(/^\.?\//, "");
    const hit = [...paths].find(p => p === rel || p.endsWith(`/${rel}`) || rel.endsWith(`/${p}`));
    if (hit) out.add(hit);
  }
  return [...out];
}

/** Test files by the usual conventions (JS/TS, Python, Go, Java). */
export const isTestFile = (path: string) => /(^|\/)(tests?|__tests__|spec)\/|\.(test|spec)\.[a-z]+$|(^|\/)test_[^/]+\.py$|_test\.(py|go)$|Test\.java$/i.test(path);

/** Tools that only look; repeating one before anything has changed returns the same answer. */
/** Tasks about how a page is laid out on different screens. */
const layoutTask = /\b(responsive|mobile|phones?|small screens?|narrow screens?|tablets?|screen sizes?|media quer(y|ies)|breakpoints?|viewport)\b/i;

const inspectActions = new Set<AgentAction["action"]>(["read_file", "read_range", "list_directory", "search_code", "find_symbol", "find_references", "inspect_dependencies", "git_status", "git_diff", "update_plan"]);

/**
 * The agent loop: inspect → plan → edit → run → observe → fix → retest. Each turn the model sees the project
 * overview, a compact task memory (goal, plan, relevant files, edits, commands, failures, remaining checks) and
 * only the last few tool results in full, so long tasks fit a small local model. Finishing is gated on the
 * project's own checks after any edit. Everything the agent does is one revertible checkpoint.
 */
export async function runAgent(deps: AgentDeps, task: string, context = "", maxSteps = 30): Promise<AgentResult> {
  const { files, history, runner } = deps;
  const now = deps.now ?? Date.now;
  const started = now();
  await history.checkpoint(`Before agent: ${task.slice(0, 120)}`, "system");
  const baseCommit = (await history.log(1))[0]?.commit;
  let index = await indexRepo(files);
  const checks = await detectChecks(files.root, [...index.files.keys()]);
  const paths = new Set(index.files.keys());
  const named = referencedFiles(`${task}\n${context}`, paths).map(path => ({ path, reason: "named in the task or error" }));
  const memory = {
    goal: task, plan: [] as PlanStep[],
    relevant: [...named, ...relevantFiles(index, `${task}\n${context}`, 8).filter(r => !named.some(n => n.path === r.path))].slice(0, 10),
    read: new Set<string>(), edits: [] as { path: string; summary: string }[],
    commands: [] as { command: string; status: string; exitCode: number | null }[], failures: [] as string[],
    checkState: new Map<string, { status: "pending" | "passed" | "failed"; afterEdit: boolean }>(checks.map(c => [c.name, { status: "pending", afterEdit: false }]))
  };
  let lastEditAt = -1, step = 0, checkRuns = 0, retries = 0, blockedFinishes = 0, lastFailedRun = -1;
  let lastGreen: string | undefined, greenEdits = 0, sameFailure = { key: "", count: 0 }, editVersion = 0;
  const linesChanged = { added: 0, removed: 0 };
  const recent: Message[] = [];
  let lastSignature = "", lastAction = "", idleSteps = 0, freeSkips = 0;
  const seenSinceEdit = new Set<string>();
  const emitState = () => deps.event({ kind: "state", title: "Task state", state: view() });
  const view = (): MemoryView => ({
    goal: memory.goal, plan: memory.plan, relevant: memory.relevant, edits: memory.edits.slice(-20),
    commands: memory.commands.slice(-10).map(c => ({ command: c.command, status: c.status })), failures: memory.failures.slice(-5),
    remainingChecks: checks.filter(c => memory.checkState.get(c.name)?.status !== "passed" || !memory.checkState.get(c.name)?.afterEdit).filter(() => memory.edits.length > 0).map(c => c.command)
  });

  // Install declared dependencies first so checks fail only for real reasons.
  if (await needsInstall(files.root)) {
    deps.event({ kind: "run", title: "Installing dependencies (npm install)" });
    const done = await runCommand("npm install", 10 * 60_000);
    if (done.status !== "exited") memory.failures.push(`npm install failed: ${failureDigest(runner.output(done.id), 300)}`);
  }
  // A baseline run of every check shows the current state; a bug fix or build repair starts from the real error.
  const baselineLines: string[] = [];
  for (const check of checks) {
    deps.event({ kind: "check", title: `Baseline: ${check.command}` });
    const run = await runCheck(check, false);
    baselineLines.push(`${check.command}: ${run.passed ? "passing" : `FAILING\n${failureDigest(run.output, 900)}`}`);
  }
  const testsPassAtStart = checks.some(c => c.name === "test") && memory.checkState.get("test")?.status === "passed";
  const reproduce = looksLikeBugReport(task) && testsPassAtStart ? "\nNOTE: the tests pass but the task reports a bug, so the tests do not cover it. Add a test that reproduces the report, see it fail, then fix the root cause." : "";
  const baseline = baselineLines.length ? `BASELINE (before any change):\n${baselineLines.join("\n")}${reproduce}` : "";
  let noChangeFinishes = 0, reproFinishes = 0;
  // Browser gates: the edit version last checked, what was still wrong, and how often the agent was sent back.
  let pageCheckedAt = -1, layoutCheckedAt = -1, pageProblem = "", layoutProblem = "", gateRejections = 0, gateFailed = false;
  const overview = await projectOverview(files, index, checks);
  emitState();
  deps.event({ kind: "inspect", title: `Indexed ${index.files.size} files`, detail: memory.relevant.slice(0, 4).map(r => r.path).join(", ") || undefined });

  let summary = "", finished = false;
  for (; step < maxSteps; step++) {
    deps.signal?.throwIfAborted();
    const messages: Message[] = [
      { role: "system", content: agentSystemPrompt() },
      { role: "user", content: [`TASK: ${task}`, context ? `CONTEXT:\n${clip(context, 5000)}` : "", `PROJECT:\n${overview}`, baseline, `MEMORY:\n${renderMemory()}`, await renderWorkingSet(), `Step ${step + 1} of at most ${maxSteps}. Choose the next tool call.`].filter(Boolean).join("\n\n") },
      ...recent.slice(-6)
    ];
    const action = await deps.next(messages);
    let result: string;
    // Small models tend to loop. Looking at the same thing again before anything has changed, or a second plan
    // update in a row, does nothing and says so; a long run of looking without acting gets a push to act.
    const signature = JSON.stringify({ ...action, note: undefined });
    const inspecting = inspectActions.has(action.action);
    const repeated = inspecting ? seenSinceEdit.has(signature) : signature === lastSignature && !["run_tests", "run_build", "run_checks", "run_command", "finish"].includes(action.action);
    const replanning = action.action === "update_plan" && lastAction === "update_plan";
    lastSignature = signature;
    lastAction = action.action;
    idleSteps = inspecting ? idleSteps + 1 : 0;
    if (repeated || replanning) {
      result = repeated ? "ERROR: you already did exactly this and nothing has changed since; its result is in MEMORY and the WORKING SET. Take the next step instead (for example apply_patch on a file in the WORKING SET, or run_tests)." : "ERROR: the plan is already saved. Do the next step of the plan now.";
      deps.event({ kind: "error", title: repeated ? "Skipped a repeated action" : "Skipped a repeated plan update" });
      // A skipped repeat does not use up the step budget (up to a cap), so one stubborn loop cannot end the task.
      if (freeSkips < 8) { freeSkips++; step--; }
    } else try { result = await perform(action); }
    catch (error) {
      if (deps.signal?.aborted) throw error;
      result = `ERROR: ${error instanceof Error ? error.message : String(error)}`;
      deps.event({ kind: "error", title: `${action.action} failed`, detail: result.slice(7, 300) });
    }
    if (finished) break;
    if (inspecting) seenSinceEdit.add(signature);
    if (idleSteps >= 8) result += `\n\nYou have only looked and planned for ${idleSteps} steps. You have enough context: apply_patch a file in the WORKING SET now, run_tests to reproduce the problem, or finish explaining why no change is possible.`;
    recent.push({ role: "assistant", content: JSON.stringify(action) }, { role: "user", content: `RESULT of ${action.action}:\n${result}` });
    // Older results stay only as memory; the window keeps the latest three exchanges verbatim.
    if (recent.length > 6) recent.splice(0, recent.length - 6);
  }
  const stoppedEarly = !finished;
  if (stoppedEarly) summary = `Stopped after ${maxSteps} steps without finishing. ${memory.edits.length ? "Changes so far are kept and can be reverted." : "No files were changed."}`;
  // Final verification state for the metrics (re-run only if edits happened after the last check).
  if (memory.edits.length && checks.length && [...memory.checkState.values()].some(c => !c.afterEdit)) await runChecks();
  index = await indexRepo(files);
  const checkpoint = await history.checkpoint(`Arbor agent: ${task.slice(0, 120)}`, "agent");
  // Nothing new since a checkpoint taken during the run (e.g. when all checks passed): that commit is the result.
  const finalCommit = checkpoint?.commit ?? (lastGreen || memory.edits.length ? (await history.log(1))[0]?.commit : undefined);
  const diff = finalCommit && baseCommit && finalCommit !== baseCommit ? await history.diff(baseCommit, finalCommit) : undefined;
  const finalChecks = checks.map(c => ({ name: c.name, status: memory.checkState.get(c.name)!.status }));
  const checksPassing = checks.length && memory.edits.length ? finalChecks.every(c => c.status === "passed") : null;
  const metrics: AgentMetrics = {
    success: finished && checksPassing !== false && !gateFailed && (Boolean(diff?.files.length) || isQuestion(task) || !summary.startsWith("No files were changed")), finished, checksPassing, filesChanged: diff?.files.length ?? 0,
    linesAdded: diff?.files.reduce((n, f) => n + f.added, 0) ?? linesChanged.added, linesRemoved: diff?.files.reduce((n, f) => n + f.removed, 0) ?? linesChanged.removed,
    retries, checkRuns, steps: step, elapsedMs: now() - started, finalChecks
  };
  deps.event({ kind: "finish", title: stoppedEarly ? "Stopped" : checksPassing === false ? "Finished with failing checks" : "Finished", detail: summary.slice(0, 400) });
  emitState();
  return { summary, baseCommit, commit: finalCommit, diff, steps: step, edited: memory.edits.map(e => e.path).filter((p, i, a) => a.indexOf(p) === i), commands: memory.commands, stoppedEarly, metrics };

  /**
   * The current, numbered content of files the agent has read or edited (most recent first, within a size budget),
   * so it can patch accurately without re-reading and never works from a stale copy.
   */
  async function renderWorkingSet(): Promise<string> {
    let budget = 14_000;
    const parts: string[] = [];
    for (const path of [...memory.read].reverse()) {
      const file = await files.read(path).catch(() => undefined);
      if (!file || file.binary || file.content === null) continue;
      const lines = file.content.split("\n");
      const body = numbered(lines);
      if (body.length > budget) { parts.push(`--- ${path} (${lines.length} lines; too large to show here, use read_range)`); continue; }
      budget -= body.length;
      parts.push(`--- ${path} (${lines.length} lines, current content)\n${body}`);
    }
    return parts.length ? `WORKING SET (files you have opened, as they are now):\n${parts.join("\n")}` : "";
  }
  function renderMemory(): string {
    const v = view();
    const parts = [
      v.plan.length ? `Plan:\n${v.plan.map(p => `- [${p.status === "done" ? "x" : p.status === "doing" ? "~" : " "}] ${p.step}`).join("\n")}` : "Plan: (none yet)",
      v.relevant.length ? `Likely relevant files:\n${v.relevant.map(r => `- ${describeFile(index, r.path)} — ${r.reason}`).join("\n")}` : "",
      memory.read.size ? `Files read: ${[...memory.read].slice(-15).join(", ")}` : "",
      v.edits.length ? `Edits made:\n${v.edits.map(e => `- ${e.path}: ${e.summary}`).join("\n")}` : "Edits made: none",
      v.commands.length ? `Commands: ${v.commands.map(c => `${c.command} → ${c.status}`).join("; ")}` : "",
      v.failures.length ? `Latest failures:\n${v.failures.join("\n---\n")}` : "",
      checks.length && memory.edits.length ? `Checks after your edits: ${checks.map(c => `${c.name} ${memory.checkState.get(c.name)!.afterEdit ? memory.checkState.get(c.name)!.status : "not yet run"}`).join(", ")}` : ""
    ];
    return parts.filter(Boolean).join("\n");
  }
  async function runCommand(command: string, timeoutMs = 180_000): Promise<RunInfo> {
    const run = runner.start({ projectId: deps.projectId, cwd: files.root, command, timeoutMs });
    const abort = () => runner.cancel(run.id);
    deps.signal?.addEventListener("abort", abort, { once: true });
    const done = await runner.wait(run.id);
    deps.signal?.removeEventListener("abort", abort);
    memory.commands.push({ command, status: done.status, exitCode: done.exitCode });
    return done;
  }
  async function runCheck(check: Check, afterEdit = memory.edits.length > 0): Promise<{ passed: boolean; output: string }> {
    let done = await runCommand(check.command);
    let output = runner.output(done.id);
    if (done.status !== "exited" && check.command.includes("pytest") && pytestMissing(output)) {
      done = await runCommand("python -m unittest discover -v");
      output = runner.output(done.id);
    }
    const passed = done.status === "exited";
    checkRuns++;
    memory.checkState.set(check.name, { status: passed ? "passed" : "failed", afterEdit });
    if (!passed) {
      memory.failures.push(`${check.command}: ${failureDigest(output)}`);
      // Files the failure names join the working set, so the next step sees the code it is failing against.
      for (const path of referencedFiles(output, new Set(index.files.keys())).slice(0, 3)) memory.read.add(path);
      if (afterEdit) lastFailedRun = step;
    }
    deps.event({ kind: "check", title: `${check.command} → ${passed ? "passed" : done.status === "timeout" ? "timed out" : "failed"}`, detail: passed ? undefined : failureDigest(output, 300) });
    return { passed, output };
  }
  async function runChecks(names?: Check["name"][]): Promise<string> {
    const chosen = checks.filter(c => !names || names.includes(c.name));
    if (!chosen.length) return names ? `This project has no ${names.join("/")} command. Available: ${checks.map(c => c.command).join(", ") || "none"}. Use run_command to run something specific.` : "No checks are configured for this project.";
    const out: string[] = [];
    let failure = "";
    for (const c of chosen) {
      const r = await runCheck(c);
      const at = r.passed ? undefined : failureLocation(r.output, new Set(index.files.keys()));
      const lastEdited = memory.edits.findLast(e => !e.path.startsWith("("))?.path;
      const hint = at ? `\nTHE ERROR POINTS AT: ${at.path} line ${at.line}.${lastEdited && lastEdited !== at.path ? ` Your last edit was to ${lastEdited}; the problem to fix is in ${at.path}.` : ""}` : "";
      out.push(`${c.command}: ${r.passed ? "PASSED" : `FAILED\n${tail(r.output, 3500)}${hint}`}`);
      if (!r.passed && !failure) failure = `${c.name}:${failureKey(r.output)}`;
    }
    if (memory.edits.length) {
      const state = (name: string) => memory.checkState.get(name)!;
      if (checks.every(c => state(c.name).status === "passed" && state(c.name).afterEdit)) {
        // Every check passes after the agent's edits: remember this state to fall back to.
        lastGreen = (await history.checkpoint(`Agent: all checks passing (${memory.edits.length} edit(s))`, "agent"))?.commit ?? (await history.log(1))[0]?.commit;
        greenEdits = memory.edits.length;
        sameFailure = { key: "", count: 0 };
      } else if (failure) {
        sameFailure = failure === sameFailure.key ? { key: failure, count: sameFailure.count + 1 } : { key: failure, count: 1 };
        if (sameFailure.count >= 3) out.push(await recoverFromLoop());
      }
    }
    emitState();
    return out.join("\n\n");
  }
  /**
   * The same failure three times in a row means the agent is stuck. If all checks passed at some point after its
   * edits, the files go back to that state (the later edits are undone); otherwise it is told to change approach.
   */
  async function recoverFromLoop(): Promise<string> {
    sameFailure = { key: "", count: 0 };
    if (!lastGreen) return "STUCK: this exact failure happened three times in a row. Do not repeat the same edit. Re-read the failing file and the error, then change your approach, or revert to start over.";
    await history.restore(lastGreen, "last state where all checks passed");
    index = await indexRepo(files);
    const undone = memory.edits.splice(greenEdits).map(e => e.path);
    editVersion++;
    memory.edits.push({ path: "(recovery)", summary: `undid ${undone.length} edit(s) after the last passing state (${[...new Set(undone)].join(", ")})` });
    for (const c of checks) memory.checkState.set(c.name, { status: "passed", afterEdit: true });
    seenSinceEdit.clear();
    deps.event({ kind: "edit", title: "Went back to the last state where all checks passed", detail: `undid edits to ${[...new Set(undone)].join(", ")}` });
    return `AUTO-RECOVERY: this exact failure happened three times in a row, so the files are back to the last state where all checks passed. Your later edits (${[...new Set(undone)].join(", ")}) were undone. Do not make them again. If the code now does what the task asks, finish; otherwise take a different approach.`;
  }
  /**
   * An edit that would leave a file unparseable (unbalanced braces, a return outside its function) is refused
   * before it is written, with the exact error and the lines around it, so broken code never lands.
   */
  async function refuseBrokenSyntax(path: string, before: string | null, after: string) {
    const problem = await introducedSyntaxError(path, before, after);
    if (!problem) return;
    const lines = after.split("\n");
    const from = Math.max(1, problem.line - 4), to = Math.min(lines.length, problem.line + 3);
    deps.event({ kind: "error", title: `Refused an edit that would break ${path}`, detail: `${problem.message} (line ${problem.line})` });
    throw new Error(`This edit would break ${path}: ${problem.message} at line ${problem.line}. The file was NOT changed. After your edit those lines would read:\n${numbered(lines.slice(from - 1, to), from)}\nMake sure every { ( [ you open is closed and nothing is left outside its function. For several changes to a small file, write_file with the complete corrected file is safer.`);
  }
  function noteEdit(path: string, summary: string, added: number, removed: number) {
    // A fix made after a check failed (since the previous edit) is one retry of the edit-test loop.
    if (lastFailedRun > lastEditAt) retries++;
    memory.edits.push({ path, summary });
    lastEditAt = step;
    editVersion++;
    seenSinceEdit.clear();
    linesChanged.added += added; linesChanged.removed += removed;
    for (const [name, state] of memory.checkState) memory.checkState.set(name, { ...state, afterEdit: false });
    if (!memory.relevant.some(r => r.path === path)) memory.relevant.push({ path, reason: "edited" });
    emitState();
  }

  async function perform(action: AgentAction): Promise<string> {
    switch (action.action) {
      case "update_plan":
        memory.plan = action.plan;
        deps.event({ kind: "plan", title: "Plan updated", detail: action.plan.map(p => `${p.status === "done" ? "✓" : p.status === "doing" ? "…" : "○"} ${p.step}`).join("\n") });
        emitState();
        return "Plan saved.";
      case "list_directory": {
        const dir = cleanRelative(action.path);
        deps.event({ kind: "inspect", title: action.note || `Listing ${dir || "the project"}` });
        const inside = [...index.files.keys()].filter(p => !dir || p.startsWith(`${dir}/`));
        const children = new Set(inside.map(p => { const rest = dir ? p.slice(dir.length + 1) : p; const slash = rest.indexOf("/"); return slash < 0 ? rest : `${rest.slice(0, slash)}/`; }));
        return children.size ? [...children].sort().join("\n") : `Nothing found under "${dir}".`;
      }
      case "read_file": case "read_range": {
        const file = await files.read(action.path);
        const already = memory.read.has(file.path) && action.action === "read_file";
        memory.read.delete(file.path);
        memory.read.add(file.path);
        if (already && !file.binary && (file.content ?? "").length < 12_000) return `${file.path} is already in the WORKING SET with its current content. Use it to apply_patch, or read_range for a specific part.`;
        if (file.binary) return `${file.path} is a binary file (${file.size} bytes).`;
        const lines = (file.content ?? "").split("\n");
        const from = action.action === "read_range" ? action.start_line : 1;
        const to = action.action === "read_range" ? Math.min(action.end_line, lines.length) : Math.min(lines.length, 400);
        deps.event({ kind: "read", title: `Reading ${file.path}${action.action === "read_range" || lines.length > 400 ? ` (lines ${from}–${to})` : ""}`, detail: action.note });
        const more = to < lines.length ? `\n[${lines.length - to} more lines; use read_range to see lines ${to + 1}–${lines.length}]` : "";
        return `${file.path} (${lines.length} lines):\n${numbered(lines.slice(from - 1, to), from)}${more}`;
      }
      case "search_code": {
        deps.event({ kind: "search", title: `Searching for "${action.query}"`, detail: action.note });
        const hits = await files.search(action.query, 60);
        return hits.length ? hits.map(h => (h.line ? `${h.path}:${h.line}: ${h.text}` : `${h.path} (file name)`)).join("\n") : `No matches for "${action.query}". Try a shorter or different term, or find_symbol.`;
      }
      case "find_symbol": {
        deps.event({ kind: "search", title: `Looking up ${action.name}`, detail: action.note });
        const hits = findSymbol(index, action.name);
        if (!hits.length) return `No definition named "${action.name}" was found. It may not exist; search_code can find uses of the name.`;
        const users = (path: string) => [...(index.importedBy.get(path) ?? [])].slice(0, 5);
        return hits.slice(0, 20).map(h => `${h.kind} ${h.name} — ${h.path}:${h.line}${h.exported ? " (exported)" : ""}${users(h.path).length ? `; ${h.path} is imported by ${users(h.path).join(", ")}` : ""}`).join("\n");
      }
      case "find_references": {
        deps.event({ kind: "search", title: `Finding uses of ${action.name}`, detail: action.note });
        const word = new RegExp(`(^|[^\\w$])${action.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![\\w$])`);
        const defs = findSymbol(index, action.name).filter(h => h.name === action.name);
        const isDef = (path: string, line?: number) => defs.some(d => d.path === path && d.line === line);
        const hits = (await files.search(action.name, 400)).filter(h => h.line && word.test(h.text) && !isDef(h.path, h.line));
        if (!defs.length && !hits.length) return `"${action.name}" is not defined or used anywhere in the project.`;
        return [
          defs.length ? `Defined: ${defs.map(d => `${d.path}:${d.line}`).join(", ")}` : "No definition found in the project (it may come from a package).",
          hits.length ? `Used ${hits.length} time(s):\n${hits.slice(0, 60).map(h => `${h.path}:${h.line}: ${h.text.trim().slice(0, 160)}`).join("\n")}` : "Not used anywhere else."
        ].join("\n");
      }
      case "inspect_dependencies": {
        const path = action.path ? cleanRelative(action.path) : "";
        deps.event({ kind: "inspect", title: path ? `Dependencies of ${path}` : "Project dependencies and scripts", detail: action.note });
        if (path) {
          const entry = index.files.get(path);
          if (!entry) return `${path} is not in the project index (it may be ignored, binary or missing).`;
          const users = [...(index.importedBy.get(path) ?? [])];
          return [`${path} imports:`, ...(entry.imports.length ? entry.imports.map(i => `- ${i.spec}${i.file ? ` → ${i.file}` : " (package or built-in)"} (line ${i.line})`) : ["- nothing"]),
            `Imported by: ${users.length ? users.join(", ") : "nothing"}`].join("\n");
        }
        const detected = await detectProject(files.root);
        const pkg = await files.read("package.json").then(f => JSON.parse(f.content ?? "{}"), () => undefined);
        return [`Project type: ${detected.label}.`, index.packages.length ? `Declared dependencies: ${index.packages.join(", ")}.` : "No declared dependencies.",
          pkg?.scripts ? `package.json scripts: ${Object.entries(pkg.scripts).map(([k, v]) => `${k} = ${v}`).join("; ")}.` : "",
          checks.length ? `Checks: ${checks.map(c => `${c.name} = ${c.command}`).join("; ")}.` : "No test, typecheck, lint or build command detected."].filter(Boolean).join("\n");
      }
      case "apply_patch": {
        const file = await files.read(action.path);
        if (file.binary || file.content === null) throw new Error(`${file.path} is binary`);
        if (!memory.read.has(file.path)) throw new Error(`Read ${file.path} before patching it`);
        let patched: ReturnType<typeof applyEdits>;
        try { patched = applyEdits(file.content, action.edits); }
        catch (error) {
          // After a failed patch on a small file, rewriting it whole is usually the more reliable route for a small model.
          const small = file.content.split("\n").length <= 200;
          throw new Error(`${error instanceof Error ? error.message : String(error)}${small ? " Or use write_file with the file's complete new content." : ""}`);
        }
        const { content, changes } = patched;
        await refuseBrokenSyntax(file.path, file.content, content);
        await files.write(file.path, content);
        index = await indexRepo(files);
        const added = changes.reduce((n, c) => n + c.added, 0), removed = changes.reduce((n, c) => n + c.removed, 0);
        noteEdit(file.path, action.note || `${action.edits.length} edit(s)`, added, removed);
        deps.event({ kind: "edit", title: `Edited ${file.path}`, detail: `${action.note ? `${action.note} · ` : ""}−${removed} +${added} lines` });
        return `Patched ${file.path}: ${changes.map((c, i) => `edit ${i + 1} replaced ${c.removed} line(s) with ${c.added}`).join("; ")}. Run the tests to verify.`;
      }
      case "write_file": {
        const file = await files.read(action.path);
        if (file.binary || file.content === null) throw new Error(`${file.path} is binary`);
        if (!memory.read.has(file.path)) throw new Error(`Read ${file.path} before rewriting it`);
        const before = file.content.split("\n");
        if (before.length > 200) throw new Error(`${file.path} has ${before.length} lines; use apply_patch for large files`);
        if (!action.content.trim() && file.content.trim()) throw new Error("write_file with empty content would erase the file; use delete_file to remove it");
        await refuseBrokenSyntax(file.path, file.content, action.content);
        await files.write(file.path, action.content);
        index = await indexRepo(files);
        const { added, removed } = lineChanges(before, action.content.split("\n"));
        noteEdit(file.path, action.note || "rewrote the file", added, removed);
        deps.event({ kind: "edit", title: `Edited ${file.path}`, detail: `${action.note ? `${action.note} · ` : ""}−${removed} +${added} lines` });
        return `Wrote ${file.path} (−${removed} +${added} lines). Run the tests to verify.`;
      }
      case "create_file": {
        const path = cleanRelative(action.path);
        if (await files.read(path).then(() => true, () => false)) throw new Error(`${path} already exists; read it and use apply_patch or write_file to change it`);
        await refuseBrokenSyntax(path, null, action.content);
        await files.write(path, action.content);
        memory.read.add(path);
        index = await indexRepo(files);
        const n = action.content.split("\n").length;
        noteEdit(path, action.note || `created (${n} lines)`, n, 0);
        deps.event({ kind: "edit", title: `Created ${path}`, detail: action.note });
        return `Created ${path} (${n} lines).`;
      }
      case "delete_file": {
        const path = cleanRelative(action.path);
        const file = await files.read(path);
        await files.remove(path);
        index = await indexRepo(files);
        noteEdit(path, action.note || "deleted", 0, (file.content ?? "").split("\n").length);
        deps.event({ kind: "edit", title: `Deleted ${path}`, detail: action.note });
        const users = [...(index.importedBy.get(path) ?? [])];
        return `Deleted ${path}.${users.length ? ` Warning: still imported by ${users.join(", ")}.` : ""}`;
      }
      case "rename_symbol": {
        // Whole-word rename in every code file, like an editor's rename: definitions, imports and uses together.
        const word = new RegExp(`(?<![\\w$])${action.from.replace(/\$/g, "\\$")}(?![\\w$])`, "g");
        const code = [...index.files.values()].filter(f => !["text", "markdown", "json"].includes(f.language) && f.size < 512 * 1024);
        const changed: string[] = [];
        for (const entry of code) {
          const file = await files.read(entry.path);
          if (file.binary || file.content === null || !word.test(file.content)) continue;
          word.lastIndex = 0;
          const next = file.content.replace(word, action.to);
          await refuseBrokenSyntax(entry.path, file.content, next);
          await files.write(entry.path, next);
          const count = (file.content.match(word) ?? []).length;
          noteEdit(entry.path, action.note || `renamed ${action.from} to ${action.to} (${count}×)`, count, count);
          memory.read.add(entry.path);
          changed.push(`${entry.path} (${count})`);
        }
        index = await indexRepo(files);
        deps.event({ kind: "edit", title: `Renamed ${action.from} → ${action.to}`, detail: changed.join(", ") || "no uses found" });
        return changed.length ? `Renamed ${action.from} to ${action.to} in ${changed.length} file(s): ${changed.join(", ")}. Run the tests to verify.` : `"${action.from}" does not appear in any code file.`;
      }
      case "rename_file": {
        const from = cleanRelative(action.path), to = cleanRelative(action.new_path);
        const users = [...(index.importedBy.get(from) ?? [])];
        await files.rename(from, to);
        if (memory.read.delete(from)) memory.read.add(to);
        index = await indexRepo(files);
        noteEdit(to, action.note || `renamed from ${from}`, 0, 0);
        deps.event({ kind: "edit", title: `Renamed ${from} → ${to}`, detail: action.note });
        return `Renamed ${from} to ${to}.${users.length ? ` These files import the old path and must be updated: ${users.join(", ")}.` : ""}`;
      }
      case "run_command": {
        checkCommand(action.command);
        deps.event({ kind: "run", title: `Running ${action.command}`, detail: action.note });
        const done = await runCommand(action.command);
        const output = runner.output(done.id);
        if (done.status !== "exited") memory.failures.push(`${action.command}: ${failureDigest(output)}`);
        deps.event({ kind: "run", title: `${action.command} → ${done.status === "exited" ? "succeeded" : done.status}${done.exitCode !== null ? ` (exit ${done.exitCode})` : ""}` });
        return `Command ${done.status} (exit code ${done.exitCode ?? "none"}). Output:\n${tail(output, 4000)}`;
      }
      case "run_tests": return runChecks(["test"]);
      case "run_build": return runChecks(["build", "typecheck"]);
      case "run_checks": return runChecks();
      case "run_typecheck": return runChecks(["typecheck"]);
      case "run_lint": return runChecks(["lint"]);
      case "git_status": {
        deps.event({ kind: "inspect", title: "Checking what changed" });
        const pending = await history.pending();
        let own = "";
        if (await files.read(".git/HEAD").then(() => true, () => false).catch(() => false)) {
          const done = await runCommand("git status --short");
          own = `\nProject's own git status:\n${runner.output(done.id).split("\n").filter(l => !l.startsWith("$") && !l.startsWith("[")).join("\n").trim() || "(clean)"}`;
        }
        return `Changes since the task started: ${pending.files.length ? pending.files.map(f => `${f.status} ${f.path} (+${f.added} -${f.removed})`).join(", ") : "none"}.${own}`;
      }
      case "git_diff": {
        const diff = baseCommit ? await history.diff(baseCommit) : await history.pending();
        const path = action.path ? cleanRelative(action.path) : "";
        const patch = path ? diff.patch.split(/(?=^diff --git )/m).filter(p => p.includes(` b/${path}`)).join("") : diff.patch;
        return patch.trim() ? clip(patch, 6000) : "No changes yet.";
      }
      case "checkpoint": {
        const cp = await history.checkpoint(action.label.slice(0, 120), "agent");
        deps.event({ kind: "inspect", title: cp ? `Checkpoint: ${action.label}` : "No changes to checkpoint" });
        return cp ? `Saved checkpoint ${cp.commit.slice(0, 8)}.` : "Nothing changed since the last checkpoint.";
      }
      case "revert": {
        if (!baseCommit) throw new Error("There is no starting checkpoint to revert to");
        await history.restore(baseCommit, "start of this task");
        index = await indexRepo(files);
        memory.edits.push({ path: "(all)", summary: "reverted every change made in this task" });
        editVersion++;
        seenSinceEdit.clear();
        for (const [name] of memory.checkState) memory.checkState.set(name, { status: "pending", afterEdit: false });
        deps.event({ kind: "edit", title: "Reverted all changes from this task", detail: action.note });
        emitState();
        return "All files are back to how they were when the task started.";
      }
      case "view_page": {
        deps.event({ kind: "check", title: `Opening ${action.path || "the page"} in a browser`, detail: action.note });
        const url = deps.pageUrl?.();
        const sizes: ViewportName[] = action.viewport === "both" ? ["desktop", "mobile"] : [action.viewport ?? "desktop"];
        const out: string[] = [];
        for (const size of sizes) {
          const report = await viewPage(files.root, { path: action.path || "index.html", url: url ? new URL(action.path || "", url).toString() : undefined, actions: action.click ? [{ click: action.click }] : [], viewport: size });
          if (report.consoleErrors.length || report.error) memory.failures.push(`page ${action.path || "index.html"}: ${report.error ?? report.consoleErrors.slice(0, 3).join(" | ")}`);
          if (report.layout && report.layout.pageWidth > report.layout.width + 1) memory.failures.push(`page ${action.path || "index.html"} (${size}): horizontal overflow, ${report.layout.overflowing.slice(0, 3).join(", ")}`);
          out.push([sizes.length > 1 ? `--- ${size} ---` : "", report.error ? `ERROR: ${report.error}` : "", `Title: ${report.title}`, report.layout ? describeLayout(report.layout) : "", `Visible text:\n${clip(report.text, sizes.length > 1 ? 1200 : 2500)}`, report.consoleErrors.length ? `Console errors:\n${report.consoleErrors.join("\n")}` : "No console errors.", report.failedRequests.length ? `Failed requests:\n${report.failedRequests.join("\n")}` : ""].filter(Boolean).join("\n"));
        }
        return out.join("\n\n");
      }
      case "finish": {
        // A request for a change that ends with no change is questioned once (it may genuinely need none).
        if (!memory.edits.length && !isQuestion(task) && noChangeFinishes < 1) {
          noChangeFinishes++;
          return "Not finished: you have not changed any files, but the task asks for a change. Make the change, or call finish again explaining why no change is needed.";
        }
        // After edits, the project's checks must have run and passed since the last edit (or the agent explains being blocked twice).
        if (memory.edits.length && checks.length) {
          const unverified = checks.filter(c => !memory.checkState.get(c.name)!.afterEdit);
          if (unverified.length) await runChecks(unverified.map(c => c.name));
          const failing = checks.filter(c => memory.checkState.get(c.name)!.status === "failed");
          if (failing.length && blockedFinishes < 2) {
            blockedFinishes++;
            return `Not finished: ${failing.map(c => c.command).join(", ")} still fail after your edits.\n${memory.failures.slice(-failing.length).join("\n")}\nFix the cause and run the checks again, or call finish again to stop and explain why it is blocked.`;
          }
        }
        // A reported bug the tests did not catch needs a test that reproduces it; otherwise nothing shows the fix works.
        if (reproduce && memory.edits.length && !memory.edits.some(e => isTestFile(e.path)) && reproFinishes < 2) {
          reproFinishes++;
          return "Not finished: the tests passed before your change too, so they do not show the reported bug is fixed. Add a test for the exact case in the task (in the project's existing test file or style), run_tests, and make sure it passes for the right reason.";
        }
        // Edits to a web page are opened in a browser before finishing (loading it and clicking each button), and a
        // layout task is checked at phone width. Each gate checks again whenever the files changed since its last
        // check, and sends the agent back while problems remain; a problem it stops working on is reported, not hidden.
        const webEdit = memory.edits.some(e => /\.(html?|css|m?jsx?|tsx|vue|svelte)$/i.test(e.path));
        const pageUrl = deps.pageUrl?.();
        const hasPage = Boolean(pageUrl || index.files.has("index.html"));
        if (webEdit && hasPage && pageCheckedAt !== editVersion) {
          pageCheckedAt = editVersion;
          deps.event({ kind: "check", title: "Opening the page in a browser before finishing" });
          const report = await viewPage(files.root, { path: "index.html", url: pageUrl, actions: [{ clickEach: "button, [role=button], input[type=submit], input[type=button]" }] });
          const problems = [report.error, ...report.consoleErrors].filter(Boolean) as string[];
          pageProblem = problems.slice(0, 3).join(" | ");
          if (pageProblem && gateRejections < 6) {
            gateRejections++;
            memory.failures.push(`page: ${pageProblem}`);
            return `Not finished: the page shows errors after your edits (loading it and clicking each button once):\n${problems.slice(0, 5).join("\n")}\nVisible text:\n${clip(report.text, 800)}\nFix the cause, then view_page to confirm.`;
          }
        }
        if (webEdit && hasPage && layoutTask.test(task) && layoutCheckedAt !== editVersion) {
          layoutCheckedAt = editVersion;
          const report = await viewPage(files.root, { path: "index.html", url: pageUrl, viewport: "mobile" });
          deps.event({ kind: "check", title: "Checking the layout at phone width before finishing", detail: report.layout ? describeLayout(report.layout).split("\n")[0] : undefined });
          const l = report.layout;
          layoutProblem = l && (l.pageWidth > l.width + 1 || !l.viewportMeta) ? describeLayout(l).replace(/\n/g, " ") : "";
          if (layoutProblem && gateRejections < 6) {
            gateRejections++;
            memory.failures.push(`mobile layout: ${layoutProblem}`);
            return `Not finished: at phone width the layout is not right yet.\n${describeLayout(l!)}\nFix it (for example max-width: 100%, box-sizing: border-box, flex-wrap, a media query, or the viewport meta tag), then view_page with viewport "mobile" to confirm.`;
          }
        }
        summary = action.summary;
        const unresolved = [pageProblem && `the page still shows errors (${pageProblem})`, layoutTask.test(task) && layoutProblem && `the layout still fails at phone width (${layoutProblem})`].filter(Boolean);
        if (unresolved.length) { gateFailed = true; summary += ` (Not verified: ${unresolved.join("; ")}.)`; }
        // Verify before claiming: a summary that says something was changed, when no file was, is corrected.
        if (!memory.edits.length && !isQuestion(task) && /\b(now|updated|changed|added|fixed|made|implemented|created|renamed|removed|refactored|is (now )?(responsive|working|fixed))\b/i.test(summary)) {
          summary = `No files were changed, so the task was not done. (The agent's summary claimed: "${summary.slice(0, 200)}")`;
        }
        // Said plainly rather than implied: a bug fix with no test reproducing the report has not been shown to work.
        if (reproduce && memory.edits.length && !memory.edits.some(e => isTestFile(e.path))) summary += " (Not verified: no test reproduces the reported bug.)";
        finished = true;
        return "";
      }
    }
  }
}
