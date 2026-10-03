import type { Db, Prisma } from "../../../../packages/db/src/client.ts";
import type { ReasoningMode, TaskKind } from "../../../../packages/ai/src/types.ts";

/** Stored on a user message: the files attached to it, so they show after a reload and later turns can keep using them. */
export interface UserMeta { attachments: { id: string; name: string }[] }
export interface MessageMeta { modelId: string; registryId: string; provider: string; providerLabel: string; displayName: string; reasoningLevel: ReasoningMode; taskKind: TaskKind; fallbackFrom: string[] }
export interface MessageSourceView {
  ordinal: number; cited: boolean;
  /** For uploaded files: where the cited passage is (page, section, line range). */
  locator?: { page?: number; section?: string; lines?: [number, number] };
  source: { id: string; url: string; title: string; domain: string; author: string | null; publisher: string | null; publicationDate: string | null; snippet: string; sourceType: string; saved: boolean };
}
export interface MessageView {
  id: string; role: "user" | "assistant"; content: string; createdAt: string;
  status?: "complete" | "stopped" | "error"; stop?: string; error?: string; meta?: MessageMeta; steps?: unknown; sources?: MessageSourceView[];
  /** Names of the files attached to a user message. */
  attachments?: string[];
}
export interface ConversationSummary { id: string; title: string; updatedAt: string }
export interface ConversationView extends ConversationSummary { workspaceId: string; createdAt: string; messages: MessageView[] }

export function titleFrom(message: string): string {
  const line = message.replace(/\s+/g, " ").trim();
  return line.length > 60 ? `${line.slice(0, 57).trimEnd()}…` : line || "New conversation";
}
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export function isConversationId(id: string): boolean { return uuid.test(id); }

const messageInclude = { sources: { orderBy: { ordinal: "asc" }, include: { source: true } } } satisfies Prisma.MessageInclude;
type MessageRow = Prisma.MessageGetPayload<{ include: typeof messageInclude }>;

export function toMessageView(m: MessageRow): MessageView {
  return {
    id: m.id, role: m.role, content: m.content, createdAt: m.createdAt.toISOString(),
    ...(m.status ? { status: m.status } : {}), ...(m.stop ? { stop: m.stop } : {}), ...(m.error ? { error: m.error } : {}),
    ...(m.meta && m.role === "user" ? { attachments: ((m.meta as unknown as UserMeta).attachments ?? []).map(a => a.name) } : m.meta ? { meta: m.meta as unknown as MessageMeta } : {}), ...(m.steps ? { steps: m.steps } : {}),
    ...(m.sources.length ? {
      sources: m.sources.map(s => ({
        ordinal: s.ordinal, cited: s.cited, ...(s.locator ? { locator: s.locator as MessageSourceView["locator"] } : {}),
        source: { id: s.source.id, url: s.source.url, title: s.source.title, domain: s.source.domain, author: s.source.author, publisher: s.source.publisher, publicationDate: s.source.publicationDate?.toISOString() ?? null, snippet: s.source.snippet, sourceType: s.source.sourceType, saved: s.source.saved }
      }))
    } : {})
  };
}

export class ConversationRepo {
  constructor(private readonly db: Db) {}

  async list(workspaceId: string): Promise<ConversationSummary[]> {
    const rows = await this.db.conversation.findMany({ where: { workspaceId }, orderBy: { updatedAt: "desc" }, take: 100, select: { id: true, title: true, updatedAt: true } });
    return rows.map(r => ({ id: r.id, title: r.title, updatedAt: r.updatedAt.toISOString() }));
  }
  async get(id: string, workspaceId: string): Promise<ConversationView | undefined> {
    if (!isConversationId(id)) return undefined;
    const c = await this.db.conversation.findFirst({ where: { id, workspaceId }, include: { messages: { orderBy: { position: "asc" }, include: messageInclude } } });
    if (!c) return undefined;
    return { id: c.id, title: c.title, workspaceId: c.workspaceId, createdAt: c.createdAt.toISOString(), updatedAt: c.updatedAt.toISOString(), messages: c.messages.map(toMessageView) };
  }
  create(workspaceId: string, title: string) {
    return this.db.conversation.create({ data: { workspaceId, title } });
  }
  /** Appends at the next position and bumps the conversation so history lists it first. */
  addMessage(conversationId: string, data: { role: "user" | "assistant"; content: string; meta?: MessageMeta | UserMeta }) {
    return this.db.$transaction(async tx => {
      const last = await tx.message.findFirst({ where: { conversationId }, orderBy: { position: "desc" }, select: { position: true } });
      const message = await tx.message.create({ data: { conversationId, role: data.role, content: data.content, position: (last?.position ?? -1) + 1, meta: data.meta as unknown as Prisma.InputJsonValue } });
      await tx.conversation.update({ where: { id: conversationId }, data: { updatedAt: new Date() } });
      return message;
    });
  }
  async finishMessage(id: string, patch: { content: string; status: "complete" | "stopped" | "error"; stop?: string; error?: string; meta?: MessageMeta; steps?: unknown }) {
    const message = await this.db.message.update({
      where: { id },
      data: { content: patch.content, status: patch.status, stop: patch.stop ?? null, error: patch.error ?? null, meta: patch.meta as unknown as Prisma.InputJsonValue, steps: patch.steps as Prisma.InputJsonValue }
    });
    await this.db.conversation.update({ where: { id: message.conversationId }, data: { updatedAt: new Date() } });
  }
  /** For regenerate: removes the answers after the last user message. */
  async dropTrailingAssistants(conversationId: string): Promise<boolean> {
    const lastUser = await this.db.message.findFirst({ where: { conversationId, role: "user" }, orderBy: { position: "desc" }, select: { position: true } });
    if (!lastUser) return false;
    await this.db.message.deleteMany({ where: { conversationId, position: { gt: lastUser.position } } });
    return true;
  }
  async history(conversationId: string) {
    const rows = await this.db.message.findMany({ where: { conversationId }, orderBy: { position: "asc" }, select: { role: true, content: true, meta: true } });
    return rows.map(r => ({ role: r.role, content: r.content, meta: r.meta as unknown as MessageMeta | null }));
  }
  async delete(id: string, workspaceId: string): Promise<boolean> {
    if (!isConversationId(id)) return false;
    return (await this.db.conversation.deleteMany({ where: { id, workspaceId } })).count > 0;
  }
  async rename(id: string, workspaceId: string, title: string): Promise<boolean> {
    if (!isConversationId(id)) return false;
    return (await this.db.conversation.updateMany({ where: { id, workspaceId }, data: { title } })).count > 0;
  }
  /** Replies still marked as generating after a restart were cut off by the restart. */
  markInterrupted() {
    return this.db.message.updateMany({ where: { role: "assistant", status: null }, data: { status: "error", error: "The server restarted before this response finished." } });
  }
}
