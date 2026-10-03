import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

export type CheckName = "test" | "typecheck" | "lint" | "build";
export interface Check { name: CheckName; command: string }

/**
 * The verification commands a project actually has: its own package.json scripts first, then conventions
 * (Node's built-in test runner for *.test.js files, tsc for a TypeScript project, pytest for Python tests).
 */
export async function detectChecks(root: string, paths: string[]): Promise<Check[]> {
  const checks: Check[] = [];
  let pkg: any;
  if (existsSync(join(root, "package.json"))) { try { pkg = JSON.parse(await readFile(join(root, "package.json"), "utf8")); } catch { pkg = {}; } }
  const scripts: Record<string, string> = pkg?.scripts ?? {};
  const deps = { ...pkg?.dependencies, ...pkg?.devDependencies };
  if (scripts.typecheck) checks.push({ name: "typecheck", command: "npm run typecheck" });
  else if (existsSync(join(root, "tsconfig.json")) && deps.typescript) checks.push({ name: "typecheck", command: "npx tsc --noEmit" });
  if (scripts.lint) checks.push({ name: "lint", command: "npm run lint" });
  if (scripts.test && !/no test specified/.test(scripts.test)) checks.push({ name: "test", command: "npm test" });
  else if (paths.some(p => /(^|\/)[^/]*\.test\.(m?js|cjs)$/.test(p) || /^test\/.*\.(m?js|cjs)$/.test(p))) checks.push({ name: "test", command: "node --test" });
  else if (paths.some(p => /(^|\/)(test_[^/]*|[^/]*_test)\.py$/.test(p))) checks.push({ name: "test", command: "python -m pytest -q" });
  if (scripts.build) checks.push({ name: "build", command: "npm run build" });
  return checks;
}
/** Dependencies are declared but not installed, so checks would fail for the wrong reason. */
export async function needsInstall(root: string): Promise<boolean> {
  if (!existsSync(join(root, "package.json")) || existsSync(join(root, "node_modules"))) return false;
  try { const pkg = JSON.parse(await readFile(join(root, "package.json"), "utf8")); return Object.keys({ ...pkg.dependencies, ...pkg.devDependencies }).length > 0; } catch { return false; }
}
/** pytest may not be installed; the standard library's unittest runs the same test_*.py files. */
export const pytestMissing = (output: string) => /No module named pytest/i.test(output);
