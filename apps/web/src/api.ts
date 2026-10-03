export type Level = "fast" | "balanced" | "deep";
export type SearchMode = "auto" | "on" | "off";
export type SearchScope = "auto" | "web" | "files" | "both";
export type Model = { id: string; provider: string; providerLabel: string; displayName: string; modelId: string; capabilities: string[] };
export type Meta = { providerLabel: string; displayName: string; modelId: string; reasoningLevel: Level; fallbackFrom: string[] };
export type SourceInfo = {
  id: string; url: string; title: string; domain: string; author: string | null; publisher: string | null; publicationDate: string | null;
  snippet: string; sourceType: string; saved: boolean; retrievedAt?: string; searchQuery?: string | null;
};
/** Where in an uploaded document a cited passage is. */
export type Locator = { page?: number; section?: string; lines?: [number, number] };
export type MessageSource = { ordinal: number; cited: boolean; source: SourceInfo; locator?: Locator };
export type DocumentStatus = "processing" | "ready" | "failed";
export type DocumentLinkView = { id: string; type: "conversation" | "research" | "assignment" | "project"; targetId: string; role: string | null };
export type DocumentView = { id: string; name: string; displayName?: string | null; mimeType: string; sizeBytes: number; kind: string; status: DocumentStatus; error: string | null; pageCount: number | null; chunkCount: number | null; createdAt: string; links?: DocumentLinkView[] };
export type DocumentPreview =
  | { kind: "pages"; total: number; from: number; to: number; pages: { page: number; text: string }[] }
  | { kind: "sections"; total: number; from: number; to: number; sections: { index: number; section: string | null; text: string }[] }
  | { kind: "lines"; total: number; from: number; to: number; lines: { n: number; text: string }[] }
  | { kind: "image"; text: string };
