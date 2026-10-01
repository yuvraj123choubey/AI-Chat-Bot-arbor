import { mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ReasoningMode, TaskKind } from "../../../packages/ai/src/types.ts";

export interface StoredMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  createdAt: string;
  /** Assistant messages only: which model actually answered, after any fallback. */
  meta?: { modelId: string; registryId: string; provider: string; providerLabel: string; displayName: string; reasoningLevel: ReasoningMode; taskKind: TaskKind; fallbackFrom: string[] };
  status?: "complete" | "stopped" | "error";
  stop?: "length" | "filtered";
  error?: string;
}
export interface Conversation { id: string; title: string; workspaceId: string; createdAt: string; updatedAt: string; messages: StoredMessage[] }
export type ConversationSummary = Pick<Conversation, "id" | "title" | "workspaceId" | "updatedAt">;

/** Storage boundary for chat history; a database-backed implementation can replace the file store without touching the API. */
export interface ConversationStore {
  list(workspaceId: string): Promise<ConversationSummary[]>;
  get(id: string): Promise<Conversation | undefined>;
  save(conversation: Conversation): Promise<void>;
  delete(id: string): Promise<boolean>;
}
const idPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export function isConversationId(id: string): boolean { return idPattern.test(id); }
export function titleFrom(message: string): string {
  const line = message.replace(/\s+/g, " ").trim();
  return line.length > 60 ? `${line.slice(0, 57).trimEnd()}…` : line || "New conversation";
}

export class FileConversationStore implements ConversationStore {
  constructor(private readonly folder = "data/conversations") {}
  private path(id: string) {
    // IDs are validated so a request can never address a file outside the store.
    if (!isConversationId(id)) throw new Error("Invalid conversation id");
    return join(this.folder, `${id}.json`);
  }
  async list(workspaceId: string): Promise<ConversationSummary[]> {
    const names = await readdir(this.folder).catch(() => [] as string[]);
    const all = await Promise.all(names.filter(n => n.endsWith(".json")).map(n => this.get(n.slice(0, -5)).catch(() => undefined)));
    return all.filter((c): c is Conversation => Boolean(c) && c!.workspaceId === workspaceId)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
      .map(({ id, title, workspaceId, updatedAt }) => ({ id, title, workspaceId, updatedAt }));
  }
  async get(id: string): Promise<Conversation | undefined> {
    if (!isConversationId(id)) return undefined;
    try { return JSON.parse(await readFile(this.path(id), "utf8")); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
  }
  async save(conversation: Conversation): Promise<void> {
    await mkdir(this.folder, { recursive: true });
    // Write-then-rename so a crash mid-write never leaves a truncated conversation.
    const temp = `${this.path(conversation.id)}.${process.pid}.tmp`;
    await writeFile(temp, JSON.stringify(conversation, null, 1));
    await rename(temp, this.path(conversation.id));
  }
  async delete(id: string): Promise<boolean> {
    if (!(await this.get(id))) return false;
    await rm(this.path(id), { force: true });
    return true;
  }
}
