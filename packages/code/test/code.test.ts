import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CommandRunner, ProjectFiles, ProjectHistory, checkCommand, cleanRelative, commandEnv, detectProject, insideProject} from "../src/index.ts";

async function project(files: Record<string, string> = {}) {
  const base = await mkdtemp(join(tmpdir(), "arbor-code-"));
  const root = join(base, "p");
  await mkdir(root);
  for (const [path, content] of Object.entries(files)) { await mkdir(join(root, path, ".."), { recursive: true }); await writeFile(join(root, path), content); }
  return { base, root, files: new ProjectFiles(root), history: new ProjectHistory(root, join(base, "history.git")), cleanup: () => rm(base, { recursive: true, force: true, maxRetries: 5 }) };
}

test("paths: anything that could leave the project is refused", async () => {
  const p = await project({ "a.txt": "x" });
  try {
    for (const bad of ["../x", "a/../../x", "C:\\Windows\\x", "/etc/passwd", ".git/config", "a\0b", "con:x"]) assert.throws(() => insideProject(p.root, bad), Error, bad);
    assert.equal(cleanRelative("./src//app.ts/"), "src/app.ts");
    assert.equal(cleanRelative("src\\app.ts"), "src/app.ts");
    try { symlinkSync(p.base, join(p.root, "escape"), "junction"); assert.throws(() => insideProject(p.root, "escape/history.git"), /outside/); } catch (e) { if ((e as NodeJS.ErrnoException).code !== "EPERM") throw e; }
  } finally { await p.cleanup(); }
});

test("commands: only allowlisted single commands; secrets never reach them", () => {
  assert.deepEqual(checkCommand("npm run test -- --watch=false"), ["npm", "run", "test", "--", "--watch=false"]);
  assert.deepEqual(checkCommand(`node "my script.js"`), ["node", "my script.js"]);
  for (const bad of ["rm -rf /", "npm test && curl x", "node a.js | tee out", "node a.js > out", "powershell -c x", "git push", "git commit -m x", "node $(whoami)", "node %PATH%", "cmd /c dir", "node ../outside.js", "node C:\\x.js"]) assert.throws(() => checkCommand(bad), Error, bad);
  process.env.ARBOR_TEST_SECRET_KEY = "s3cret";
  process.env.DATABASE_URL ??= "postgres://x";
  const env = commandEnv();
  assert.equal(env.ARBOR_TEST_SECRET_KEY, undefined);
  assert.equal(env.DATABASE_URL, undefined);
  assert.ok(env.PATH || env.Path);
  assert.equal(env.CI, "true");
  delete process.env.ARBOR_TEST_SECRET_KEY;
});

test("runner: runs, streams, caps output, times out and cancels whole process trees", async () => {
  const p = await project({ "ok.js": "console.log('hello'); console.error('warn'); process.exit(0);", "fail.js": "process.exit(3)", "slow.js": "setInterval(() => console.log('tick'), 100);", "loud.js": "const s = 'x'.repeat(1024); for (let i = 0; i < 2000; i++) process.stdout.write(s);" });
  const runner = new CommandRunner(() => join(p.base, "logs"));
  try {
    const ok = await runner.wait(runner.start({ projectId: "p", cwd: p.root, command: "node ok.js" }).id);
    assert.equal(ok.status, "exited");
    assert.equal(ok.exitCode, 0);
    assert.match(runner.output(ok.id), /hello[\s\S]*warn/);
    const fail = await runner.wait(runner.start({ projectId: "p", cwd: p.root, command: "node fail.js" }).id);
    assert.equal(fail.status, "failed");
    assert.equal(fail.exitCode, 3);
    const timed = await runner.wait(runner.start({ projectId: "p", cwd: p.root, command: "node slow.js", timeoutMs: 800 }).id);
    assert.equal(timed.status, "timeout");
    const slow = runner.start({ projectId: "p", cwd: p.root, command: "node slow.js" });
    await new Promise(r => setTimeout(r, 400));
    assert.equal(runner.cancel(slow.id), true);
    assert.equal((await runner.wait(slow.id)).status, "cancelled");
    const loud = await runner.wait(runner.start({ projectId: "p", cwd: p.root, command: "node loud.js" }).id);
    assert.equal(loud.truncated, true);
    assert.ok(loud.outputBytes <= 1024 * 1024);
    assert.throws(() => runner.start({ projectId: "p", cwd: p.root, command: "node ok.js && node fail.js" }), /one command/);
    await new Promise(r => setTimeout(r, 300));
    assert.ok(existsSync(join(p.base, "logs")), "run logs are written");
  } finally { runner.stopAll(); await p.cleanup(); }
});

