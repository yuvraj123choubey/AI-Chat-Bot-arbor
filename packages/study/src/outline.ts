import type { StudyChunk } from "./types.ts";

export type SegmentKind = "part" | "task" | "question" | "exercise" | "problem" | "activity" | "checkpoint" | "deliverable" | "step" | "item";
/**
 * A numbered unit of a document ("Task 3", "Question 4", "Part B", "2.") with its full text and place.
 * Lower `level` numbers are larger units: a part contains tasks, a task contains steps.
 */
export interface Segment {
  kind: SegmentKind; level: number; number: string; label: string; heading: string; text: string;
  documentId: string; page?: number; section?: string; lines?: [number, number]; ordinal: number;
  /** Ordinals of the stored chunks the unit spans. */
  ordinals: number[];
}

const kindOf: Record<string, SegmentKind> = {
  part: "part", task: "task", "lab task": "task", question: "question", q: "question", exercise: "exercise", problem: "problem",
  activity: "activity", checkpoint: "checkpoint", deliverable: "deliverable", step: "step"
};
const levelOf: Record<SegmentKind, number> = { part: 1, task: 2, question: 2, exercise: 2, problem: 2, activity: 2, checkpoint: 2, deliverable: 2, item: 2, step: 3 };
const named = /^\s*(?:#{1,4}\s*)?(?:\*\*)?\s*(lab task|task|question|exercise|problem|part|step|activity|checkpoint|deliverable|q)\s*[-#:.]?\s*(\d{1,3}(?:\.\d{1,2})?[a-z]?|[a-h]|[ivx]{1,4})(?![\w&])[\s).:\-–—*]*(.{0,160})$/i;
const numbered = /^\s*(\d{1,2})[.)]\s+(\S.{3,200})$/;

interface Line { text: string; documentId: string; page?: number; section?: string; line?: number; ordinal: number }
function linesOf(chunks: StudyChunk[]): Line[] {
  const out: Line[] = [];
  for (const chunk of [...chunks].sort((a, b) => a.ordinal - b.ordinal)) {
    chunk.text.split("\n").forEach((text, i) => out.push({ text, documentId: chunk.documentId, page: chunk.page, section: chunk.section, line: chunk.lines ? chunk.lines[0] + i : undefined, ordinal: chunk.ordinal }));
  }
  return out;
}

/**
 * Finds a document's numbered units without a model: named headings ("Task 3", "Question 4:", "Part B") when the
 * document has them, otherwise a top-level numbered list ("1. … 2. …"). Each unit runs to the next heading of the
 * same or a larger level, so "Task 3" includes its steps and a "Part" includes its tasks.
 */
export function outlineDocument(chunks: StudyChunk[]): Segment[] {
  const lines = linesOf(chunks);
  const heads: { at: number; kind: SegmentKind; number: string; rest: string }[] = [];
  lines.forEach((l, at) => {
    const m = l.text.match(named);
    if (!m) return;
    const kind = kindOf[m[1].toLowerCase()];
    // "Question 4 asks you to …" in a paragraph is prose, not a heading: headings are short lines.
    if (l.text.trim().length > 170) return;
    heads.push({ at, kind, number: m[2].toLowerCase(), rest: m[3].replace(/\*\*/g, "").trim() });
  });
  if (heads.filter(h => levelOf[h.kind] <= 2).length < 2) {
    // No named units: a top-level numbered list (the first run 1, 2, 3, …; nested lists restart and are skipped).
    let last = 0;
    lines.forEach((l, at) => {
      const m = l.text.match(numbered);
      if (!m) return;
      const n = Number(m[1]);
      if (n !== last + 1) return;
      last = n;
      heads.push({ at, kind: "item", number: String(n), rest: m[2].trim() });
    });
    heads.sort((a, b) => a.at - b.at);
  }
  return heads.map((h, i) => {
    const level = levelOf[h.kind];
    const next = heads.slice(i + 1).find(o => levelOf[o.kind] <= level);
    const body = lines.slice(h.at, next ? next.at : lines.length);
    const first = body[0], lastLine = body.findLast(l => l.text.trim()) ?? first;
    const label = `${h.kind[0].toUpperCase()}${h.kind.slice(1)} ${/^[a-h]$/.test(h.number) ? h.number.toUpperCase() : h.number}`;
    return {
      kind: h.kind, level, number: h.number, label, heading: first.text.trim(), text: clip(body.map(l => l.text).join("\n").trim(), 8000),
      documentId: first.documentId, page: first.page, section: first.section, ordinal: first.ordinal, ordinals: [...new Set(body.map(l => l.ordinal))],
      ...(first.line !== undefined && lastLine.line !== undefined ? { lines: [first.line, lastLine.line] as [number, number] } : {})
    };
  });
}

const refPattern = /\b(lab task|task|question|exercise|problem|part|step|activity|checkpoint|deliverable|item|q|number|no\.?|#)\s*[-#:.]?\s*(\d{1,3}(?:\.\d{1,2})?[a-z]?|[a-h]|[ivx]{1,4})\b/gi;
export interface SegmentRef { kind?: SegmentKind; number: string; text: string }
/** Units the question names: "question 4", "task 3b", "part B", "Q2", "#5". */
export function segmentRefs(question: string): SegmentRef[] {
  const refs: SegmentRef[] = [];
  for (const m of question.matchAll(refPattern)) {
    const word = m[1].toLowerCase().replace(/\.$/, "");
    // Single letters and roman numerals only count after a unit word ("part b"), never after "number"/"#".
    if (/^[a-h]$|^[ivx]+$/i.test(m[2]) && !kindOf[word]) continue;
    refs.push({ kind: kindOf[word] ?? (word === "item" ? "item" : undefined), number: m[2].toLowerCase(), text: m[0] });
  }
  return refs;
}

/** The units a question refers to: same kind and number first, then the same number in any kind. */
export function findSegments(refs: SegmentRef[], outline: Segment[]): { found: Segment[]; missing: SegmentRef[] } {
  const found: Segment[] = [], missing: SegmentRef[] = [];
  for (const ref of refs) {
    const sameKind = outline.filter(s => s.number === ref.number && (!ref.kind || s.kind === ref.kind || (s.kind === "item" && ref.kind !== "part" && ref.kind !== "step")));
    const any = sameKind.length ? sameKind : ref.kind === "step" || ref.kind === "part" ? [] : outline.filter(s => s.number === ref.number && s.level === 2);
    if (any.length) found.push(...any.filter(s => !found.includes(s)));
    else missing.push(ref);
  }
  return { found, missing };
}

/** A one-line-per-unit table of contents, for the model to see the whole structure at once. */
export function outlineBlock(outline: Segment[], name: string): string {
  if (!outline.length) return "";
  return `Structure of ${name}:\n${outline.map(s => `${"  ".repeat(Math.max(0, s.level - 1))}- ${s.heading.slice(0, 140)}${s.page ? ` (p. ${s.page})` : s.lines ? ` (lines ${s.lines[0]}–${s.lines[1]})` : ""}`).join("\n")}`;
}

function clip(text: string, max: number) { return text.length > max ? `${text.slice(0, max)}\n…` : text; }
