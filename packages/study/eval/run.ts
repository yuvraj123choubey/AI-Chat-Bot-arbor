/**
 * Study evaluation: runs realistic document-study tasks through a running Arbor API (the real pipeline and the
 * configured model) and scores the answers with fixed checks.
 *
 *   npm run eval:study                 # all cases against http://127.0.0.1:8787
 *   npm run eval:study review-missing  # one case
 *   ARBOR_URL=http://127.0.0.1:8787 npm run eval:study
 *
 * Needs a local Chrome or Edge to render the PDF and screenshot fixtures.
 */
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { chromium } from "playwright-core";
import { findBrowser } from "../../code/src/browser.ts";
import { completeHtml, labHtml, partialHtml, terminalHtml } from "./fixtures.ts";

const base = process.env.ARBOR_URL ?? "http://127.0.0.1:8787";
const workspaceId = "default";

interface Check { name: string; test: (r: Reply) => boolean }
interface Case { id: string; area: string; attach: string[]; question: string; after?: string; checks: Check[] }
interface Reply { content: string; conversationId: string; sources: string[]; statuses: string[]; seconds: number }

const has = (re: RegExp, name = `mentions ${re.source}`): Check => ({ name, test: r => re.test(r.content) });
const lacks = (re: RegExp, name = `does not say ${re.source}`): Check => ({ name, test: r => !re.test(r.content) });
const line = (task: string, mark: RegExp, name: string): Check => ({ name, test: r => r.content.split("\n").some(l => new RegExp(`\\*\\*${task}\\*\\*`).test(l) && mark.test(l)) });
const honest = /couldn['’]t (verify|find)|could not (verify|find)|not (mentioned|specified|stated|included|listed|given|found)|doesn['’]t (say|mention|specify|state|include|list|contain|have)|does not (say|mention|specify|state|include|list|contain|have)|no (information|mention)|isn['’]t (mentioned|specified|stated|in)|there is no task 7|only (has|contains|includes) (five|5)/i;

const cases: Case[] = [
  {
    id: "lab-overview", area: "document study", attach: ["lab"], question: "Study this lab and help me complete it.",
    checks: [
      has(/status verbose|firewall status|default polic/i, "covers Task 1"), has(/\b22\b|ssh/i, "covers Task 2"), has(/8080/, "covers Task 3"),
      has(/\blimit\b|rate[- ]limit/i, "covers Task 4"), has(/reflection|production/i, "covers Task 5"),
      has(/screenshot/i, "mentions the required screenshot"), has(/command line|gui/i, "mentions the command-line-only restriction"),
      has(/october 17|oct\.? 17/i, "gives the due date"), lacks(/task 6/i, "invents no extra task")
    ]
  },
  {
    id: "follow-up", area: "context", attach: [], after: "lab-overview", question: "What exactly do I need to hand in?",
    checks: [has(/lab5_|single pdf|pdf report/i, "names the PDF report"), has(/screenshot/i, "includes the screenshots"), { name: "still uses the lab file", test: r => r.sources.includes("lab5-instructions.pdf") }]
  },
  {
    id: "exact-question", area: "document study", attach: ["lab"], question: "What does task 4 ask me to do?",
    checks: [has(/\blimit\b|rate[- ]limit/i, "explains ufw limit"), has(/attack|brute/i, "mentions explaining the attack"), lacks(/8080/, "stays on task 4")]
  },
  {
    id: "missing-task", area: "honesty", attach: [], after: "exact-question", question: "And what does task 7 ask?",
    checks: [has(/couldn['’]t find|could not find|no task 7|not (in|part of)|doesn['’]t (have|contain|include)|does not (have|contain|include)|only (has|contains|includes|goes up to)|there (is|are) (no|only)/i, "says task 7 is not in the lab"), lacks(/task 7 (asks|requires|wants) you/i, "does not describe a task 7")]
  },
  {
    id: "outside-knowledge", area: "honesty", attach: ["lab"], question: "What is the late penalty for this lab?",
    checks: [has(honest, "says the lab does not state a late penalty"), lacks(/\b\d{1,3}\s?%|per day|points? (per|each) day/i, "invents no penalty")]
  },
  {
    id: "review-missing", area: "submission review", attach: ["lab", "partial"], question: "Is my submission complete?",
    checks: [
      has(/^\*\*Not yet\.\*\*/, "starts with Not yet"), line("Task 1", /✓/, "Task 1 complete"), line("Task 2", /✓/, "Task 2 complete"),
      line("Task 3", /⚠|\?/, "Task 3 flagged"), line("Task 3", /screenshot/i, "Task 3: screenshot named"),
      line("Task 4", /⚠|✗|\?/, "Task 4 not marked complete"), line("Task 5", /✗/, "Task 5 missing")
    ]
  },
  {
    id: "review-complete", area: "submission review", attach: ["lab", "complete", "screenshot"], question: "Is everything complete?",
    checks: [
      line("Task 3", /✓/, "Task 3 complete with its screenshot"), line("Task 4", /✓/, "Task 4 complete"),
      { name: "at least 4 of 5 tasks complete", test: r => r.content.split("\n").filter(l => /^- ✓ \*\*Task/.test(l)).length >= 4 },
      has(/OCR|text read from/i, "says screenshots were read as text only")
    ]
  }
];

async function render(): Promise<Record<string, { name: string; bytes: Buffer; type: string }>> {
  const executablePath = findBrowser();
  if (!executablePath) throw new Error("No local Chrome or Edge found (set ARBOR_BROWSER) — needed to render the fixtures.");
  const browser = await chromium.launch({ executablePath, headless: true });
  try {
    const pageFor = async (html: string) => { const page = await browser.newPage(); await page.setContent(html); return page; };
    const pdf = async (html: string) => { const page = await pageFor(html); const bytes = await page.pdf({ format: "Letter" }); await page.close(); return bytes; };
    const shot = await browser.newPage({ viewport: { width: 640, height: 210 } });
    await shot.setContent(terminalHtml);
    const png = await shot.screenshot();
    return {
      lab: { name: "lab5-instructions.pdf", bytes: await pdf(labHtml), type: "application/pdf" },
      partial: { name: "lab5_jlee_draft.pdf", bytes: await pdf(partialHtml), type: "application/pdf" },
      complete: { name: "lab5_jlee.pdf", bytes: await pdf(completeHtml), type: "application/pdf" },
      screenshot: { name: "rules.png", bytes: png, type: "image/png" }
    };
  } finally { await browser.close(); }
}

async function upload(file: { name: string; bytes: Buffer; type: string }): Promise<string> {
  const form = new FormData();
  form.append("file", new Blob([new Uint8Array(file.bytes)], { type: file.type }), file.name);
  const res = await fetch(`${base}/api/documents?workspaceId=${workspaceId}`, { method: "POST", body: form, headers: { "x-arbor-client": "web" } });
  if (res.status >= 400) throw new Error(`Upload of ${file.name} failed: ${res.status} ${await res.text()}`);
  const { document } = await res.json();
  for (let i = 0; i < 240; i++) {
    const doc = await (await fetch(`${base}/api/documents/${document.id}?workspaceId=${workspaceId}`)).json();
    if (doc.status === "ready") return document.id;
    if (doc.status === "failed") throw new Error(`${file.name} failed to process: ${doc.error}`);
    await new Promise(r => setTimeout(r, 500));
  }
  throw new Error(`${file.name} did not finish processing`);
}

async function chat(body: Record<string, unknown>): Promise<Reply> {
  const started = Date.now();
  const res = await fetch(`${base}/api/chat`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ workspaceId, ...body }) });
  if (!res.ok || !res.body) throw new Error(`Chat failed: ${res.status} ${await res.text()}`);
  let text = "", final: string | undefined, conversationId = "", buffer = "";
  const sources: string[] = [], statuses: string[] = [];
  const decoder = new TextDecoder();
  for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
    buffer += decoder.decode(chunk, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop()!;
    for (const raw of lines) {
      if (!raw.trim()) continue;
      const e = JSON.parse(raw);
      if (e.type === "conversation") conversationId = e.conversation.id;
      if (e.type === "delta") text += e.text;
      if (e.type === "reset") text = "";
      if (e.type === "sources") sources.push(...e.sources.map((s: { source: { title: string } }) => s.source.title));
      if (e.type === "status") statuses.push(`${e.label}${e.detail ? `: ${e.detail}` : ""}`);
      if (e.type === "done" && e.content) final = e.content;
      if (e.type === "error") throw new Error(`Model error: ${e.message}`);
    }
  }
  return { content: (final ?? text).trim(), conversationId, sources, statuses, seconds: Math.round((Date.now() - started) / 1000) };
}

