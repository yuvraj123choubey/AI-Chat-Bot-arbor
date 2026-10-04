import { normaliseText } from "../../assignments/src/extract.ts";
import { retrieveChunks, type StoredChunk } from "../../files/src/retrieve.ts";
import { tokenize } from "../../research/src/passages.ts";
import { outlineDocument, type Segment } from "./outline.ts";
import type { SheetItem, StudySheet } from "./sheet.ts";
import { containsCommand, countWords, parsePartVerdicts, partMessages, screenshotMatches, screenshotWords, sentencesOf, splitParts, supportingSentence, type RequirementPart } from "./parts.ts";
import type { DocRole, Generate, StudyDoc } from "./types.ts";

export interface Requirement {
  id: string; label: string; text: string; quote: string; documentId: string; page?: number; section?: string; lines?: [number, number];
  /** The full wording from the instructions, for judging. */
  detail: string;
  needsScreenshot: boolean;
  number?: string; kind?: Segment["kind"];
}
export type ReviewStatus = "met" | "partial" | "missing" | "unclear";
export interface RequirementCheck {
  requirement: Requirement; status: ReviewStatus; note: string;
  /** Words from the submission (or a screenshot's text) that show the requirement is addressed, verified to be there. */
  evidence?: { documentId: string; quote: string; page?: number; lines?: [number, number] };
  screenshot: "not-needed" | "read" | "unread" | "missing" | "unmatched";
  /** Each part of the requirement and what was found for it. */
  parts: PartCheck[];
}
export interface ReviewResult {
  checks: RequirementCheck[]; instructions: StudyDoc[]; submissions: StudyDoc[]; screenshots: StudyDoc[];
  /** Assumptions and limits the user should know about (which file was treated as what; what could not be inspected). */
  notes: string[];
}

const roleNames: [DocRole, RegExp][] = [
  ["rubric", /rubric|grading|marking|criteria|scoring/i],
  ["submission", /submission|submit(ted)?[_ -]|answers?|solutions?|report|write-?up|response|my[_ -]|final|draft|attempt/i],
  ["instructions", /instructions?|assignment|lab[_ -]?\d|lab\b|handout|spec(ification)?|prompt|brief|homework|hw[_ -]?\d|project|task|worksheet|exercise/i]
];

function requirementDensity(doc: StudyDoc): number {
  const text = doc.chunks.map(c => c.text).join(" ");
  const hits = text.match(/\b(you (must|should|will|need to)|submit|include|deliverables?|due|points?|pts|marks?|screenshot|answer the following|complete the following|task \d|question \d)\b/gi)?.length ?? 0;
  return hits / Math.max(1, text.length / 1000);
}

/**
 * Decides which file is the instructions, the rubric, the submission and the screenshots: the role given on upload,
 * else the file name, else the wording (instructions are full of "submit", "must", "points"). Every guess is
 * reported in the notes, so the user can correct it.
 */
export function assignRoles(docs: StudyDoc[]): { docs: StudyDoc[]; notes: string[] } {
  const notes: string[] = [];
  const out = docs.map(d => ({ ...d, role: d.role ?? (d.image ? "screenshot" as const : roleNames.find(([, re]) => re.test(d.name))?.[0]) }));
  const text = out.filter(d => !d.image);
  if (text.length > 1 && !text.some(d => d.role === "submission")) {
    // The file with the least requirement language is most likely the student's work.
    const ranked = [...text].sort((a, b) => requirementDensity(a) - requirementDensity(b));
    const sub = ranked.find(d => d.role !== "rubric" && d.role !== "instructions") ?? ranked[0];
    sub.role = "submission";
    notes.push(`I treated ${sub.name} as your submission.`);
  }
  if (!text.some(d => d.role === "instructions" || d.role === "rubric")) {
    const ranked = [...text].filter(d => d.role !== "submission").sort((a, b) => requirementDensity(b) - requirementDensity(a));
    if (ranked[0]) { ranked[0].role = "instructions"; notes.push(`I treated ${ranked[0].name} as the instructions.`); }
  }
  for (const d of out) if (!d.role) d.role = "reference";
  return { docs: out, notes };
}

/**
 * The requirements to check: the numbered units of the instructions (each task or question, with any screenshot
 * it asks for), else the study sheet's requirements, deliverables, questions and screenshot items. Rubric criteria
 * that are not already covered by a task are added.
 */
