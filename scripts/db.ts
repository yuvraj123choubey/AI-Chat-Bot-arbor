/**
 * Local database lifecycle. `start` keeps an embedded PostgreSQL running for `npm run dev` and applies
 * migrations; `migrate` applies migrations once; `stop` shuts the embedded server down.
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

async function reachable(url: string): Promise<boolean> {
  const client = new pg.Client({ connectionString: url, connectionTimeoutMillis: 1500 });
  try { await client.connect(); await client.end(); return true; } catch { return false; }
}
function migrate(url: string) {
  const result = spawnSync("npx prisma migrate deploy", { stdio: "inherit", shell: true, env: { ...process.env, DATABASE_URL: url, PRISMA_HIDE_UPDATE_MESSAGE: "1" } });
  if (result.status !== 0) throw new Error("prisma migrate deploy failed");
}
function server(config: LocalDbConfig) {
  return new EmbeddedPostgres({ databaseDir: pgdata, user: config.user, password: config.password, port: config.port, persistent: true, onLog: () => {}, onError: () => {} });
}
async function ensureDatabase(config: LocalDbConfig) {
  const admin = new pg.Client({ connectionString: localDatabaseUrl(config, "postgres") });
  await admin.connect();
  const exists = await admin.query("SELECT 1 FROM pg_database WHERE datname = $1", [config.database]);
  if (!exists.rowCount) await admin.query(`CREATE DATABASE "${config.database}"`);
  await admin.end();
}

async function startLocal(): Promise<{ url: string; stop?: () => Promise<void> }> {
  const config = localDbConfig(true)!;
  const url = localDatabaseUrl(config);
  if (await reachable(localDatabaseUrl(config, "postgres"))) {
    console.log(`Local database already running on port ${config.port}.`);
    await ensureDatabase(config);
    return { url };
  }
  const db = server(config);
  if (!existsSync(join(pgdata, "PG_VERSION"))) {
    console.log("Creating the local database (first run)…");
    await db.initialise();
  }
  await db.start();
  await ensureDatabase(config);
  console.log(`Local database running on port ${config.port}.`);
  return { url, stop: () => db.stop() };
}

if (command === "stop") {
  const config = localDbConfig();
  if (!config || !existsSync(join(pgdata, "postmaster.pid"))) { console.log("Local database is not running."); process.exit(0); }
  // The server may have been started by an earlier process, so stop it with pg_ctl rather than an instance handle.
  const require = createRequire(import.meta.url);
  const binDir = join(require.resolve(`@embedded-postgres/${process.platform === "win32" ? "windows" : process.platform}-${process.arch}/package.json`), "..", "native", "bin");
  const result = spawnSync(join(binDir, process.platform === "win32" ? "pg_ctl.exe" : "pg_ctl"), ["-D", pgdata, "stop", "-m", "fast"], { stdio: "inherit" });
  process.exit(result.status ?? 1);
}

const external = process.env.DATABASE_URL;
const { url, stop } = external ? { url: external, stop: undefined } : await startLocal();
if (external) console.log(`Using DATABASE_URL ${describeUrl(external)}`);
migrate(url);
console.log("Database ready.");
if (command === "migrate" || !stop) process.exit(0);

const shutdown = async () => { await stop().catch(() => {}); process.exit(0); };
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
process.on("SIGHUP", shutdown);
// Keep the process alive while the dev servers run.
setInterval(() => {}, 1 << 30);
