import { segmentRefs, type SegmentRef } from "./outline.ts";

/**
 * What a request about the user's material needs:
 * - lookup: one part ("What does question 4 mean?") — the named unit and the passages that match;
 * - whole: the complete material ("Study this lab and help me complete it") — every task, requirement and restriction;
 * - review: a submission against its instructions ("Is my submission complete?") — every requirement checked.
 */
export type StudyScope = "lookup" | "whole" | "review";
export interface StudyPlan { scope: StudyScope; refs: SegmentRef[]; reason: string }

const reviewPattern = /\b(is|are|was)\b[^.?!]{0,60}\b(complete|completed|done|finished|ready|correct|right|good enough|everything)\b|\b(did|have) i\b[^.?!]{0,40}\b(miss|forget|forgot|complete|finish|answer|cover|include)|\bcheck (my|the|this|our)\b[^.?!]{0,30}\b(submission|work|answers?|lab|assignment|report|homework|solution|code|essay)|\bgrade (my|this)|\b(missing|left out) anything\b|\bwhat('s| is| am i) missing\b|\bready to submit\b|\bmeet(s)? (all )?(the )?(requirements|rubric|criteria)\b|\b(compare|check) (it |this |my \w+ )?(against|with) (the )?(rubric|instructions|requirements)/i;
const wholePattern = /\b(study|summari[sz]e|overview|walk me through|go through|break down|help me (complete|do|finish|with|understand|solve|start)|what (do|should) i (need|have) to do|what('s| is) (this|the) (lab|assignment|document|paper|homework|project) (about|asking)|all (the |of the )?(tasks|questions|requirements|steps|parts|deliverables|exercises|problems)|(entire|whole|full|complete) (lab|assignment|document|file|paper|pdf|homework|project)|every (task|question|requirement|step)|explain (this|the) (lab|assignment|document|paper|homework|project|file|pdf)|teach me|understand (this|the) (lab|assignment|document|material))\b/i;

/** Decides the scope from the wording; a question that names one unit is a lookup even if it says "explain". */
export function planStudy(question: string): StudyPlan {
  const refs = segmentRefs(question);
  if (reviewPattern.test(question)) return { scope: "review", refs, reason: "asks whether work is complete or correct against its requirements" };
  if (refs.length && !/\ball\b|\bevery\b/i.test(question)) return { scope: "lookup", refs, reason: `asks about ${refs.map(r => r.text).join(", ")}` };
  if (wholePattern.test(question)) return { scope: "whole", refs, reason: "asks about the material as a whole" };
  return { scope: "lookup", refs, reason: "asks a specific question" };
}
