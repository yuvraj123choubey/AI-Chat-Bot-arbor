export interface Edit { find: string; replace: string }
export class PatchError extends Error {}

const norm = (line: string) => line.trim().replace(/\s+/g, " ");
/** Models writing JSON often swap the file's quote style ('x' → "x"); the last-resort match ignores that. */
const normQuotes = (line: string) => norm(line).replace(/["'`]/g, "'");
/** The only quote character a piece of code uses, if it uses exactly one kind. */
function quoteStyle(text: string): string | undefined {
  const kinds = ["'", "\"", "`"].filter(q => text.includes(q));
  return kinds.length === 1 ? kinds[0] : undefined;
}

/**
 * Applies find/replace edits to a file. Each `find` must match exactly once — first as written, then (so a model
 * that got the indentation, spacing or quote style slightly wrong still succeeds) line by line ignoring whitespace,
 * then also ignoring which quote character is used. A failed
 * edit reports the closest lines so the next attempt can copy them exactly. All edits apply or none do.
 */
/** read_file shows lines as "  12| code"; models often copy that prefix into edits. */
const numberPrefix = /^\s*\d+\| ?/;
export function stripLineNumbers(edit: Edit): Edit {
  const lines = edit.find.split("\n").filter(l => l.trim());
  if (!lines.length || !lines.every(l => numberPrefix.test(l))) return edit;
  const strip = (text: string) => text.split("\n").map(l => l.replace(numberPrefix, "")).join("\n");
  return { find: strip(edit.find), replace: strip(edit.replace) };
}

export function applyEdits(content: string, rawEdits: Edit[]): { content: string; changes: { added: number; removed: number }[] } {
  const edits = rawEdits.map(stripLineNumbers);
  let text = content;
  const changes: { added: number; removed: number }[] = [];
  edits.forEach((edit, n) => {
    if (!edit.find) throw new PatchError(`Edit ${n + 1}: find is empty; use create_file for a new file`);
    const count = text.split(edit.find).length - 1;
    if (count === 1) {
      text = text.replace(edit.find, () => edit.replace);
    } else if (count > 1) {
      throw new PatchError(`Edit ${n + 1}: the find text appears ${count} times; include more surrounding lines so it is unique`);
    } else {
      const lines = text.split("\n");
      const want = edit.find.split("\n").map(norm).filter((l, i, all) => l || (i > 0 && i < all.length - 1));
      while (want.length && !want[0]) want.shift();
      while (want.length && !want.at(-1)) want.pop();
      if (!want.length) throw new PatchError(`Edit ${n + 1}: find has no content`);
      const find = (key: (line: string) => string) => {
        const target = want.map(key), found: number[] = [];
        for (let i = 0; i + want.length <= lines.length; i++) if (target.every((w, j) => key(lines[i + j]) === w)) found.push(i);
        return found;
      };
      let starts = find(norm);
      let replaceText = edit.replace;
      if (!starts.length) {
        starts = find(normQuotes);
        // Matched only by ignoring quotes: write the replacement in the file's quote style, not the model's.
        const fileQuote = starts.length === 1 ? quoteStyle(lines.slice(starts[0], starts[0] + want.length).join("\n")) : undefined;
        const modelQuote = quoteStyle(edit.find);
        if (fileQuote && modelQuote && fileQuote !== modelQuote) replaceText = replaceText.split(modelQuote).join(fileQuote);
      }
      if (starts.length !== 1) throw new PatchError(`Edit ${n + 1}: ${starts.length ? `the find text matches ${starts.length} places` : "the find text was not found"}.${starts.length ? "" : nearest(lines, want[0])} Copy the lines exactly from read_file (without line numbers).`);
      // Keep the file's own indentation for the first replaced line when the model's differs.
      const indent = lines[starts[0]].match(/^\s*/)![0];
      const replaceLines = replaceText.split("\n");
      const modelIndent = edit.find.split("\n").find(l => l.trim())?.match(/^\s*/)![0] ?? "";
      const reindented = replaceLines.map(l => (modelIndent !== indent && l.startsWith(modelIndent) ? indent + l.slice(modelIndent.length) : l));
      lines.splice(starts[0], want.length, ...reindented);
      text = lines.join("\n");
    }
    changes.push({ added: edit.replace ? edit.replace.split("\n").length : 0, removed: edit.find.split("\n").length });
  });
  return { content: text, changes };
}
function nearest(lines: string[], first: string): string {
  const words = new Set(first.toLowerCase().match(/\w+/g) ?? []);
  let best = -1, bestScore = 0;
  lines.forEach((l, i) => {
    const score = (l.toLowerCase().match(/\w+/g) ?? []).filter(w => words.has(w)).length;
    if (score > bestScore) { bestScore = score; best = i; }
  });
  return best >= 0 ? ` Closest line is ${best + 1}: "${lines[best].trim().slice(0, 160)}".` : "";
}
