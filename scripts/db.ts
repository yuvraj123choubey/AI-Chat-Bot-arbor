/**
 * Local database lifecycle for development.
 *   start   — ensure the embedded PostgreSQL server is running and migrations are applied, then exit
 *   migrate — same as start (kept for `npm start` / CI symmetry)
 *   stop    — stop the local server
 * The server runs detached under pg_ctl with its log in data/postgres/server.log, so it is not tied to any
 * Node process: dev-server restarts reuse it, and a crashed dev process cannot leave it hung on a closed pipe.
 * With DATABASE_URL set, the embedded server is never used and only migrations are applied.
 */
import "../apps/api/src/setup-env.ts";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import EmbeddedPostgres from "embedded-postgres";
import pg from "pg";
import { describeUrl, localDatabaseUrl, localDbConfig, localDbRoot, type LocalDbConfig } from "../packages/db/src/local.ts";

const command = process.argv[2] || "start";
const pgdata = join(localDbRoot, "pgdata");

function binary(name: string): string {
  const require = createRequire(import.meta.url);
  const platform = process.platform === "win32" ? "windows" : process.platform;
  // The package exports only dist/index.js; its binaries sit beside it in native/bin.
  const dir = join(require.resolve(`@embedded-postgres/${platform}-${process.arch}`), "..", "..", "native", "bin");
  return join(dir, process.platform === "win32" ? `${name}.exe` : name);
}
function pgCtl(args: string[], quiet = false) {
  return spawnSync(binary("pg_ctl"), ["-D", pgdata, ...args], { stdio: quiet ? "pipe" : "inherit", encoding: "utf8" });
}
async function responsive(url: string): Promise<boolean> {
  const client = new pg.Client({ connectionString: url, connectionTimeoutMillis: 5000 });
  try { await client.connect(); await client.query("SELECT 1"); await client.end(); return true; } catch { await client.end().catch(() => {}); return false; }
}
/**
 * On Windows, backends of a postmaster that was killed keep its shared memory, and a new server refuses to start.
 * Only processes running this project's own PostgreSQL binary are stopped; any other PostgreSQL is untouched.
 */
function killOrphans() {
  if (process.platform !== "win32") return;
  const exe = binary("postgres").replace(/'/g, "''");
  // Windows hides the path of a backend whose postmaster has died, so such orphans are matched by their dead parent.
  spawnSync("powershell", ["-NoProfile", "-Command", `Get-CimInstance Win32_Process -Filter "Name='postgres.exe'" | Where-Object { $_.ExecutablePath -eq '${exe}' -or (-not $_.ExecutablePath -and -not (Get-Process -Id $_.ParentProcessId -ErrorAction SilentlyContinue)) } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }`], { stdio: "ignore" });
}
function migrate(url: string) {
  const result = spawnSync("npx prisma migrate deploy", { stdio: "inherit", shell: true, env: { ...process.env, DATABASE_URL: url, PRISMA_HIDE_UPDATE_MESSAGE: "1" } });
  if (result.status !== 0) throw new Error("prisma migrate deploy failed");
}
async function ensureDatabase(config: LocalDbConfig) {
  const admin = new pg.Client({ connectionString: localDatabaseUrl(config, "postgres") });
  await admin.connect();
  const exists = await admin.query("SELECT 1 FROM pg_database WHERE datname = $1", [config.database]);
  if (!exists.rowCount) await admin.query(`CREATE DATABASE "${config.database}"`);
  await admin.end();
}

async function startLocal(): Promise<string> {
  const config = localDbConfig(true)!;
  const adminUrl = localDatabaseUrl(config, "postgres");
  if (!existsSync(join(pgdata, "PG_VERSION"))) {
    console.log("Creating the local database (first run)…");
    await new EmbeddedPostgres({ databaseDir: pgdata, user: config.user, password: config.password, port: config.port, persistent: true, onLog: () => {}, onError: () => {} }).initialise();
  }
  if (await responsive(adminUrl)) {
    console.log(`Local database already running on port ${config.port}.`);
  } else {
    // A server that is "running" but not answering (e.g. orphaned by a killed process) is restarted.
    if (pgCtl(["status"], true).status === 0) {
      console.log("Local database is not responding; restarting it.");
      pgCtl(["stop", "-m", "immediate"], true);
    }
    killOrphans();
    const started = pgCtl(["start", "-w", "-t", "60", "-l", join(localDbRoot, "server.log"), "-o", `-p ${config.port} -h 127.0.0.1`], true);
    if (started.status !== 0 || !(await responsive(adminUrl))) throw new Error(`Could not start the local database. See ${join(localDbRoot, "server.log")}.\n${started.stderr || started.stdout}`);
    console.log(`Local database started on port ${config.port}.`);
  }
  await ensureDatabase(config);
  return localDatabaseUrl(config);
}

if (command === "stop") {
  if (!existsSync(join(pgdata, "PG_VERSION")) || pgCtl(["status"], true).status !== 0) { console.log("Local database is not running."); process.exit(0); }
  process.exit(pgCtl(["stop", "-m", "fast"]).status ?? 1);
}
try {
  const external = process.env.DATABASE_URL;
  const url = external ?? await startLocal();
  if (external) console.log(`Using DATABASE_URL ${describeUrl(external)}`);
  migrate(url);
  console.log("Database ready.");
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
}
