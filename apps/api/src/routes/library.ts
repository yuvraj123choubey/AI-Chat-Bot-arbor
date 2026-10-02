import { providerLabel } from "../../../../packages/ai/src/registry.ts";
import type { App } from "../app.ts";
import { readJson, send, type RouteContext } from "../http.ts";
import { parseWorkspace } from "./chat.ts";

/** Models, conversation history and the source library. */
export function libraryRoutes(app: App) {
  const workspaceOf = async (query: URLSearchParams) => {
    const slug = parseWorkspace(query.get("workspaceId") ?? undefined);
    return slug ? app.workspace(slug) : undefined;
  };
  return {
    models: ({ res }: RouteContext) => send(res, 200, app.chatModels().map(m => ({
      id: m.id, provider: m.provider, providerLabel: providerLabel(m.provider), displayName: m.displayName, modelId: m.modelId, capabilities: m.capabilities,
      supportsStreaming: m.supportsStreaming, supportsTools: m.supportsTools, supportsVision: m.supportsVision, supportsReasoning: m.supportsReasoning, supportsCoding: m.supportsCoding
    }))),
    searchStatus: ({ res }: RouteContext) => send(res, 200, app.searchProviders.map(p => ({ id: p.id, label: p.label, coverage: p.coverage, configured: p.isConfigured() }))),

    async listConversations({ res, query }: RouteContext) {
      const workspaceId = await workspaceOf(query);
      return workspaceId ? send(res, 200, await app.conversations.list(workspaceId)) : send(res, 400, { error: "Invalid workspace" });
    },
    async getConversation({ res, query, params }: RouteContext) {
      const workspaceId = await workspaceOf(query);
      const conversation = workspaceId && await app.conversations.get(params[0], workspaceId);
      return conversation ? send(res, 200, conversation) : send(res, 404, { error: "Conversation not found" });
    },
    async renameConversation({ req, res, query, params }: RouteContext) {
      const body = await readJson(req);
      if (typeof body.title !== "string" || !body.title.trim() || body.title.length > 200) return send(res, 400, { error: "Title must contain 1–200 characters" });
      const workspaceId = await workspaceOf(query);
      return workspaceId && await app.conversations.rename(params[0], workspaceId, body.title.trim()) ? send(res, 200, { ok: true }) : send(res, 404, { error: "Conversation not found" });
    },
    async deleteConversation({ res, query, params }: RouteContext) {
      if (app.generating.has(params[0])) return send(res, 409, { error: "Stop the current response before deleting this conversation." });
      const workspaceId = await workspaceOf(query);
      return workspaceId && await app.conversations.delete(params[0], workspaceId) ? send(res, 200, { ok: true }) : send(res, 404, { error: "Conversation not found" });
    },

    async listSources({ res, query }: RouteContext) {
      const workspaceId = await workspaceOf(query);
      if (!workspaceId) return send(res, 400, { error: "Invalid workspace" });
      return send(res, 200, await app.sources.list(workspaceId, { saved: query.get("saved") === "true", query: query.get("q")?.slice(0, 200) || undefined }));
    },
    async getSource({ res, query, params }: RouteContext) {
      const workspaceId = await workspaceOf(query);
      const source = workspaceId && /^[0-9a-f-]{36}$/.test(params[0]) ? await app.sources.get(workspaceId, params[0]) : undefined;
      return source ? send(res, 200, source) : send(res, 404, { error: "Source not found" });
    },
    async saveSource({ req, res, query, params }: RouteContext) {
      const body = await readJson(req);
      const workspaceId = await workspaceOf(query);
      const ok = workspaceId && /^[0-9a-f-]{36}$/.test(params[0]) && await app.sources.setSaved(workspaceId, params[0], body.saved !== false);
      return ok ? send(res, 200, { ok: true, saved: body.saved !== false }) : send(res, 404, { error: "Source not found" });
    }
  };
}
