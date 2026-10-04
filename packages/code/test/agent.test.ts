import test from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CommandRunner, ProjectFiles, findBrowser, isTestFile, ProjectHistory, applyEdits, detectChecks, extractImports, extractSymbols, failureDigest, findSymbol, indexRepo, referencedFiles, relevantFiles, runAgent, validateAction, type AgentAction } from "../src/index.ts";

async function project(files: Record<string, string>) {
  const base = await mkdtemp(join(tmpdir(), "arbor-agent-"));
  const root = join(base, "p");
  await mkdir(root);
  for (const [path, content] of Object.entries(files)) { await mkdir(join(root, path, ".."), { recursive: true }); await writeFile(join(root, path), content); }
  return { base, root, files: new ProjectFiles(root), history: new ProjectHistory(root, join(base, "history.git")), runner: new CommandRunner(() => join(base, "logs")), cleanup: () => rm(base, { recursive: true, force: true, maxRetries: 5 }) };
}
const mathProject = {
  "package.json": JSON.stringify({ type: "module", scripts: { test: "node --test" } }),
  "src/math.js": "export function add(a, b) {\n  return a - b;\n}\n\nexport const double = x => add(x, x);\n",
  "src/index.js": "import { add } from './math.js';\nconsole.log(add(2, 3));\n",
  "src/math.test.js": "import test from 'node:test';\nimport assert from 'node:assert/strict';\nimport { add } from './math.js';\ntest('add', () => assert.equal(add(2, 3), 5));\n"
};
function scripted(script: AgentAction[]) {
  const seen: string[] = [];
  return { seen, next: async (messages: { content: string }[]) => { seen.push(messages.map(m => m.content).join("\n=====\n")); return script.shift() ?? { action: "finish" as const, summary: "out of script" }; } };
}

test("repo index: symbols, imports, who-imports-whom, and relevant files for a task", async () => {
  const p = await project({ ...mathProject, "lib/util.py": "from .helpers import clean\n\nclass Parser:\n    def parse(self, s):\n        return clean(s)\n", "lib/helpers.py": "def clean(s):\n    return s.strip()\n", "lib/__init__.py": "" });
  try {
    const index = await indexRepo(p.files);
    assert.deepEqual(index.files.get("src/math.js")!.symbols.map(s => `${s.kind}:${s.name}:${s.line}`), ["function:add:1", "function:double:5"]);
    assert.deepEqual([...index.importedBy.get("src/math.js")!].sort(), ["src/index.js", "src/math.test.js"]);
    assert.equal(index.files.get("lib/util.py")!.imports[0].file, "lib/helpers.py");
    assert.deepEqual(findSymbol(index, "Parser").map(s => `${s.path}:${s.line}`), ["lib/util.py:3"]);
    assert.deepEqual(findSymbol(index, "parse").map(s => s.kind), ["method"]);
    assert.equal(relevantFiles(index, "add() returns the wrong sum")[0].path, "src/math.js");
    assert.deepEqual(extractImports("typescript", `import x from "./a.js";\nconst y = await import("./b");\nexport * from "../c";`).map(i => i.spec), ["./a.js", "./b", "../c"]);
    assert.deepEqual(extractSymbols("typescript", "export async function go() {}\nexport class Box {}\nexport interface Shape {}\nconst f = async (a: number) => a;").map(s => s.name), ["go", "Box", "Shape", "f"]);
    assert.deepEqual(referencedFiles("TypeError at src/math.js:2:3\n    at ./src/index.js:1", new Set(index.files.keys())), ["src/math.js", "src/index.js"]);
    assert.deepEqual(await detectChecks(p.root, [...index.files.keys()]), [{ name: "test", command: "npm test" }]);
  } finally { await p.cleanup(); }
});

