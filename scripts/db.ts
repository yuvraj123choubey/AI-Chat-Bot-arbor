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
/** Arbor stores text from anywhere on the web, so its database is always UTF-8 whatever the OS locale is. */
const createUtf8 = (name: string) => `CREATE DATABASE "${name}" ENCODING 'UTF8' LC_COLLATE 'C' LC_CTYPE 'C' TEMPLATE template0`;

async function ensureDatabase(config: LocalDbConfig) {
  const admin = new pg.Client({ connectionString: localDatabaseUrl(config, "postgres") });
  await admin.connect();
  try {
    const found = await admin.query("SELECT pg_encoding_to_char(encoding) AS encoding FROM pg_database WHERE datname = $1", [config.database]);
    if (!found.rowCount) await admin.query(createUtf8(config.database));
    else if (found.rows[0].encoding !== "UTF8") await convertToUtf8(admin, config, found.rows[0].encoding);
  } finally { await admin.end(); }
}

/**
 * Earlier local databases were created in the OS encoding (WIN1252 on Windows), which cannot hold arbitrary
 * Unicode. The data is copied into a new UTF-8 database inside the same server; the old database is kept,
 * renamed, as a backup.
 */
async function convertToUtf8(admin: pg.Client, config: LocalDbConfig, encoding: string) {
  const target = `${config.database}_utf8_tmp`;
  const backup = `${config.database}_backup_${encoding.toLowerCase()}_${new Date().toISOString().slice(0, 10).replace(/-/g, "")}`;
  console.log(`Converting the local database from ${encoding} to UTF-8 (the original is kept as "${backup}")…`);
  await admin.query(`DROP DATABASE IF EXISTS "${target}"`);
  await admin.query(createUtf8(target));
  migrate(localDatabaseUrl(config, target));
  const source = new pg.Client({ connectionString: localDatabaseUrl(config) });
  const dest = new pg.Client({ connectionString: localDatabaseUrl(config, target) });
  await source.connect();
  await dest.connect();
  try {
    const tables = (await source.query("SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename <> '_prisma_migrations'")).rows.map(r => r.tablename as string);
    await dest.query("BEGIN");
    // Rows are copied in any order, so foreign-key triggers are suspended for this session only.
    await dest.query("SET session_replication_role = replica");
    for (const table of tables) {
      const rows = (await source.query(`SELECT row_to_json(t) AS r FROM "${table}" t`)).rows.map(r => r.r);
      for (let i = 0; i < rows.length; i += 500) {
        await dest.query(`INSERT INTO "${table}" SELECT * FROM json_populate_recordset(NULL::"${table}", $1::json)`, [JSON.stringify(rows.slice(i, i + 500))]);
      }
      if (rows.length) console.log(`  copied ${rows.length} row(s) from ${table}`);
    }
    await dest.query("COMMIT");
  } catch (error) {
    await dest.query("ROLLBACK").catch(() => {});
    throw error;
  } finally { await source.end(); await dest.end(); }
  await admin.query(`ALTER DATABASE "${config.database}" RENAME TO "${backup}"`);
  await admin.query(`ALTER DATABASE "${target}" RENAME TO "${config.database}"`);
  console.log("Local database converted to UTF-8.");
}

async function startLocal(): Promise<string> {
  const config = localDbConfig(true)!;
  const adminUrl = localDatabaseUrl(config, "postgres");
  if (!existsSync(join(pgdata, "PG_VERSION"))) {
    console.log("Creating the local database (first run)…");
    await new EmbeddedPostgres({ databaseDir: pgdata, user: config.user, password: config.password, port: config.port, persistent: true, initdbFlags: ["--encoding=UTF8", "--locale=C"], onLog: () => {}, onError: () => {} }).initialise();
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
  // An empty DATABASE_URL= line in .env means "not set".
  const external = process.env.DATABASE_URL || undefined;
  const url = external ?? await startLocal();
  if (external) console.log(`Using DATABASE_URL ${describeUrl(external)}`);
  migrate(url);
  console.log("Database ready.");
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
}
