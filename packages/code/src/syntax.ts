import { spawnSync } from "node:child_process";
import { extname } from "node:path";

export interface SyntaxProblem { line: number; column: number; message: string }

/**
 * Parses a source file and reports its first syntax error. Returns null when the file parses, and undefined for
 * languages it cannot check. JavaScript is parsed with acorn (as a module, then as a script), TypeScript and JSX
 * with the TypeScript parser, JSON with JSON.parse.
 */
export async function syntaxProblem(path: string, content: string): Promise<SyntaxProblem | null | undefined> {
  const ext = extname(path).toLowerCase();
  if (ext === ".json") {
    try { JSON.parse(content); return null; }
    catch (error) {
      const at = Number((error as Error).message.match(/position (\d+)/)?.[1] ?? 0);
      const before = content.slice(0, at).split("\n");
      return { line: before.length, column: before.at(-1)!.length + 1, message: (error as Error).message.replace(/ in JSON at position \d+.*$/, "") };
    }
  }
  if ([".js", ".mjs", ".cjs"].includes(ext)) {
    const { parse } = await import("acorn");
    const attempt = (sourceType: "module" | "script") => {
      try { parse(content, { ecmaVersion: "latest", sourceType, allowHashBang: true, allowAwaitOutsideFunction: sourceType === "module" }); return null; }
      catch (error) {
        const e = error as Error & { loc?: { line: number; column: number } };
        return { line: e.loc?.line ?? 1, column: (e.loc?.column ?? 0) + 1, message: e.message.replace(/\s*\(\d+:\d+\)$/, "") };
      }
    };
    const asModule = attempt("module");
    if (!asModule) return null;
    const asScript = attempt("script");
    if (!asScript) return null;
    return /^\s*(import|export)\b/m.test(content) ? asModule : asScript;
  }
  if ([".ts", ".tsx", ".mts", ".cts", ".jsx"].includes(ext)) {
    let ts: typeof import("typescript");
    try { ts = (await import("typescript")).default; } catch { return undefined; }
    const kind = ext === ".tsx" ? ts.ScriptKind.TSX : ext === ".jsx" ? ts.ScriptKind.JSX : ts.ScriptKind.TS;
    const file = ts.createSourceFile(path, content, ts.ScriptTarget.Latest, true, kind);
    const diagnostic = (file as unknown as { parseDiagnostics?: import("typescript").DiagnosticWithLocation[] }).parseDiagnostics?.[0];
    if (!diagnostic) return null;
    const { line, character } = file.getLineAndCharacterOfPosition(diagnostic.start);
    return { line: line + 1, column: character + 1, message: ts.flattenDiagnosticMessageText(diagnostic.messageText, " ") };
  }
  if (ext === ".py") return pythonProblem(content);
  return undefined;
}

/** A Python interpreter on this machine, if any (checked once). */
let python: string | null | undefined;
function findPython(): string | null {
  if (python !== undefined) return python;
  for (const cmd of process.platform === "win32" ? ["python", "py", "python3"] : ["python3", "python"]) {
    const probe = spawnSync(cmd, ["-c", "import ast"], { timeout: 5000, windowsHide: true });
    if (probe.status === 0) return (python = cmd);
  }
  return (python = null);
}
/** Parses Python with Python's own ast module (no code is run). */
function pythonProblem(content: string): SyntaxProblem | null | undefined {
  const cmd = findPython();
  if (!cmd) return undefined;
  const script = "import ast,sys\ntry:\n ast.parse(sys.stdin.read())\nexcept SyntaxError as e:\n print(e.lineno or 1, e.offset or 1, e.msg)";
  const result = spawnSync(cmd, ["-c", script], { input: content, timeout: 10_000, windowsHide: true, encoding: "utf8" });
  if (result.status !== 0) return undefined;
  const m = result.stdout.trim().match(/^(\d+) (\d+) (.+)$/);
  return m ? { line: Number(m[1]), column: Number(m[2]), message: m[3] } : null;
}

/**
 * The syntax error an edit would introduce, if any: only when the file parsed before the edit and does not after,
 * so syntax the parser does not know (and files that were already broken) never block an edit.
 */
export async function introducedSyntaxError(path: string, before: string | null, after: string): Promise<SyntaxProblem | undefined> {
  if (before !== null && (await syntaxProblem(path, before)) !== null) return undefined;
  const now = await syntaxProblem(path, after);
  return now ?? undefined;
}