test("files and history: edit, checkpoint, diff, restore — the project's own .git is untouched", async () => {
  const p = await project({ "src/app.js": "export const a = 1;\n", "README.md": "# Demo\n", ".git/HEAD": "ref: refs/heads/main\n", "node_modules/x/index.js": "x" });
  try {
    const first = await p.history.checkpoint("Initial", "you");
    assert.ok(first);
    assert.deepEqual(first!.files.map(f => f.path).sort(), ["README.md", "src/app.js"], "node_modules and .git are not versioned");
    assert.equal(await p.history.checkpoint("Nothing changed"), undefined);
    await p.files.write("src/app.js", "export const a = 2;\nexport const b = 3;\n");
    await p.files.write("src/new.js", "new\n");
    await p.files.remove("README.md");
    const pending = await p.history.pending();
    assert.deepEqual(pending.files.map(f => `${f.status}:${f.path}`).sort(), ["added:src/new.js", "deleted:README.md", "modified:src/app.js"]);
    const second = await p.history.checkpoint("Agent change", "agent");
    assert.equal(second!.author, "agent");
    assert.match((await p.history.changesIn(second!.commit)).patch, /\+export const b = 3;/);
    await p.history.restore(first!.commit, "Initial");
    assert.equal(await readFile(join(p.root, "src/app.js"), "utf8"), "export const a = 1;\n");
    assert.ok(existsSync(join(p.root, "README.md")));
    assert.ok(!existsSync(join(p.root, "src/new.js")));
    assert.equal(await readFile(join(p.root, ".git/HEAD"), "utf8"), "ref: refs/heads/main\n");
    assert.ok(existsSync(join(p.root, "node_modules/x/index.js")));
    const log = await p.history.log();
    assert.deepEqual(log.map(c => c.message), ["Restored: Initial", "Agent change", "Initial"]);
    await p.files.rename("src/app.js", "src/main.js");
    assert.deepEqual((await p.files.search("const a")).map(h => `${h.path}:${h.line}`), ["src/main.js:1"]);
    await assert.rejects(p.files.rename("src/main.js", "src/main.js"), /exists/);
    await p.files.mkdir("lib/util");
    assert.ok((await p.files.tree()).some(e => e.path === "lib" && e.children?.[0]?.path === "lib/util"));
  } finally { await p.cleanup(); }
});

test("project detection picks the right run, test and build commands", async () => {
  const a = await project({ "index.html": "<h1>x</h1>" });
  const b = await project({ "package.json": JSON.stringify({ scripts: { dev: "vite", build: "vite build", test: "vitest run" }, devDependencies: { vite: "6" }, dependencies: { react: "19" } }) });
  const c = await project({ "main.py": "print(1)", "tests/test_x.py": "" });
  try {
    assert.equal((await detectProject(a.root)).kind, "static");
    const vite = await detectProject(b.root);
    assert.deepEqual([vite.kind, vite.label, vite.needsInstall, vite.testCommand, vite.buildCommand], ["vite", "Vite + React", true, "npm test", "npm run build"]);
    assert.equal(vite.devCommand!(5401), "npx vite --port 5401 --host 127.0.0.1 --strictPort");
    assert.deepEqual([(await detectProject(c.root)).kind, (await detectProject(c.root)).testCommand], ["python", "python -m pytest"]);
  } finally { await a.cleanup(); await b.cleanup(); await c.cleanup(); }
});

