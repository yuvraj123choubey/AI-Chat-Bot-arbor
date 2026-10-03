import { describeLocator, retrieveChunks, type StoredChunk } from "../../files/src/retrieve.ts";
import { tokenize } from "../../research/src/passages.ts";
import type { EvidenceSource, Passage } from "../../research/src/types.ts";
import { findSegments, outlineBlock, outlineDocument, type Segment } from "./outline.ts";
import type { StudyPlan } from "./plan.ts";
import { sheetBlock, type StudySheet } from "./sheet.ts";
import type { StudyChunk, StudyDoc } from "./types.ts";

/** Documents shorter than this are always read completely: reading them whole is cheap and avoids missing context. */
const SMALL_DOC = 7000;

export interface StudyMaterial {
  /** One numbered source per document, with the passages the model may see (in document order, with places). */
  evidence: EvidenceSource[];
  /** Structure and study notes shown before the sources (not citable on their own). */
  brief: string;
  /** Things the question asks about that the material does not contain ("Question 7 is not in lab5.pdf"). */
  notFound: string[];
  /** How each document was read, for the status line and the answer's honesty notes. */
  reading: { name: string; mode: "complete" | "sections" | "passages" | "image-text" | "image-unread"; chars: number }[];
}

function docChars(doc: StudyDoc) { return doc.chunks.reduce((n, c) => n + c.text.length, 0); }
function passage(chunk: StudyChunk, score = 1): Passage {
  return { text: `(${describeLocator(chunk) || "excerpt"}) ${chunk.text}`, start: chunk.ordinal, score };
}

/**
 * Gathers what a question about the user's documents needs, according to the study plan:
 * - whole: every document completely when it fits the budget; otherwise as much as fits in order, plus the
 *   document's structure and its study notes, which cover all of it;
 * - lookup: the units the question names ("question 4") in full, the best-matching passages, and a second
 *   retrieval for question words the first pass did not cover; small documents are read completely.
 * Units the question names that do not exist are reported, so the answer can say so instead of guessing.
 */
