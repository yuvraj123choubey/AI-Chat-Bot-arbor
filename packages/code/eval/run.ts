/**
 * Runs the coding-agent evaluation against real models (the free local model by default) through the same
 * provider layer the app uses, so a stronger model plugs in through configuration alone.
 *
 *   npm run eval:agent                 all tasks, best configured model
 *   npm run eval:agent -- bugfix-discount feature-median
 *   EVAL_MODEL=local-thinking npm run eval:agent
 */
import "../../../apps/api/src/setup-env.ts";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadRegistry } from "../../ai/src/registry.ts";
import { LocalProvider } from "../../ai/src/providers/local.ts";
import { OpenAIProvider } from "../../ai/src/providers/openai.ts";
import { AnthropicProvider } from "../../ai/src/providers/anthropic.ts";
import { GoogleProvider } from "../../ai/src/providers/google.ts";
import { DeepSeekProvider } from "../../ai/src/providers/deepseek.ts";
import type { AIProvider, ProviderName } from "../../ai/src/types.ts";
import { CommandRunner, ProjectFiles, ProjectHistory, modelDecider, runAgent, viewPage } from "../src/index.ts";
import { agentModels } from "../../../apps/api/src/tasks/code-agent.ts";
import { tasks, type EvalTask } from "./tasks.ts";

const providers: AIProvider[] = [new LocalProvider(), new OpenAIProvider(), new AnthropicProvider(), new GoogleProvider(), new DeepSeekProvider()];
const providerMap = new Map<ProviderName, AIProvider>(providers.map(p => [p.name, p]));
const registry = await loadRegistry();
const available = registry.filter(m => m.enabled && providerMap.get(m.provider)?.isConfigured());
const candidates = agentModels(available, process.env.EVAL_MODEL || "auto");
if (!candidates.length) { console.error("No model is available. Start the local model server (npm run dev:llm) or configure a provider."); process.exit(1); }
const only = process.argv.slice(2).filter(a => !a.startsWith("-"));
const selected = only.length ? tasks.filter(t => only.includes(t.id)) : tasks;
const outDir = join("data", "eval");
await mkdir(outDir, { recursive: true });

interface Row { id: string; category: string; success: boolean; hiddenPassed: boolean; regressionsOk: boolean | null; agentFinished: boolean; checksPassing: boolean | null; filesChanged: number; linesChanged: number; retries: number; steps: number; seconds: number; summary: string; error?: string }

async function command(runner: CommandRunner, cwd: string, line: string) {
  const done = await runner.wait(runner.start({ projectId: "eval", cwd, command: line, timeoutMs: 120_000 }).id);
  return { ok: done.status === "exited", output: runner.output(done.id) };
}