export const documentKinds: Record<string, string> = { upload: "Upload", course_material: "Course material", assignment_instructions: "Instructions", rubric: "Rubric", lecture: "Lecture", starter_code: "Starter code", screenshot: "Screenshot" };
export const documentTitle = (d: { name: string; displayName?: string | null }) => d.displayName || d.name;
export const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;
export const UPLOAD_ACCEPT = ".pdf,.docx,.txt,.md,.markdown,.png,.jpg,.jpeg,.js,.jsx,.ts,.tsx,.py,.java,.c,.h,.cpp,.hpp,.cs,.go,.rs,.rb,.php,.swift,.kt,.scala,.sql,.sh,.html,.css,.json,.yaml,.yml,.xml,.toml";
export type Step = { stage: string; label: string; detail?: string };
export type ChatMessage = {
  id: string; role: "user" | "assistant"; content: string;
  status?: "streaming" | "complete" | "stopped" | "error"; meta?: Meta; stop?: string; error?: string; thinking?: boolean;
  steps?: Step[]; sources?: MessageSource[];
  /** Measured in this browser session only: time to first text and to completion. */
  firstTextMs?: number; elapsedMs?: number;
  /** Names of files attached to a user message in this session. */
  attachments?: string[];
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
  saveSource: (id: string, saved: boolean) => call<{ saved: boolean }>(`/api/sources/${id}/save?workspaceId=${WORKSPACE}`, { method: "POST", headers: json, body: JSON.stringify({ saved }) }),
  researchList: () => call<ResearchSummary[]>(`/api/research?workspaceId=${WORKSPACE}`),
  research: (id: string) => call<ResearchDetail>(`/api/research/${id}?workspaceId=${WORKSPACE}`),
  startResearch: (question: string, selectedModel: string) => call<{ researchId: string; taskId: string }>("/api/research", { method: "POST", headers: json, body: JSON.stringify({ question, selectedModel, workspaceId: WORKSPACE }) }),
  cancelTask: (taskId: string) => call(`/api/tasks/${taskId}/cancel?workspaceId=${WORKSPACE}`, { method: "POST", headers: json, body: "{}" }),
  deleteResearch: (id: string) => call(`/api/research/${id}?workspaceId=${WORKSPACE}`, { method: "DELETE" }),
  taskEvents: (taskId: string, signal: AbortSignal) => fetch(`/api/tasks/${taskId}/events?workspaceId=${WORKSPACE}`, { signal }),
  documents: (filters: { q?: string; kind?: string; status?: string; linked?: string } = {}) => call<DocumentView[]>(`/api/documents?workspaceId=${WORKSPACE}${Object.entries(filters).filter(([, v]) => v).map(([k, v]) => `&${k}=${encodeURIComponent(v!)}`).join("")}`),
  renameDocument: (id: string, displayName: string | null) => call<DocumentView>(`/api/documents/${id}?workspaceId=${WORKSPACE}`, { method: "PATCH", headers: json, body: JSON.stringify({ displayName }) }),
  linkDocument: (id: string, type: DocumentLinkView["type"], targetId: string, role?: string) => call<DocumentLinkView>(`/api/documents/${id}/links?workspaceId=${WORKSPACE}`, { method: "POST", headers: json, body: JSON.stringify({ type, targetId, role }) }),
  unlinkDocument: (id: string, linkId: string) => call(`/api/documents/${id}/links/${linkId}?workspaceId=${WORKSPACE}`, { method: "DELETE" }),
  documentPages: (id: string, from?: number, to?: number) => call<DocumentPreview>(`/api/documents/${id}/pages?workspaceId=${WORKSPACE}${from ? `&from=${from}` : ""}${to ? `&to=${to}` : ""}`),
  document: (id: string) => call<DocumentView>(`/api/documents/${id}?workspaceId=${WORKSPACE}`),
  deleteDocument: (id: string) => call(`/api/documents/${id}?workspaceId=${WORKSPACE}`, { method: "DELETE" }),
  /** Uploads one file; a duplicate of an existing file returns that document and no task. */
  uploadDocument: (file: File, options: { kind?: string; assignmentId?: string; role?: string } = {}) => {
    const form = new FormData();
    form.append("file", file, file.name);
    const extra = Object.entries(options).filter(([, v]) => v).map(([k, v]) => `&${k}=${encodeURIComponent(v!)}`).join("");
    // The custom header forces a CORS preflight, so other websites cannot make the browser post files here.
    return call<{ document: DocumentView; taskId?: string | null }>(`/api/documents?workspaceId=${WORKSPACE}${extra}`, { method: "POST", body: form, headers: { "x-arbor-client": "web" } });
  }
};
/** Asks the app to show the in-app preview of an uploaded document, at a cited location if given. */
export function openDocumentPreview(id: string, locator?: Locator) {
  window.dispatchEvent(new CustomEvent("arbor:preview", { detail: { id, locator } }));
}
export const documentIdFromUrl = (url: string) => url.match(/\/api\/documents\/([0-9a-f-]{36})\/file/)?.[1];
/** Link to the original uploaded file, opened at the cited page for PDFs. */
export function documentHref(url: string, locator?: Locator): string {
  return locator?.page && /\/api\/documents\//.test(url) ? `${url}#page=${locator.page}` : url;
}
export function locatorText(locator?: Locator): string {
  if (!locator) return "";
  return [locator.page ? `p. ${locator.page}` : "", locator.section ? `§ ${locator.section}` : "", locator.lines ? `lines ${locator.lines[0]}–${locator.lines[1]}` : ""].filter(Boolean).join(" · ");
}
export function formatBytes(n: number): string {
  return n < 1024 ? `${n} B` : n < 1024 * 1024 ? `${(n / 1024).toFixed(0)} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`;
}

export type ResearchStatus = "planning" | "running" | "completed" | "failed" | "cancelled";
export type ResearchSummary = { id: string; question: string; status: ResearchStatus; createdAt: string; updatedAt: string; taskId: string | null };
export type TaskStep = { id: string; ordinal: number; kind: string; title: string; status: string; startedAt: string | null; finishedAt: string | null; error: string | null };
export type ResearchDetail = ResearchSummary & {
  plan: { objective: string; subquestions: { question: string; queries: string[] }[] } | null;
  queries: string[]; report: string | null; error: string | null;
  sources: MessageSource[]; notes: { topic: string | null; content: string; sourceOrdinals: number[] }[]; steps: TaskStep[];
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
  official: "Official", web: "Web", academic: "Academic", government: "Government", documentation: "Docs", news: "News", forum: "Forum",
  encyclopedia: "Encyclopedia", uploaded_file: "Your file", course_material: "Course material"
};