test("patches: exact, whitespace-tolerant, unique, all-or-nothing, with a hint when not found", () => {
  const src = "function a() {\n    return 1;\n}\nfunction b() {\n    return 1;\n}\n";
  assert.throws(() => applyEdits(src, [{ find: "return 1;", replace: "return 2;" }]), /appears 2 times/);
  assert.equal(applyEdits(src, [{ find: "function b() {\n    return 1;", replace: "function b() {\n    return 2;" }]).content, "function a() {\n    return 1;\n}\nfunction b() {\n    return 2;\n}\n");
  // Wrong indentation in `find` still matches line by line, and the file's own indentation is kept.
  assert.equal(applyEdits("if (x) {\n\t\tgo();\n}\n", [{ find: "  go();", replace: "  stop();" }]).content, "if (x) {\n\t\tstop();\n}\n");
  assert.throws(() => applyEdits(src, [{ find: "function a() {", replace: "x" }, { find: "nope()", replace: "y" }]), /Edit 2: the find text was not found/);
  assert.throws(() => applyEdits(src, [{ find: "function c() {", replace: "" }]), /Closest line is 1/);
  // A model that rewrote the file's single quotes as double quotes still matches, and the result keeps the file's style.
  const esc = "export function escape(text) {\n  return String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;');\n}\n";
  assert.equal(applyEdits(esc, [{ find: "  return String(text).replace(/&/g, \"&amp;\").replace(/</g, \"&lt;\");", replace: "  return String(text).replace(/&/g, \"&amp;\").replace(/</g, \"&lt;\").replace(/>/g, \"&gt;\");" }]).content,
    "export function escape(text) {\n  return String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');\n}\n");
  assert.match(failureDigest("ok 1\nnot ok 2 - add\n  expected: 5\n  actual: -1\n    at node:internal/x"), /not ok 2[\s\S]*expected: 5[\s\S]*actual: -1/);
});

test("tool validation gives the model a usable reason", () => {
  assert.equal(typeof validateAction({ action: "apply_patch", path: "x" }), "string");
  assert.equal(typeof validateAction({ action: "teleport" }), "string");
  assert.deepEqual(validateAction({ action: "run_command", command: " npm test ", note: "n" }), { action: "run_command", command: "npm test", note: "n" });
  assert.deepEqual(validateAction({ action: "read_range", path: "a.js", start_line: 10.4, end_line: 20 }), { action: "read_range", path: "a.js", start_line: 10, end_line: 20, note: undefined });
});

test("agent: baseline failure, inspect, refuse blind patch, patch, verified finish, metrics, revertible", async () => {
  const p = await project(mathProject);
  await p.history.checkpoint("Initial", "you");
  const s = scripted([
    { action: "update_plan", plan: [{ step: "Find add()", status: "doing" }, { step: "Fix and test", status: "todo" }], note: "Plan" },
    { action: "find_symbol", name: "add" },
    { action: "apply_patch", path: "src/math.js", edits: [{ find: "return a - b;", replace: "return a + b;" }] },
    { action: "read_file", path: "src/math.js" },
    { action: "apply_patch", path: "src/math.js", edits: [{ find: "  return a - b;", replace: "  return a + b;" }], note: "Fix the operator" },
    { action: "git_diff", path: "src/math.js" },
    { action: "finish", summary: "Fixed add(); tests pass." }
  ]);
  const events: string[] = [];
  try {
    const result = await runAgent({ files: p.files, history: p.history, runner: p.runner, projectId: "p", next: s.next, event: e => events.push(`${e.kind}:${e.title}`) }, "add() returns the wrong result; fix it");
    assert.match(s.seen[0], /BASELINE \(before any change\):\nnpm test: FAILING/);
    assert.match(s.seen[0], /Likely relevant files:\n- src\/math\.js/);
    assert.match(s.seen[1], /\[~\] Find add\(\)/, "the plan is kept in memory");
    assert.match(s.seen[2], /function add — src\/math\.js:1 \(exported\); src\/math\.js is imported by/);
    assert.match(s.seen[3], /ERROR: Read src\/math\.js before patching it/);
    assert.match(s.seen[6], /- {2}return a - b;\n\+ {2}return a \+ b;/);
    assert.equal(result.summary, "Fixed add(); tests pass.");
    assert.equal(result.metrics.success, true);
    assert.equal(result.metrics.checksPassing, true);
    assert.equal(result.metrics.filesChanged, 1);
    assert.deepEqual([result.metrics.linesAdded, result.metrics.linesRemoved], [1, 1]);
    assert.ok(events.includes("check:npm test → passed"), "finish ran the checks automatically");
    await p.history.restore(result.baseCommit!, "before agent");
    assert.match(await readFile(join(p.root, "src/math.js"), "utf8"), /return a - b;/);
  } finally { p.runner.stopAll(); await p.cleanup(); }
});

