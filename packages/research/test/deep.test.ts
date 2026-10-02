import test from "node:test";
import assert from "node:assert/strict";
import { runDeepResearch, type DeepResearchDeps, type Note, type RegisteredSource } from "../src/deep.ts";
import type { EvidenceSource, RetrievedSource } from "../src/types.ts";

const src = (slug: string, text: string): RetrievedSource => ({ url: `https://${slug}.example/`, canonicalUrl: `https://${slug}.example`, title: `${slug} title`, domain: `${slug}.example`, snippet: text, fullText: text, sourceType: "web", searchQuery: "q", readMode: "page", metadata: {} });
const evidence = (...sources: RetrievedSource[]): EvidenceSource[] => sources.map((source, i) => ({ ordinal: i + 1, source, passages: [{ text: source.fullText, start: 0, score: 1 }] }));

function harness(overrides: Partial<DeepResearchDeps> = {}) {
  const log: string[] = [];
  const saved = { plans: 0, queries: [] as string[], sources: [] as RegisteredSource[], notes: [] as Note[] };
  const deps: DeepResearchDeps = {
    async gather({ question }) {
      log.push(`gather:${question}`);
      // "backups" appears for both sub-questions, so it must keep a single project-wide number.
      if (question.startsWith("Which")) return { evidence: evidence(src("backups", "Offline backups restore data."), src("training", "Phishing training reduces infections.")), retrieved: [], providers: [], notices: [] };
      if (question.startsWith("How")) return { evidence: evidence(src("segmentation", "Segmentation limits spread."), src("backups", "Offline backups restore data.")), retrieved: [], providers: [], notices: [] };
      return { evidence: evidence(src("insurance", "Cyber insurance covers some costs.")), retrieved: [], providers: [], notices: [] };
    },
    async structured(step: string, request: any) {
      log.push(`structured:${step}`);
      if (request.name === "research_plan") return request.validate({ objective: "Defend against ransomware", subquestions: [{ question: "Which controls prevent ransomware?", queries: ["ransomware prevention controls"] }, { question: "How is spread contained?", queries: ["ransomware containment"] }] });
      if (request.name === "research_notes") {
        const user = request.messages[1].content as string;
        const numbers = [...user.matchAll(/^\[(\d+)\]/gm)].map(m => Number(m[1]));
        // Includes an invented source number (99), which must be dropped.
        return request.validate({ findings: [{ claim: `Finding for ${numbers.join(",")}`, sources: [...numbers, 99] }, { claim: "Unsupported claim", sources: [99] }], gaps: ["costs"] });
      }
      return request.validate({ missing: [{ question: "What does recovery cost?", queries: ["ransomware recovery cost"] }], conflicts: [{ topic: "Backups", description: "Disagree on frequency", sources: [1, 3] }, { topic: "Bad", description: "Only one source", sources: [1] }] });
    },
    async text(step: string, request: any) {
      log.push(`text:${step}`);
      if (step === "researcher") {
        const numbers = [...(request.messages[1].content as string).matchAll(/^\[(\d+)\]/gm)].map(m => Number(m[1]));
        // Includes an invented source number (99) and a bullet citing only it, which must be dropped.
        return `Here are the notes:\n- Finding for ${numbers.join(",")} ${numbers.map(n => `[${n}]`).join("")}[99]\n- Unsupported claim [99]\nNot a bullet [1]`;
      }
      return "## Summary\nBackups work [1]. Segmentation helps [3]. Invented [42].";
    },
    async step(kind, _title, _input, run) { log.push(`step:${kind}`); return run(); },
    progress() {},
    async savePlan() { saved.plans++; },
    async saveQueries(q) { saved.queries = q; },
    async saveSources(added) { saved.sources.push(...added); },
    async saveNotes(n) { saved.notes.push(...n); },
    ...overrides
  };
  return { deps, log, saved };
}

