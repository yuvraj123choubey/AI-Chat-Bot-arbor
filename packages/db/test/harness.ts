import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:net";
import { spawnSync } from "node:child_process";
import EmbeddedPostgres from "embedded-postgres";
import { createDb, type Db } from "../src/client.ts";

export interface TestDb { url: string; db: Db; dataRoot: string; stop(): Promise<void> }

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer().listen(0, "127.0.0.1", () => {
      const { port } = server.address() as { port: number };
      server.close(() => resolve(port));
    }).on("error", reject);
  });
}

/** A throwaway PostgreSQL with the real migrations applied, so tests exercise the production schema. */
export async function startTestDb(timeoutMs = 120_000): Promise<TestDb> {
  // Fail with a clear message rather than hanging the suite if the machine is too busy to start PostgreSQL.
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`Test database did not start within ${timeoutMs / 1000}s`)), timeoutMs); });
  try { return await Promise.race([launch(), timeout]); } finally { clearTimeout(timer); }
}
async function launch(): Promise<TestDb> {
  const root = await mkdtemp(join(tmpdir(), "arbor-db-"));
  const port = await freePort();
  const pg = new EmbeddedPostgres({ databaseDir: join(root, "pgdata"), user: "arbor_test", password: "arbor_test", port, persistent: false, initdbFlags: ["--encoding=UTF8", "--locale=C"], onLog: () => {}, onError: () => {} });
  await pg.initialise();
  await pg.start();
  await pg.createDatabase("arbor_test");
  const url = `postgresql://arbor_test:arbor_test@127.0.0.1:${port}/arbor_test`;
  const migrate = spawnSync("npx prisma migrate deploy", { shell: true, encoding: "utf8", env: { ...process.env, DATABASE_URL: url, PRISMA_HIDE_UPDATE_MESSAGE: "1" } });
  if (migrate.status !== 0) throw new Error(`Migrations failed: ${migrate.stderr || migrate.stdout}`);
  const db = createDb(url);
  return {
    url, db, dataRoot: join(root, "data"),
    async stop() {
      await db.$disconnect();
      await pg.stop();
      await rm(root, { recursive: true, force: true, maxRetries: 5 });
    }
  };
}
