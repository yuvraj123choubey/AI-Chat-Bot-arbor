import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { join, resolve } from "node:path";

/**
 * Local development database. When DATABASE_URL is not set, Arbor runs an embedded PostgreSQL whose
 * data and generated credentials live in the git-ignored data/ folder. Production sets DATABASE_URL.
 */
export const dataRoot = resolve(process.env.ARBOR_DATA_DIR || "data");
export const localDbRoot = join(dataRoot, "postgres");
export interface LocalDbConfig { user: string; password: string; port: number; database: string }

export function localDbConfig(create = false): LocalDbConfig | undefined {
  const file = join(localDbRoot, "local.json");
  if (existsSync(file)) return JSON.parse(readFileSync(file, "utf8"));
  if (!create) return undefined;
  mkdirSync(localDbRoot, { recursive: true });
  const config: LocalDbConfig = { user: "arbor", password: randomBytes(18).toString("base64url"), port: Number(process.env.ARBOR_DB_PORT) || 54329, database: "arbor" };
  writeFileSync(file, JSON.stringify(config, null, 2), { mode: 0o600 });
  return config;
}
export function localDatabaseUrl(config: LocalDbConfig, database = config.database): string {
  return `postgresql://${config.user}:${encodeURIComponent(config.password)}@127.0.0.1:${config.port}/${database}`;
}
export function databaseUrl(): string | undefined {
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL;
  const config = localDbConfig();
  return config && localDatabaseUrl(config);
}
/** Removes credentials from a connection string before it is logged. */
export function describeUrl(url: string): string {
  try { const u = new URL(url); u.password = u.password ? "***" : ""; return u.toString(); } catch { return "(invalid DATABASE_URL)"; }
}
