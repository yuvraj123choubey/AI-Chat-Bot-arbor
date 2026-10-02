import { existsSync } from "node:fs";
import { mkdir, readFile, readdir, rename } from "node:fs/promises";
import { join } from "node:path";
import type { Db, Prisma } from "../../../../packages/db/src/client.ts";
import { resolveWorkspace, type LocalIdentity } from "./workspace.ts";

interface LegacyMessage { id: string; role: "user" | "assistant"; content: string; createdAt: string; status?: "complete" | "stopped" | "error"; stop?: string; error?: string; meta?: unknown }
interface LegacyConversation { id: string; title: string; workspaceId: string; createdAt: string; updatedAt: string; messages: LegacyMessage[] }

/**
 * Imports conversations saved by the earlier JSON file store, keeping their ids, then moves the files to
 * data/backup/ rather than deleting them. Safe to run on every start: imported ids are skipped.
 */
export async function importLegacyConversations(db: Db, identity: LocalIdentity, dataRoot: string): Promise<number> {
  const folder = join(dataRoot, "conversations");
  if (!existsSync(folder)) return 0;
  const files = (await readdir(folder)).filter(f => f.endsWith(".json"));
  let imported = 0;
  for (const file of files) {
    let legacy: LegacyConversation;
    try { legacy = JSON.parse(await readFile(join(folder, file), "utf8")); } catch { continue; }
    if (!legacy?.id || !Array.isArray(legacy.messages) || await db.conversation.findUnique({ where: { id: legacy.id } })) continue;
    const workspaceId = await resolveWorkspace(db, identity, legacy.workspaceId || "default");
    await db.conversation.create({
      data: {
        id: legacy.id, workspaceId, title: legacy.title || "Imported conversation", createdAt: new Date(legacy.createdAt), updatedAt: new Date(legacy.updatedAt),
        messages: {
          create: legacy.messages.map((m, position) => ({
            id: m.id, position, role: m.role, content: m.content ?? "", createdAt: new Date(m.createdAt),
            status: m.role === "assistant" ? m.status ?? "complete" : null, stop: m.stop ?? null, error: m.error ?? null, meta: (m.meta ?? undefined) as Prisma.InputJsonValue | undefined
          }))
        }
      }
    });
    imported++;
  }
  if (files.length) {
    const backup = join(dataRoot, "backup");
    await mkdir(backup, { recursive: true });
    await rename(folder, join(backup, `conversations-${new Date().toISOString().replace(/[:.]/g, "-")}`));
  }
  return imported;
}