test("agent: cannot finish while its edits break the tests; it fixes, retests, and counts the retry", async () => {
  const p = await project({ ...mathProject, "src/math.js": "export function add(a, b) {\n  return a + b;\n}\n" });
  const s = scripted([
    { action: "read_file", path: "src/math.js" },
    { action: "apply_patch", path: "src/math.js", edits: [{ find: "return a + b;", replace: "return a * b;" }], note: "Bad change" },
    { action: "finish", summary: "Done" },
    { action: "apply_patch", path: "src/math.js", edits: [{ find: "return a * b;", replace: "return a + b;" }], note: "Undo the bad change" },
    { action: "run_tests" },
    { action: "finish", summary: "Reverted the multiplication; tests pass." }
  ]);
  try {
    const result = await runAgent({ files: p.files, history: p.history, runner: p.runner, projectId: "p", next: s.next, event: () => {} }, "Refactor add");
    assert.match(s.seen[3], /Not finished: npm test still fail/);
    assert.match(s.seen[5], /npm test: PASSED/);
    assert.equal(result.summary, "Reverted the multiplication; tests pass.");
    assert.equal(result.metrics.retries, 1);
    assert.equal(result.metrics.success, true);
    assert.equal(result.metrics.filesChanged, 0, "the net change is nothing");
  } finally { p.runner.stopAll(); await p.cleanup(); }
});

test("agent: revert undoes everything; create and delete; disallowed commands are refused, not run", async () => {
  const p = await project(mathProject);
  const s = scripted([
    { action: "create_file", path: "src/extra.js", content: "export const x = 1;\n" },
    { action: "delete_file", path: "src/index.js" },
    { action: "run_command", command: "npm test && rm -rf /" },
    { action: "revert" },
    { action: "git_status" },
    { action: "finish", summary: "Nothing to do." }
  ]);
  try {
    const result = await runAgent({ files: p.files, history: p.history, runner: p.runner, projectId: "p", next: s.next, event: () => {} }, "Experiment");
    assert.match(s.seen[3], /ERROR: Run one command at a time/);
    assert.match(s.seen[5], /Changes since the task started: none/);
    assert.ok(existsSync(join(p.root, "src/index.js")) && !existsSync(join(p.root, "src/extra.js")));
    assert.equal(result.metrics.filesChanged, 0);
  } finally { p.runner.stopAll(); await p.cleanup(); }
});

test("agent: edits to a web page are opened in a browser before finishing; console errors send it back", { skip: !findBrowser() && "no local Chrome or Edge" }, async () => {
  const p = await project({
    "index.html": "<!doctype html><html><body><h1 id=\"t\">Hi</h1><script src=\"app.js\"></script></body></html>\n",
    "app.js": "document.getElementById('t').textContent = 'Hello';\n"
  });
  const s = scripted([
    { action: "read_file", path: "app.js" },
    { action: "apply_patch", path: "app.js", edits: [{ find: "'Hello';", replace: "'Hello' }};" }], note: "Broken edit" },
    { action: "finish", summary: "Done" },
    { action: "apply_patch", path: "app.js", edits: [{ find: "'Hello' }};", replace: "'Hello there';" }] },
    { action: "view_page", path: "index.html", click: "" },
    { action: "finish", summary: "Heading says Hello there." }
  ]);
  try {
    const result = await runAgent({ files: p.files, history: p.history, runner: p.runner, projectId: "p", next: s.next, event: () => {} }, "Make the heading say Hello there");
    assert.match(s.seen[3], /Not finished: the page shows errors after your edits \(loading it and clicking each button once\):\n.*(Unexpected token|SyntaxError)/);
    assert.match(s.seen[5], /Hello there/);
    assert.match(s.seen[5], /No console errors/);
    assert.equal(result.summary, "Heading says Hello there.");
  } finally { p.runner.stopAll(); await p.cleanup(); }
});