const only = process.argv.slice(2).filter(a => !a.startsWith("-"));
const selected = only.length ? cases.filter(c => only.includes(c.id) || cases.find(x => only.includes(x.id))?.after === c.id) : cases;
console.log(`Study eval · ${base} · ${selected.length} case(s)\nRendering and uploading fixtures…`);
const files = await render();
const ids: Record<string, string> = {};
for (const [key, file] of Object.entries(files)) ids[key] = await upload(file);
const conversations = new Map<string, string>();
const rows: { id: string; area: string; ok: boolean; passed: number; total: number; seconds: number; failed: string[] }[] = [];
const outDir = join("data", "eval");
await mkdir(outDir, { recursive: true });
const transcript: string[] = [];
for (const c of selected) {
  process.stdout.write(`▶ ${c.id} [${c.area}] … `);
  try {
    const conversationId = c.after ? conversations.get(c.after) : undefined;
    const reply = await chat({ message: c.question, ...(conversationId ? { conversationId } : {}), ...(c.attach.length ? { documentIds: c.attach.map(a => ids[a]) } : {}) });
    conversations.set(c.id, reply.conversationId);
    const results = c.checks.map(check => ({ name: check.name, ok: check.test(reply) }));
    const failed = results.filter(r => !r.ok).map(r => r.name);
    rows.push({ id: c.id, area: c.area, ok: !failed.length, passed: results.length - failed.length, total: results.length, seconds: reply.seconds, failed });
    console.log(`${failed.length ? "FAIL" : "PASS"} · ${results.length - failed.length}/${results.length} checks · ${reply.seconds}s${failed.length ? ` · failed: ${failed.join("; ")}` : ""}`);
    transcript.push(`## ${c.id}\nQ: ${c.question}\nSources: ${reply.sources.join(", ")}\nSteps: ${reply.statuses.join(" | ")}\n\n${reply.content}\n\nChecks: ${results.map(r => `${r.ok ? "✓" : "✗"} ${r.name}`).join(" · ")}\n`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    rows.push({ id: c.id, area: c.area, ok: false, passed: 0, total: c.checks.length, seconds: 0, failed: [message] });
    console.log(`ERROR · ${message}`);
  }
}
const passed = rows.filter(r => r.ok).length;
console.log(`\nResult: ${passed}/${rows.length} cases passed · ${rows.reduce((n, r) => n + r.passed, 0)}/${rows.reduce((n, r) => n + r.total, 0)} checks`);
console.table(rows.map(r => ({ case: r.id, area: r.area, ok: r.ok, checks: `${r.passed}/${r.total}`, secs: r.seconds })));
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
await writeFile(join(outDir, `study-${stamp}.json`), JSON.stringify({ ranAt: new Date().toISOString(), base, rows }, null, 2));
await writeFile(join(outDir, `study-${stamp}.md`), transcript.join("\n"));
console.log(`Answers: ${join(outDir, `study-${stamp}.md`)}`);
