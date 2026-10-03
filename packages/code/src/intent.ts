/** A task phrased as a question or explanation request; finishing without edits is normal for these. */
export function isQuestion(task: string): boolean {
  const asks = /^\s*(what|why|how|where|which|who|when|explain|describe|does|do|is|are|can|could|should|show me|tell me|summari[sz]e|review)\b/i.test(task) || /\?\s*$/.test(task.trim());
  return asks && !/\b(fix|add|change|make|implement|rename|refactor|update|remove|create)\b/i.test(task);
}
/** A task that reports wrong behaviour (as opposed to asking for something new). */
export function looksLikeBugReport(task: string): boolean {
  return /\b(bug|wrong|incorrect|instead of|broken|fails?|failing|doesn'?t work|does not work|not working|crash(es)?|error|too (much|many|few|little|high|low)|should (be|cost|show|return|say))\b/i.test(task);
}