test("agent: looking at the same thing again before anything changed is skipped; long idling gets a push to act", async () => {
  const p = await project(mathProject);
  const ab: AgentAction[] = [{ action: "read_range", path: "src/math.js", start_line: 1, end_line: 3 }, { action: "read_range", path: "src/index.js", start_line: 1, end_line: 2 }];
  const s = scripted([...ab, ...ab, ...ab, ...ab, { action: "finish", summary: "Nothing to change." }, { action: "finish", summary: "Nothing to change." }]);
  try {
    await runAgent({ files: p.files, history: p.history, runner: p.runner, projectId: "p", next: s.next, event: () => {} }, "Explain what add does");
    assert.doesNotMatch(s.seen[2], /already did exactly this/);
    assert.match(s.seen[3], /RESULT of read_range:\nERROR: you already did exactly this/);
    assert.match(s.seen[8], /only looked and planned for 8 steps/);
  } finally { p.runner.stopAll(); await p.cleanup(); }
});

test("agent: write_file rewrites a small file it has read; a failed patch points to it", async () => {
  const p = await project(mathProject);
  const fixed = "export function add(a, b) {\n  return a + b;\n}\n\nexport const double = x => add(x, x);\n";
  const s = scripted([
    { action: "write_file", path: "src/math.js", content: fixed },
    { action: "read_file", path: "src/math.js" },
    { action: "apply_patch", path: "src/math.js", edits: [{ find: "return a minus b;", replace: "return a + b;" }] },
    { action: "write_file", path: "src/math.js", content: fixed },
    { action: "finish", summary: "add() adds." }
  ]);
  try {
    const result = await runAgent({ files: p.files, history: p.history, runner: p.runner, projectId: "p", next: s.next, event: () => {} }, "add() returns the wrong result; fix it");
    assert.match(s.seen[1], /ERROR: Read src\/math\.js before rewriting it/);
    assert.match(s.seen[3], /Or use write_file with the file's complete new content/);
    assert.match(s.seen[4], /Wrote src\/math\.js \(−1 \+1 lines\)/);
    assert.equal(await readFile(join(p.root, "src/math.js"), "utf8"), fixed);
    assert.equal(result.metrics.success, true);
    assert.equal(result.metrics.linesAdded, 1);
  } finally { p.runner.stopAll(); await p.cleanup(); }
});

test("agent: a reported bug the tests miss cannot be closed without a test that reproduces it", async () => {
  const p = await project({
    ...mathProject,
    "src/math.js": "export function add(a, b) {\n  return a + b;\n}\n\nexport const double = x => x + x + 1;\n"
  });
  const s = scripted([
    { action: "read_file", path: "src/math.js" },
    { action: "apply_patch", path: "src/math.js", edits: [{ find: "x + x + 1", replace: "add(x, x)" }] },
    { action: "finish", summary: "Fixed double." },
    { action: "read_file", path: "src/math.test.js" },
    { action: "apply_patch", path: "src/math.test.js", edits: [{ find: "import { add } from './math.js';", replace: "import { add, double } from './math.js';\ntest('double', () => assert.equal(double(4), 8));" }] },
    { action: "finish", summary: "Fixed double and added a test for it." }
  ]);
  try {
    const result = await runAgent({ files: p.files, history: p.history, runner: p.runner, projectId: "p", next: s.next, event: () => {} }, "double(4) returns 9 instead of 8, please fix this bug");
    assert.match(s.seen[0], /NOTE: the tests pass but the task reports a bug/);
    assert.match(s.seen[3], /Not finished: the tests passed before your change too/);
    assert.equal(result.summary, "Fixed double and added a test for it.");
    assert.equal(result.metrics.success, true);
    assert.ok(isTestFile("src/math.test.js") && isTestFile("tests/test_api.py") && isTestFile("pkg/server_test.go") && !isTestFile("src/testing-utils.js"));
  } finally { p.runner.stopAll(); await p.cleanup(); }
});

test("agent: a bug fix finished without a reproducing test says it is not verified", async () => {
  const p = await project({ ...mathProject, "src/math.js": "export function add(a, b) {\n  return a + b;\n}\n\nexport const double = x => x + x + 1;\n" });
  const s = scripted([
    { action: "read_file", path: "src/math.js" },
    { action: "apply_patch", path: "src/math.js", edits: [{ find: "x + x + 1", replace: "add(x, x)" }] },
    { action: "finish", summary: "Fixed double." }, { action: "finish", summary: "Fixed double." }, { action: "finish", summary: "Fixed double." }
  ]);
  try {
    const result = await runAgent({ files: p.files, history: p.history, runner: p.runner, projectId: "p", next: s.next, event: () => {} }, "double(4) returns 9 instead of 8, please fix this bug");
    assert.equal(result.summary, "Fixed double. (Not verified: no test reproduces the reported bug.)");
  } finally { p.runner.stopAll(); await p.cleanup(); }
});

test("agent tools: references, dependencies, rename with importers, aliases", async () => {
  const p = await project(mathProject);
  const s = scripted([
    { action: "find_references", name: "add" },
    { action: "inspect_dependencies", path: "src/math.js" },
    { action: "inspect_dependencies", path: "" },
    { action: "rename_file", path: "src/index.js", new_path: "src/main.js" },
    { action: "run_typecheck" },
    { action: "finish", summary: "Looked around." }, { action: "finish", summary: "Looked around." }
  ]);
  try {
    await runAgent({ files: p.files, history: p.history, runner: p.runner, projectId: "p", next: s.next, event: () => {} }, "Explain how add is used");
    assert.match(s.seen[1], /Defined: src\/math\.js:1/);
    assert.match(s.seen[1], /src\/index\.js:2: console\.log\(add\(2, 3\)\);/);
    assert.match(s.seen[1], /src\/math\.js:5: export const double = x => add\(x, x\);/);
    assert.doesNotMatch(s.seen[1], /src\/math\.js:1: export function add/, "the definition is not listed as a use");
    assert.match(s.seen[2], /src\/math\.js imports:\n- nothing\nImported by: src\/index\.js, src\/math\.test\.js|Imported by: src\/math\.test\.js, src\/index\.js/);
    assert.match(s.seen[3], /package\.json scripts: test = node --test/);
    assert.match(s.seen[4], /Renamed src\/index\.js to src\/main\.js\./);
    assert.ok(existsSync(join(p.root, "src/main.js")) && !existsSync(join(p.root, "src/index.js")));
    assert.match(s.seen[5], /This project has no typecheck command/);
  } finally { p.runner.stopAll(); await p.cleanup(); }
  // Names other agents use are accepted.
  assert.deepEqual(validateAction({ action: "inspect_diff", path: "a.js" }), { action: "git_diff", path: "a.js", note: undefined });
  assert.deepEqual(validateAction({ action: "revert_checkpoint" }), { action: "revert", note: undefined });
  assert.equal((validateAction({ action: "inspect_browser", path: "index.html", viewport: "both" }) as { viewport: string }).viewport, "both");
});

test("agent: a responsive task is checked at phone width before it can finish", { skip: !findBrowser() && "no local Chrome or Edge" }, async () => {
  const p = await project({
    "index.html": "<!doctype html><html><head><link rel=\"stylesheet\" href=\"style.css\"></head><body><div class=\"row\"><div class=\"card\">One</div><div class=\"card\">Two</div></div></body></html>\n",
    "style.css": ".row { display: flex; }\n.card { width: 600px; flex: none; }\n"
  });
  const s = scripted([
    { action: "read_file", path: "style.css" },
    { action: "apply_patch", path: "style.css", edits: [{ find: ".row { display: flex; }", replace: ".row { display: flex; flex-wrap: wrap; }" }] },
    { action: "finish", summary: "Made it responsive." },
    { action: "read_file", path: "index.html" },
    { action: "apply_patch", path: "index.html", edits: [{ find: "<head>", replace: "<head><meta name=\"viewport\" content=\"width=device-width, initial-scale=1\">" }] },
    { action: "apply_patch", path: "style.css", edits: [{ find: ".card { width: 600px; flex: none; }", replace: ".card { width: 600px; max-width: 100%; flex: none; }" }] },
    { action: "view_page", path: "index.html", click: "", viewport: "both" },
    { action: "finish", summary: "Cards wrap and fit on phones." }
  ]);
  try {
    const result = await runAgent({ files: p.files, history: p.history, runner: p.runner, projectId: "p", next: s.next, event: () => {} }, "Make this page responsive so it works on phones");
    assert.match(s.seen[3], /Not finished: at phone width the layout is not right yet\.\nLayout \(mobile 390×844\): HORIZONTAL OVERFLOW/);
    assert.match(s.seen[3], /No <meta name="viewport"/);
    assert.match(s.seen[7], /--- desktop ---[\s\S]*fits the viewport width[\s\S]*--- mobile ---[\s\S]*Layout \(mobile 390×844\): fits the viewport width/);
    assert.equal(result.summary, "Cards wrap and fit on phones.");
  } finally { p.runner.stopAll(); await p.cleanup(); }
});

test("agent: an error that only happens when a button is clicked is caught before finishing", { skip: !findBrowser() && "no local Chrome or Edge" }, async () => {
  const p = await project({
    "index.html": "<!doctype html><html><body><span id=\"count\">0</span><button id=\"add\">Add</button><script src=\"app.js\"></script></body></html>\n",
    "app.js": "document.getElementById('add').addEventListener('click', () => {\n  const badge = document.getElementById('cnt');\n  badge.textContent = Number(badge.textContent) + 1;\n});\n"
  });
  const s = scripted([
    { action: "read_file", path: "app.js" },
    { action: "apply_patch", path: "app.js", edits: [{ find: "Number(badge.textContent) + 1", replace: "Number(badge.textContent) + 2" }] },
    { action: "finish", summary: "Adds two." },
    { action: "apply_patch", path: "app.js", edits: [{ find: "getElementById('cnt')", replace: "getElementById('count')" }] },
    { action: "finish", summary: "Adds two, using the right element." }
  ]);
  try {
    const result = await runAgent({ files: p.files, history: p.history, runner: p.runner, projectId: "p", next: s.next, event: () => {} }, "The add button should add two to the count");
    assert.match(s.seen[3], /clicking each button once\):\n.*Cannot (read|set) properties of null/);
    assert.equal(result.summary, "Adds two, using the right element.");
  } finally { p.runner.stopAll(); await p.cleanup(); }
});

