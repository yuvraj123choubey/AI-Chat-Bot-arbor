import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../generated/client.ts";
import { databaseUrl } from "./local.ts";

export type Db = PrismaClient;
export * from "../generated/client.ts";

/** One client per process: each PrismaClient owns a connection pool. */
export function createDb(url = databaseUrl()): Db {
  if (!url) throw new Error("No database configured. Run `npm run dev` (starts the local database) or set DATABASE_URL.");
  return new PrismaClient({ adapter: new PrismaPg({ connectionString: url }) });
}

/** Waits for the database to accept queries, e.g. while the dev database process is still starting. */
export async function waitForDb(db: Db, timeoutMs = 60_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (let attempt = 0; ; attempt++) {
    try { await db.$queryRaw`SELECT 1`; return; }
    catch (error) {
      if (Date.now() > deadline) throw error;
      await new Promise(r => setTimeout(r, Math.min(500 * (attempt + 1), 2000)));
    }
  }
}