export function gatherMaterial(input: {
  question: string; plan: StudyPlan; docs: StudyDoc[]; queryVector: number[]; budgetChars: number; sheets?: Map<string, StudySheet>;
}): StudyMaterial {
  const { question, plan, queryVector, budgetChars } = input;
  const docs = input.docs.map(d => ({ ...d, chunks: [...d.chunks].sort((a, b) => a.ordinal - b.ordinal) }));
  const outlines = new Map(docs.map(d => [d.id, outlineDocument(d.chunks)]));
  const allSegments = [...outlines.values()].flat();
  const chosen = new Map<string, Map<number, Passage>>(docs.map(d => [d.id, new Map()]));
  const extraPassages = new Map<string, Passage[]>(docs.map(d => [d.id, []]));
  const covered = new Map<string, Set<number>>(docs.map(d => [d.id, new Set()]));
  const notFound: string[] = [];
  const reading: StudyMaterial["reading"] = [];
  let used = 0;
  const take = (chunk: StudyChunk, score = 1) => {
    const set = chosen.get(chunk.documentId)!;
    if (set.has(chunk.ordinal) || covered.get(chunk.documentId)!.has(chunk.ordinal) || used + chunk.text.length > budgetChars) return false;
    set.set(chunk.ordinal, passage(chunk, score));
    used += chunk.text.length;
    return true;
  };

  const total = docs.reduce((n, d) => n + docChars(d), 0);
  if (plan.scope !== "lookup" && total <= budgetChars) {
    for (const doc of docs) { for (const c of doc.chunks) take(c); }
  } else {
    // The named units first, in full.
    const { found, missing } = findSegments(plan.refs, allSegments);
    for (const ref of missing) notFound.push(`${ref.text.trim()} — no unit with that number was found in ${docs.map(d => d.name).join(", ")}`);
    for (const seg of found) addSegment(seg);
    // Small documents are read completely.
    for (const doc of docs) if (docChars(doc) <= SMALL_DOC) for (const c of doc.chunks) take(c);
    // Then the passages that best match the question, and a second pass for words the first did not cover.
    const stored: StoredChunk[] = docs.flatMap(d => d.chunks.map(c => ({ id: c.id, documentId: c.documentId, text: c.text, embedding: c.embedding ?? [], page: c.page, section: c.section, lines: c.lines })));
    const byId = new Map(docs.flatMap(d => d.chunks.map(c => [c.id, c] as const)));
    const k = plan.scope === "lookup" ? 8 : 16;
    for (const hit of retrieveChunks(question, queryVector, stored, { k, perDocument: plan.scope === "lookup" ? 5 : 10 })) take(byId.get(hit.id)!, hit.score);
    const seen = tokenize([...chosen.values()].flatMap(m => [...m.values()].map(p => p.text)).join(" "));
    const missingTerms = [...new Set(tokenize(question))].filter(t => t.length > 3 && !seen.includes(t));
    if (missingTerms.length) for (const hit of retrieveChunks(missingTerms.join(" "), queryVector, stored, { k: 4, perDocument: 2, minSimilarity: 1 })) take(byId.get(hit.id)!, hit.score);
    // For the whole material, fill the rest of the budget in reading order so the beginning of every document is seen.
    if (plan.scope !== "lookup") for (const doc of docs) for (const c of doc.chunks) { if (used + c.text.length > budgetChars) break; take(c); }
  }

  function addSegment(seg: Segment) {
    // A unit is quoted as one passage (its exact text), even when it spans several stored chunks.
    if (used + seg.text.length > budgetChars) return;
    extraPassages.get(seg.documentId)!.push({ text: `(${[seg.label, describeLocator({ page: seg.page, lines: seg.lines })].filter(Boolean).join(", ")}) ${seg.text}`, start: seg.ordinal - 0.5, score: 2 });
    used += seg.text.length;
    for (const o of seg.ordinals) covered.get(seg.documentId)!.add(o);
  }

  const evidence: EvidenceSource[] = [];
  const briefs: string[] = [];
  for (const doc of docs) {
    const passages = [...extraPassages.get(doc.id)!, ...chosen.get(doc.id)!.values()].sort((a, b) => a.start - b.start);
    const chars = docChars(doc);
    const complete = doc.chunks.every(c => chosen.get(doc.id)!.has(c.ordinal) || covered.get(doc.id)!.has(c.ordinal));
    reading.push({ name: doc.name, chars, mode: doc.image ? (doc.chunks.length ? "image-text" : "image-unread") : complete ? "complete" : extraPassages.get(doc.id)!.length ? "sections" : "passages" });
    const outline = outlines.get(doc.id)!;
    if (!complete && outline.length) briefs.push(outlineBlock(outline, doc.name));
    const sheet = input.sheets?.get(doc.id);
    if (sheet && !complete) briefs.push(sheetBlock(sheet, doc.name));
    if (!passages.length && !doc.image) continue;
    const ordinal = evidence.length + 1;
    // The citation card opens at the passage that best answers the question, not simply at the first one read.
    const toStored = (c: StudyChunk): StoredChunk => ({ id: c.id, documentId: c.documentId, text: c.text, embedding: c.embedding ?? [], page: c.page, section: c.section, lines: c.lines });
    const top = retrieveChunks(question, queryVector, doc.chunks.map(toStored), { k: 1 })[0];
    const first = (top && doc.chunks.find(c => c.id === top.id)) ?? doc.chunks.find(c => passages.some(p => p.start === c.ordinal)) ?? doc.chunks[0];
    const best = passages.find(p => p.start === first?.ordinal) ?? passages[0];
    evidence.push({
      ordinal, passages: passages.length ? passages : [{ text: "(image) No text could be read from this image, and its visual content was not inspected.", start: 0, score: 0 }],
      source: {
        url: `/api/documents/${doc.id}/file`, canonicalUrl: `arbor-document:${doc.id}`, title: doc.name, domain: "Your files", publisher: doc.image ? "Uploaded image" : "Uploaded file",
        snippet: (best?.text ?? "").slice(0, 300), fullText: passages.map(p => p.text).join("\n\n"), sourceType: "uploaded_file",
        searchQuery: question.slice(0, 500), readMode: complete ? "page" : "snippet",
        metadata: { documentId: doc.id, locator: first ? { page: first.page, section: first.section, lines: first.lines } : {}, reading: reading.at(-1)!.mode }
      }
    });
  }
  return { evidence, brief: briefs.filter(Boolean).join("\n\n"), notFound, reading };
}

/** A plain statement of how the material was read, for the model and for the user. */
export function readingNote(reading: StudyMaterial["reading"]): string {
  return reading.map(r => `${r.name}: ${r.mode === "complete" ? "read completely" : r.mode === "sections" ? "the relevant sections and passages were read" : r.mode === "passages" ? "only the best-matching passages were read" : r.mode === "image-text" ? "image — only the text in it was read (OCR); its visual content was not inspected" : "image — its content could not be inspected"}`).join("\n");
}