async function runTask(task: EvalTask): Promise<Row> {
  const base = await mkdtemp(join(tmpdir(), `arbor-eval-${task.id}-`));
  const root = join(base, "project");
  await mkdir(root);
  for (const [path, content] of Object.entries(task.files)) { await mkdir(join(root, path, ".."), { recursive: true }); await writeFile(join(root, path), content); }
  const files = new ProjectFiles(root);
  const history = new ProjectHistory(root, join(base, "history.git"));
  const runner = new CommandRunner(() => join(base, "logs"));
  await history.checkpoint("Task start", "system");
  const started = Date.now();
  const log: string[] = [];
  // Every tool call the model made, verbatim, for diagnosing failures.
  const actions: string[] = [];
  const decide = modelDecider({ candidates, providers: providerMap });
  try {
    const result = await runAgent({
      files, history, runner, projectId: "eval",
      next: async messages => { const action = await decide(messages); actions.push(JSON.stringify(action)); return action; },
      event: e => { if (e.kind !== "state") { log.push(`[${Math.round((Date.now() - started) / 1000)}s] ${e.kind}: ${e.title}${e.detail ? ` — ${e.detail.replace(/\s+/g, " ").slice(0, 160)}` : ""}`); console.log(`   ${log.at(-1)}`); } }
    }, task.request, "", Number(process.env.EVAL_STEPS) || 30);
    // The project's own tests first (regressions), then the hidden verification the agent never saw.
    const regressionsOk = task.regression ? (await command(runner, root, task.regression)).ok : null;
    for (const [path, content] of Object.entries(task.hidden ?? {})) await writeFile(join(root, path), content);
    let hiddenPassed: boolean;
    if ("command" in task.verify) hiddenPassed = (await command(runner, root, task.verify.command)).ok;
    else {
      const page = await viewPage(root, { path: task.verify.page.path, actions: task.verify.page.click ? [{ click: task.verify.page.click }] : [] });
      hiddenPassed = !page.error && !page.consoleErrors.length && task.verify.page.expectText.every(r => r.test(page.text)) && !(task.verify.page.forbidText ?? []).some(r => r.test(page.text));
      log.push(`page check: ${page.error ?? ""} text=${JSON.stringify(page.text.slice(0, 200))} errors=${page.consoleErrors.join(" | ")}`);
    }
    const m = result.metrics;
    return { id: task.id, category: task.category, success: hiddenPassed && regressionsOk !== false, hiddenPassed, regressionsOk, agentFinished: m.finished, checksPassing: m.checksPassing, filesChanged: m.filesChanged, linesChanged: m.linesAdded + m.linesRemoved, retries: m.retries, steps: m.steps, seconds: Math.round((Date.now() - started) / 1000), summary: result.summary };
  } catch (error) {
    return { id: task.id, category: task.category, success: false, hiddenPassed: false, regressionsOk: null, agentFinished: false, checksPassing: null, filesChanged: 0, linesChanged: 0, retries: 0, steps: 0, seconds: Math.round((Date.now() - started) / 1000), summary: "", error: error instanceof Error ? error.message : String(error) };
  } finally {
    runner.stopAll();
    await writeFile(join(outDir, `${task.id}.log`), log.join("\n"));
    await writeFile(join(outDir, `${task.id}.actions.jsonl`), actions.join("\n"));
    await rm(base, { recursive: true, force: true, maxRetries: 5 }).catch(() => {});
  }
}

console.log(`Coding-agent eval · model: ${candidates.map(m => `${m.displayName} (${m.modelId})`).join(" → ")} · ${selected.length} task(s)\n`);
const rows: Row[] = [];
for (const task of selected) {
  console.log(`▶ ${task.id} [${task.category}]`);
  const row = await runTask(task);
  rows.push(row);
  console.log(`  ${row.success ? "PASS" : "FAIL"} · hidden ${row.hiddenPassed ? "✓" : "✗"} · regressions ${row.regressionsOk === null ? "n/a" : row.regressionsOk ? "none" : "YES"} · files ${row.filesChanged} · retries ${row.retries} · steps ${row.steps} · ${row.seconds}s${row.error ? ` · error: ${row.error}` : ""}\n`);
}
const passed = rows.filter(r => r.success).length;
const summary = { model: candidates[0].modelId, ranAt: new Date().toISOString(), passed, total: rows.length, successRate: rows.length ? passed / rows.length : 0, totalSeconds: rows.reduce((n, r) => n + r.seconds, 0), rows };
await writeFile(join(outDir, `results-${summary.ranAt.replace(/[:.]/g, "-")}.json`), JSON.stringify(summary, null, 2));
console.log(`Result: ${passed}/${rows.length} tasks passed · ${summary.totalSeconds}s total`);
console.table(rows.map(r => ({ task: r.id, ok: r.success, hidden: r.hiddenPassed, regress: r.regressionsOk === null ? "n/a" : r.regressionsOk ? "none" : "YES", files: r.filesChanged, lines: r.linesChanged, retries: r.retries, steps: r.steps, secs: r.seconds })));