export function listRequirements(instructions: StudyDoc[], rubric: StudyDoc[], sheets: Map<string, StudySheet>): Requirement[] {
  const out: Requirement[] = [];
  const add = (r: Omit<Requirement, "id">) => out.push({ ...r, id: `R${out.length + 1}` });
  for (const doc of instructions) {
    const units = outlineDocument(doc.chunks);
    const tasks = units.filter(u => u.level === 2).length ? units.filter(u => u.level === 2) : units.filter(u => u.level === 1);
    if (tasks.length >= 2) {
      for (const t of tasks) {
        const body = t.text.split("\n").slice(1).join(" ").replace(/\s+/g, " ").trim();
        const title = t.heading.replace(/^[#*\s]+/, "").replace(/\*\*/g, "");
        add({ label: t.label, text: title.length > t.label.length + 3 ? title : `${title} ${firstSentence(body)}`.trim(), quote: t.heading, documentId: doc.id, page: t.page, section: t.section, lines: t.lines, detail: t.text.slice(0, 1800), needsScreenshot: screenshotWords.test(t.text), number: t.number, kind: t.kind });
      }
      continue;
    }
    const items = (sheets.get(doc.id)?.items ?? []).filter(i => ["requirement", "deliverable", "question", "screenshot"].includes(i.kind));
    items.forEach((i, n) => add(fromSheet(i, doc.id, `Requirement ${n + 1}`)));
  }
  for (const doc of rubric) {
    const items = (sheets.get(doc.id)?.items ?? []).filter(i => i.kind === "grading" || i.kind === "requirement");
    for (const i of items) {
      const words = new Set(tokenize(`${i.text} ${i.quote}`));
      const covered = out.some(r => { const t = tokenize(`${r.text} ${r.detail}`); return t.filter(w => words.has(w)).length / Math.max(1, words.size) >= 0.5; });
      if (!covered) add(fromSheet(i, doc.id, `Rubric: ${i.text.slice(0, 50)}`));
    }
  }
  return out;
}
function fromSheet(i: SheetItem, documentId: string, label: string): Omit<Requirement, "id"> {
  return { label, text: i.text, quote: i.quote, documentId, page: i.page, section: i.section, lines: i.lines, detail: `${i.text}\n"${i.quote}"`, needsScreenshot: i.kind === "screenshot" || screenshotWords.test(i.quote) };
}
function firstSentence(text: string) { return (text.match(/^.{0,160}?[.!?](\s|$)/)?.[0] ?? text.slice(0, 160)).trim(); }

export type PartStatus = "yes" | "no" | "unverified";
export interface PartCheck { part: RequirementPart; status: PartStatus; note: string; evidence?: string }

/**
 * Checks every requirement against the submission, part by part. The submission's own unit with the same number
 * ("Task 3" ↔ "Task 3") is the evidence; without numbered units, its best-matching passages are. Commands, word
 * limits and screenshots are checked mechanically; the remaining parts ("explain why…") are asked of the model as
 * yes/no questions, and a yes only counts when the words it points to are really in the submission. Screenshots
 * count only when a separately uploaded image's recognised text shows what the task needs.
 */
export async function reviewSubmission(input: {
  docs: StudyDoc[]; sheets: Map<string, StudySheet>; question?: string; generate: Generate; queryVector?: (text: string) => Promise<number[]>;
  onProgress?: (done: number, total: number, label: string) => void; signal?: AbortSignal;
}): Promise<ReviewResult> {
  const { docs, notes } = assignRoles(input.docs);
  const instructions = docs.filter(d => d.role === "instructions");
  const rubric = docs.filter(d => d.role === "rubric");
  const submissions = docs.filter(d => d.role === "submission");
  const screenshots = docs.filter(d => d.role === "screenshot");
  const requirements = listRequirements(instructions.length ? instructions : rubric, instructions.length ? rubric : [], input.sheets);
  const checks: RequirementCheck[] = [];
  if (!requirements.length || (!submissions.length && !screenshots.length)) return { checks, instructions: [...instructions, ...rubric], submissions, screenshots, notes };

  const subOutline = submissions.flatMap(d => outlineDocument(d.chunks));
  const numbered = subOutline.filter(s => s.level <= 2).length >= 2;
  const stored: StoredChunk[] = submissions.flatMap(d => d.chunks.map(c => ({ id: c.id, documentId: c.documentId, text: c.text, embedding: c.embedding ?? [], page: c.page, section: c.section, lines: c.lines })));
  const byId = new Map(submissions.flatMap(d => d.chunks.map(c => [c.id, c] as const)));
  const allText = submissions.map(d => d.chunks.map(c => c.text).join("\n")).join("\n\n");
  const embeddedImages = submissions.some(d => /pdf|word|officedocument/i.test(d.mimeType));
  const readable = screenshots.filter(s => s.chunks.length);

  for (const [i, r] of requirements.entries()) {
    input.signal?.throwIfAborted();
    input.onProgress?.(i, requirements.length, r.label);
    const same = r.number ? subOutline.filter(s => s.number === r.number && (s.kind === r.kind || s.kind === "item" || r.kind === "item")) : [];
    // The submission's answer to this requirement: its own section, else the passages that match it best.
    let answer = same.map(s => s.text).join("\n\n");
    let located = Boolean(answer);
    if (!answer) {
      const query = `${r.label} ${r.text} ${r.detail.slice(0, 400)}`;
      const vector = input.queryVector ? await input.queryVector(query) : [];
      const hits = stored.length ? retrieveChunks(query, vector, stored, { k: 3, perDocument: 3 }).map(h => byId.get(h.id)!) : [];
      answer = hits.map(c => c.text).join("\n\n").slice(0, 4000);
      located = false;
    }
    const overlap = (text: string) => { const words = new Set(tokenize(r.detail).filter(w => w.length > 3 && !genericWords.has(w))); return new Set(tokenize(text).filter(w => words.has(w))).size; };
    const parts = splitParts(r.detail);
    const shotPart = parts.find(p => p.kind === "screenshot");
    const matchingShots = shotPart ? readable.filter(s => screenshotMatches(s.chunks.map(c => c.text).join("\n"), shotPart, r.detail)) : [];
    const screenshot: RequirementCheck["screenshot"] = !shotPart ? "not-needed" : matchingShots.length ? "read" : !screenshots.length ? "missing" : readable.length ? "unmatched" : "unread";

    // Numbered submission without this number, or nothing related at all: missing, without asking a model.
    if (!same.length && ((numbered && r.number) || overlap(answer) < 2) && !matchingShots.length) {
      checks.push({ requirement: r, status: "missing", note: numbered && r.number ? `Your submission has no ${r.label} section.` : "Nothing in your submission addresses this.", screenshot, parts: [] });
      continue;
    }

    const results: PartCheck[] = [];
    const body = located ? same.map(s => s.text.split("\n").slice(1).join("\n")).join("\n\n") : "";
    for (const part of parts) {
      if (part.kind === "command") {
        const found = containsCommand(answer, part.command!) || (!located && containsCommand(allText, part.command!));
        results.push({ part, status: found ? "yes" : "no", note: found ? "" : `\`${part.command}\` is not shown`, evidence: found ? sentenceWith(answer || allText, part.command!) : undefined });
      } else if (part.kind === "length") {
        if (!located) { results.push({ part, status: "unverified", note: "its length couldn't be checked because no section of your submission is clearly this answer" }); continue; }
        const n = countWords(body), [lo, hi] = part.words!;
        results.push({ part, status: n >= lo && n <= hi ? "yes" : "no", note: n >= lo && n <= hi ? "" : `it is ${n} words; the instructions ask for ${hi === Infinity ? `at least ${lo}` : lo === 0 ? `at most ${hi}` : `${lo} to ${hi}`}` });
      } else if (part.kind === "screenshot") {
        results.push(matchingShots.length
          ? { part, status: "yes", note: "", evidence: `${matchingShots[0].name}: ${matchingShots[0].chunks[0].text.split("\n").find(l => part.command && containsCommand(l, part.command)) ?? matchingShots[0].chunks[0].text.split("\n")[0]}`.slice(0, 200) }
          : { part, status: screenshot === "missing" && !embeddedImages ? "no" : "unverified", note: screenshotNote(screenshot, embeddedImages) });
      }
    }
    // Judged parts are numbered P1, P2… within this question, however they were numbered among all the parts.
    const judged = parts.filter(p => p.kind === "judge");
    if (judged.length) {
      const asked = judged.map((p, n) => ({ ...p, id: `P${n + 1}` }));
      const verdicts = parsePartVerdicts(await input.generate(partMessages(r.label, r.detail, asked, answer), { maxTokens: 120 + 90 * judged.length }));
      for (const [n, part] of judged.entries()) {
        const v = verdicts.get(asked[n].id);
        if (!v) { results.push({ part, status: "unverified", note: "the check gave no usable answer" }); continue; }
        if (v.answer === "no") { results.push({ part, status: "no", note: v.text.replace(/^["“]|["”]$/g, "") || "not done" }); continue; }
        // A yes counts only with words from the submission behind it: the model's quote when it is really there, else
        // the sentence of the student's own answer that shares the most of the part's distinctive words.
        const evidence = (v.text ? supportingSentence(v.text, answer) : undefined) ?? bestSentence(part.text, answer, located ? 1 : 2);
        results.push(evidence ? { part, status: "yes", note: "", evidence } : { part, status: "unverified", note: "I couldn't find the words in your submission that show this" });
      }
    }
    // Keep the instructions' order of parts.
    results.sort((a, b) => parts.indexOf(a.part) - parts.indexOf(b.part));
    const yes = results.filter(p => p.status === "yes").length, no = results.filter(p => p.status === "no").length, unv = results.length - yes - no;
    const status: ReviewStatus = !results.length ? "unclear" : no === 0 && unv === 0 ? "met" : yes === 0 && unv === 0 ? "missing" : no === 0 && yes === 0 ? "unclear" : "partial";
    const missingParts = results.filter(p => p.status === "no").map(p => `${shorten(p.part.text)} (${p.note})`);
    const unverified = results.filter(p => p.status === "unverified").map(p => `${shorten(p.part.text)} (${p.note})`);
    const note = [missingParts.length ? `Missing: ${missingParts.join("; ")}.` : "", unverified.length ? `Couldn't verify: ${unverified.join("; ")}.` : ""].filter(Boolean).join(" ");
    const rank = { judge: 0, command: 1, length: 2, screenshot: 3 };
    const firstYes = results.filter(p => p.status === "yes" && p.evidence).sort((a, b) => rank[a.part.kind] - rank[b.part.kind])[0];
    const evidence = firstYes?.evidence ? locate(firstYes.evidence, [...submissions, ...screenshots]) ?? { documentId: (firstYes.part.kind === "screenshot" ? matchingShots[0] : submissions[0])?.id ?? "", quote: firstYes.evidence } : undefined;
    checks.push({ requirement: r, status, note, evidence, screenshot, parts: results });
  }
  input.onProgress?.(requirements.length, requirements.length, "done");
  if (screenshots.length) notes.push(readable.length ? "Screenshots were checked only through the text read from them (OCR); their visual content was not inspected." : "The uploaded screenshots contain no readable text, and their visual content could not be inspected.");
  if (embeddedImages && requirements.some(r => /screen ?shot/i.test(r.detail))) notes.push("Images inside PDF or Word files are not inspected.");
  return { checks, instructions: [...instructions, ...rubric], submissions, screenshots, notes };
}

/** The sentence of an answer sharing the most distinctive words with a part (at least `min` of them), if any. */
function bestSentence(partText: string, answer: string, min: number): string | undefined {
  const wanted = new Set(tokenize(partText).filter(w => (w.length > 3 || /\d/.test(w)) && !genericWords.has(w)));
  let best: string | undefined, bestScore = 0;
  for (const s of sentencesOf(answer).filter(x => x.split(/\s+/).length >= 4)) {
    const score = new Set(tokenize(s).filter(w => wanted.has(w))).size;
    if (score > bestScore) { bestScore = score; best = s; }
  }
  return bestScore >= min ? best?.slice(0, 300) : undefined;
}

function screenshotNote(state: RequirementCheck["screenshot"], embeddedImages: boolean): string {
  return state === "missing" ? (embeddedImages ? "no separate screenshot was uploaded, and images inside your submission file are not inspected" : "no screenshot was submitted")
    : state === "unread" ? "a screenshot was uploaded, but no text could be read from it"
      : "none of the uploaded screenshots shows this (judged from the text read from them)";
}
function shorten(text: string, max = 90) { const t = text.replace(/\s+/g, " ").trim().replace(/\.$/, ""); return t.length > max ? `${t.slice(0, max - 1)}…` : t; }
function sentenceWith(text: string, command: string): string | undefined {
  return sentencesOf(text).find(s => containsCommand(s, command))?.slice(0, 300);
}
/** Where a verified piece of evidence sits in the submitted files. */
function locate(quote: string, docs: StudyDoc[]): RequirementCheck["evidence"] | undefined {
  const q = normaliseText(quote);
  if (q.length < 6) return undefined;
  for (const d of docs) for (const c of d.chunks) {
    if (normaliseText(c.text).includes(q)) return { documentId: d.id, quote: quote.slice(0, 300), page: c.page, lines: c.lines };
  }
  return undefined;
}


/** Words every assignment uses; sharing them says nothing about whether a requirement is addressed. */
const genericWords = new Set(tokenize("task tasks question questions part step write explain describe answer include submit following using would should must make sure your their this that with what which each".replace(/\s+/g, " ")));

const mark: Record<ReviewStatus, string> = { met: "✓", partial: "⚠", missing: "✗", unclear: "?" };
/**
 * The answer to "is it complete?", assembled from the checks (not written by a model): the verdict first, then
 * every requirement with its status and evidence, what to fix, and what could not be verified.
 */
export function reviewAnswer(result: ReviewResult, ordinalOf: (documentId: string) => number | undefined): string {
  const { checks } = result;
  const cite = (id: string | undefined) => { const n = id ? ordinalOf(id) : undefined; return n ? ` [${n}]` : ""; };
  if (!result.submissions.length && !result.screenshots.length) {
    return [
      `I can't check completeness yet: I only have the instructions${result.instructions.length ? ` (${result.instructions.map(d => d.name).join(", ")})` : ""}, not your work.`,
      "Attach your submission (report, code or screenshots) and ask again."
    ].join(" ");
  }
  if (!checks.length) return `I couldn't find any requirements to check in ${result.instructions.map(d => d.name).join(", ") || "the instructions"}. If the instructions are an image or a scanned PDF, their text could not be read.`;
  const met = checks.filter(c => c.status === "met").length;
  const lines: string[] = [];
  lines.push(met === checks.length
    ? `**Yes** — based on the files and evidence I was able to verify, all ${checks.length} required items are present.`
    : `**Not yet.** ${met} of ${checks.length} requirements are complete.`);
  lines.push("");
  for (const c of checks) {
    const r = c.requirement;
    const where = cite(r.documentId);
    // A screenshot that proved the task is named, with the line read from it.
    const shot = c.parts.find(p => p.part.kind === "screenshot" && p.status === "yes" && p.evidence);
    const shotDoc = shot ? result.screenshots.find(s => shot.evidence!.startsWith(`${s.name}:`)) : undefined;
    const shotText = shot && shotDoc ? `; screenshot ${shotDoc.name} shows "${trim(shot.evidence!.slice(shotDoc.name.length + 1), 80)}"${cite(shotDoc.id)}` : "";
    const shown = c.status === "met" ? `Complete${c.evidence ? ` — "${trim(c.evidence.quote)}"${cite(c.evidence.documentId)}` : ""}${shotText}`
      : c.status === "partial" ? `${c.note}${c.evidence ? `${cite(c.evidence.documentId)}` : ""}`
      : c.status === "missing" ? `Missing — ${c.note.replace(/^Missing:\s*/, "")}`
      : /^Couldn't verify/.test(c.note) ? c.note : `Couldn't verify — ${c.note}`;
    lines.push(`- ${mark[c.status]} **${r.label}** — ${shown}${where && c.status !== "met" ? ` (required in${where})` : ""}`);
  }
  const todo = checks.filter(c => c.status !== "met");
  if (todo.length) {
    lines.push("", "### What to fix");
    todo.forEach((c, i) => lines.push(`${i + 1}. **${c.requirement.label}** (${trim(c.requirement.text, 120)}${c.requirement.page ? `, p. ${c.requirement.page}` : ""}): ${c.status === "missing" ? "add it — " : c.status === "unclear" ? "make it clearly visible — " : ""}${c.note}`));
  }
  if (result.notes.length) lines.push("", "### What I couldn't verify or assumed", ...result.notes.map(n => `- ${n}`));
  return lines.join("\n");
}
function trim(text: string, max = 140) { const t = text.replace(/\s+/g, " ").trim(); return t.length > max ? `${t.slice(0, max - 1)}…` : t; }