test("agent: the same failure three times in a row goes back to the last state where every check passed", async () => {
  const p = await project(mathProject);
  const s = scripted([
    { action: "read_file", path: "src/math.js" },
    { action: "apply_patch", path: "src/math.js", edits: [{ find: "return a - b;", replace: "return a + b;" }] },
    { action: "run_tests" },
    { action: "apply_patch", path: "src/math.js", edits: [{ find: "return a + b;", replace: "return a + b; }}" }] },
    { action: "run_tests" },
    { action: "apply_patch", path: "src/math.js", edits: [{ find: "export const double", replace: "// attempt\nexport const double" }] },
    { action: "run_tests" },
    { action: "apply_patch", path: "src/math.js", edits: [{ find: "// attempt", replace: "// attempt 2" }] },
    { action: "run_tests" },
    { action: "finish", summary: "add() fixed." }
  ]);
  try {
    const result = await runAgent({ files: p.files, history: p.history, runner: p.runner, projectId: "p", next: s.next, event: () => {} }, "Refactor add");
    assert.doesNotMatch(s.seen[7], /AUTO-RECOVERY/, "two identical failures are not yet a loop");
    assert.match(s.seen[9], /AUTO-RECOVERY: this exact failure happened three times in a row/);
    assert.equal(await readFile(join(p.root, "src/math.js"), "utf8"), mathProject["src/math.js"].replace("a - b", "a + b"), "back to the passing fix, later edits undone");
    assert.equal(result.metrics.success, true);
    assert.equal(result.metrics.filesChanged, 1);
  } finally { p.runner.stopAll(); await p.cleanup(); }
});

test("patches: line-number prefixes copied from read_file are ignored", () => {
  const src = ".plans { display: flex; }\n.plan { width: 320px; }\n";
  const out = applyEdits(src, [{ find: "   1| .plans { display: flex; }", replace: "   1| .plans { display: flex; flex-wrap: wrap; }" }]);
  assert.equal(out.content, ".plans { display: flex; flex-wrap: wrap; }\n.plan { width: 320px; }\n");
  // A real line that happens to look numbered is left alone when the find text is not all numbered.
  assert.equal(applyEdits("a\n1| b\n", [{ find: "a\n1| b", replace: "c" }]).content, "c\n");
});

test("agent: a summary claiming a change when nothing was edited is corrected", async () => {
  const p = await project(mathProject);
  const s = scripted([{ action: "finish", summary: "Fixed add()." }, { action: "finish", summary: "add() is now fixed." }]);
  try {
    const result = await runAgent({ files: p.files, history: p.history, runner: p.runner, projectId: "p", next: s.next, event: () => {} }, "Fix add so it adds");
    assert.match(result.summary, /^No files were changed, so the task was not done\./);
    assert.equal(result.metrics.success, false);
  } finally { p.runner.stopAll(); await p.cleanup(); }
});
