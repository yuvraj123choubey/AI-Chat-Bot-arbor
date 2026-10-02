export type Level = "fast" | "balanced" | "deep";
export type SearchMode = "auto" | "on" | "off";
export type Model = { id: string; provider: string; providerLabel: string; displayName: string; modelId: string; capabilities: string[] };
export type Meta = { providerLabel: string; displayName: string; modelId: string; reasoningLevel: Level; fallbackFrom: string[] };
export type SourceInfo = {
  id: string; url: string; title: string; domain: string; author: string | null; publisher: string | null; publicationDate: string | null;
  snippet: string; sourceType: string; saved: boolean; retrievedAt?: string; searchQuery?: string | null;
};
export type MessageSource = { ordinal: number; cited: boolean; source: SourceInfo };
export type Step = { stage: string; label: string; detail?: string };
export type ChatMessage = {
  id: string; role: "user" | "assistant"; content: string;
  status?: "streaming" | "complete" | "stopped" | "error"; meta?: Meta; stop?: string; error?: string; thinking?: boolean;
  steps?: Step[]; sources?: MessageSource[];
};
export type Summary = { id: string; title: string; updatedAt: string };
export type StoredConversation = Summary & { messages: ChatMessage[] };

export const WORKSPACE = "default";
const json = { "content-type": "application/json" };

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, init);
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || `Request failed (${response.status})`);
  return data as T;
}
export const api = {
  models: () => call<Model[]>("/api/models"),
  conversations: () => call<Summary[]>(`/api/conversations?workspaceId=${WORKSPACE}`),
  conversation: (id: string) => call<StoredConversation>(`/api/conversations/${id}?workspaceId=${WORKSPACE}`),
  rename: (id: string, title: string) => call(`/api/conversations/${id}?workspaceId=${WORKSPACE}`, { method: "PATCH", headers: json, body: JSON.stringify({ title }) }),
  remove: (id: string) => call(`/api/conversations/${id}?workspaceId=${WORKSPACE}`, { method: "DELETE" }),
  sources: (saved: boolean, q = "") => call<SourceInfo[]>(`/api/sources?workspaceId=${WORKSPACE}&saved=${saved}${q ? `&q=${encodeURIComponent(q)}` : ""}`),
  saveSource: (id: string, saved: boolean) => call<{ saved: boolean }>(`/api/sources/${id}/save?workspaceId=${WORKSPACE}`, { method: "POST", headers: json, body: JSON.stringify({ saved }) })
};

/** Reads an NDJSON response body as a stream of parsed events. */
export async function* ndjsonEvents(response: Response): AsyncGenerator<any> {
  const reader = response.body!.pipeThrough(new TextDecoderStream()).getReader();
  let buffer = "";
  for (let read = await reader.read(); !read.done; read = await reader.read()) {
    buffer += read.value;
    const lines = buffer.split("\n");
    buffer = lines.pop() || "";
    for (const line of lines) if (line.trim()) yield JSON.parse(line);
  }
}

export function formatDate(iso: string | null | undefined): string {
  if (!iso) return "";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "" : d.toLocaleDateString(undefined, { year: "numeric", month: "short", day: d.getUTCDate() === 1 && d.getUTCMonth() === 0 ? undefined : "numeric" });
}
export const typeLabel: Record<string, string> = {
  web: "Web", academic: "Academic", government: "Government", documentation: "Docs", news: "News", forum: "Forum",
  encyclopedia: "Encyclopedia", uploaded_file: "Your file", course_material: "Course material"
};