test("deep research plans, numbers sources once per project, fills gaps and writes a checked report", async () => {
  const { deps, log, saved } = harness();
  const result = await runDeepResearch(deps, { question: "How should organisations defend against ransomware?", focus: { academic: false, fresh: false, technical: false, official: false }, maxRounds: 2 });
  assert.deepEqual(result.plan.subquestions.map(s => s.question), ["Which controls prevent ransomware?", "How is spread contained?", "What does recovery cost?"]);
  assert.deepEqual(result.sources.map(s => [s.ordinal, s.source.domain]), [[1, "backups.example"], [2, "training.example"], [3, "segmentation.example"], [4, "insurance.example"]]);
  assert.deepEqual([...result.sources[0].topics], ["Which controls prevent ransomware?", "How is spread contained?"]);
  // Notes cite only numbers actually supplied for that sub-question, mapped to project-wide numbers.
  assert.deepEqual(result.notes.map(n => n.sourceOrdinals), [[1, 2], [3, 1], [4]]);
  assert.equal(result.notes.some(n => n.content === "Unsupported claim"), false);
  assert.deepEqual(result.conflicts.map(c => c.topic), ["Backups"]);
  assert.equal(result.report, "## Summary\nBackups work [1]. Segmentation helps [3]. Invented.");
  assert.deepEqual(result.cited, [1, 3]);
  assert.deepEqual(result.queries, ["ransomware prevention controls", "ransomware containment", "ransomware recovery cost"]);
  assert.equal(saved.sources.length, 4);
  assert.equal(saved.notes.filter(n => n.topic.startsWith("Conflict:")).length, 1);
  assert.equal(saved.plans, 2, "plan saved again after gap sub-questions were added");
  assert.deepEqual(log.filter(l => l.startsWith("step:")), ["step:plan", "step:search", "step:notes", "step:search", "step:notes", "step:gaps", "step:search", "step:notes", "step:report"]);
});

test("a failed plan falls back to researching the question directly", async () => {
  const { deps, log } = harness({
    async structured(_step: string, request: any) { if (request.name === "research_plan") throw new Error("model down"); return request.validate({ missing: [], conflicts: [] }); },
    async text(step: string) { return step === "researcher" ? "NONE" : "unused"; }
  });
  const result = await runDeepResearch(deps, { question: "What is cyber insurance coverage?", focus: { academic: false, fresh: false, technical: false, official: false }, maxRounds: 1 });
  assert.deepEqual(result.plan.subquestions.map(s => s.question), ["What is cyber insurance coverage?"]);
  assert.ok(log.includes("gather:What is cyber insurance coverage?"));
  assert.match(result.report, /No findings/);
});

test("cancellation stops between steps", async () => {
  const abort = new AbortController();
  const { deps } = harness({ signal: abort.signal, progress(event) { if (event.stage === "notes") abort.abort(new Error("Cancelled")); } });
  await assert.rejects(runDeepResearch(deps, { question: "How should organisations defend against ransomware?", focus: { academic: false, fresh: false, technical: false, official: false } }), /Cancelled/);
});

test("query cleaning drops JSON fragments and over-long queries, falling back to keywords", async () => {
  const { cleanQueries } = await import("../src/deep.ts");
  assert.deepEqual(cleanQueries(['{"question": "What is EDR?"}', "endpoint detection response ransomware"], "What is EDR?"), ["What is EDR", "endpoint detection response ransomware"]);
  assert.deepEqual(cleanQueries(["one two three four five six seven eight nine ten eleven twelve thirteen"], "How do backups help against ransomware?"), ["backups help against ransomware"]);
});

test("notes are parsed from cited bullets; uncited or invented citations are dropped", async () => {
  const { parseNotes } = await import("../src/deep.ts");
  const notes = parseNotes("Notes:\n- Offline backups restore data [2].\n* Training cuts phishing [1, 3]\n1. Invented source only [9]\n- Too short [2]\nNONE", "T", new Set([1, 2, 3]));
  assert.deepEqual(notes, [{ topic: "T", content: "Offline backups restore data.", sourceOrdinals: [2] }, { topic: "T", content: "Training cuts phishing", sourceOrdinals: [1, 3] }]);
});
