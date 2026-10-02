import "./apps/api/src/setup-env.ts";
import { defineConfig } from "prisma/config";
import { databaseUrl } from "./packages/db/src/local.ts";

export default defineConfig({
  schema: "packages/db/prisma/schema.prisma",
  migrations: { path: "packages/db/prisma/migrations" },
  // Empty only before the local database exists; `generate` does not need a connection.
  datasource: { url: databaseUrl() ?? "" }
});
