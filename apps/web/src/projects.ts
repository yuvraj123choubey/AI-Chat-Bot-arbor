import { WORKSPACE } from "./api.ts";

export type ProjectView = { id: string; name: string; template: string | null; createdAt: string; kind: string; label: string; testCommand?: string; buildCommand?: string };
export type Template = { id: string; label: string; description: string };
export type TreeEntry = { path: string; name: string; type: "file" | "dir"; size?: number; children?: TreeEntry[] };
export type FileContent = { path: string; content: string | null; size: number; binary: boolean; language: string; truncated: boolean };
export type SearchHit = { path: string; line: number; text: string };
export type FileChange = { path: string; status: "added" | "modified" | "deleted" | "renamed"; added: number; removed: number; oldPath?: string };
export type Checkpoint = { commit: string; message: string; author: "you" | "agent" | "system"; createdAt: string; files: FileChange[] };
export type Diff = { files: FileChange[]; patch: string; truncated: boolean };
export type RunInfo = { id: string; command: string; status: "running" | "exited" | "failed" | "cancelled" | "timeout"; exitCode: number | null; startedAt: string; endedAt: string | null; kind: "command" | "server"; truncated: boolean };
export type PreviewState = { kind?: string; status: "idle" | "installing" | "starting" | "running" | "failed" | "unsupported"; url?: string; port?: number; runId?: string; installRunId?: string; message?: string };
export type PlanStep = { step: string; status: "todo" | "doing" | "done" };
export type MemoryView = { goal: string; plan: PlanStep[]; relevant: { path: string; reason: string }[]; edits: { path: string; summary: string }[]; commands: { command: string; status: string }[]; failures: string[]; remainingChecks: string[] };
export type AgentMetrics = { success: boolean; finished: boolean; checksPassing: boolean | null; filesChanged: number; linesAdded: number; linesRemoved: number; retries: number; checkRuns: number; steps: number; elapsedMs: number; finalChecks: { name: string; status: string }[] };
export type AgentOutput = { summary: string; baseCommit?: string; commit?: string; files: FileChange[]; commands: { command: string; status: string; exitCode: number | null }[]; steps: number; stoppedEarly: boolean; metrics?: AgentMetrics };
export type AgentRun = { taskId: string; task: string; status: string; error: string | null; output: AgentOutput | null; createdAt: string; finishedAt: string | null };

const q = `workspaceId=${WORKSPACE}`;
const json = { "content-type": "application/json" };
async function call<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, init);
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || `Request failed (${response.status})`);
  return data as T;
}
const base = (id: string) => `/api/projects/${id}`;
const enc = encodeURIComponent;

export const projectsApi = {
  templates: () => call<Template[]>(`/api/projects/templates?${q}`),
  list: () => call<ProjectView[]>(`/api/projects?${q}`),
  create: (name: string, template: string) => call<ProjectView>(`/api/projects?${q}`, { method: "POST", headers: json, body: JSON.stringify({ name, template }) }),
  get: (id: string) => call<ProjectView>(`${base(id)}?${q}`),
  rename: (id: string, name: string) => call(`${base(id)}?${q}`, { method: "PATCH", headers: json, body: JSON.stringify({ name }) }),
  remove: (id: string) => call(`${base(id)}?${q}`, { method: "DELETE" }),
  tree: (id: string) => call<TreeEntry[]>(`${base(id)}/tree?${q}`),
  read: (id: string, path: string) => call<FileContent>(`${base(id)}/file?${q}&path=${enc(path)}`),
  rawUrl: (id: string, path: string) => `${base(id)}/raw?${q}&path=${enc(path)}`,
  write: (id: string, path: string, content: string) => call(`${base(id)}/file?${q}`, { method: "PUT", headers: json, body: JSON.stringify({ path, content }) }),
  writeBase64: (id: string, path: string, contentBase64: string) => call(`${base(id)}/file?${q}`, { method: "PUT", headers: json, body: JSON.stringify({ path, contentBase64 }) }),
  fs: (id: string, op: "mkdir" | "rename" | "delete", path: string, to?: string) => call(`${base(id)}/fs?${q}`, { method: "POST", headers: json, body: JSON.stringify({ op, path, to }) }),
  search: (id: string, text: string) => call<SearchHit[]>(`${base(id)}/search?${q}&q=${enc(text)}`),
  history: (id: string) => call<Checkpoint[]>(`${base(id)}/history?${q}`),
  changes: (id: string) => call<Diff>(`${base(id)}/changes?${q}`),
  /** Changes made by one checkpoint, or everything between `from` and `commit` (e.g. a whole agent run). */
  checkpointDiff: (id: string, commit: string, from?: string) => call<Diff>(`${base(id)}/history/${commit}?${q}${from ? `&from=${from}` : ""}`),
  checkpoint: (id: string, label: string) => call<Checkpoint | { unchanged: true }>(`${base(id)}/history?${q}`, { method: "POST", headers: json, body: JSON.stringify({ label }) }),
  restore: (id: string, commit: string) => call(`${base(id)}/history/${commit}/restore?${q}`, { method: "POST", headers: json, body: "{}" }),
  runs: (id: string) => call<RunInfo[]>(`${base(id)}/runs?${q}`),
  run: (id: string, command: string) => call<RunInfo>(`${base(id)}/runs?${q}`, { method: "POST", headers: json, body: JSON.stringify({ command }) }),
  runEvents: (id: string, run: string, signal: AbortSignal) => fetch(`${base(id)}/runs/${run}/events?${q}`, { signal }),
  cancelRun: (id: string, run: string) => call(`${base(id)}/runs/${run}/cancel?${q}`, { method: "POST", headers: json, body: "{}" }),
  preview: (id: string) => call<PreviewState>(`${base(id)}/preview?${q}`),
  previewAction: (id: string, action: "start" | "stop") => call<PreviewState>(`${base(id)}/preview?${q}`, { method: "POST", headers: json, body: JSON.stringify({ action }) }),
  startAgent: (id: string, task: string, selectedModel: string, context?: string) => call<{ taskId: string }>(`${base(id)}/agent?${q}`, { method: "POST", headers: json, body: JSON.stringify({ task, selectedModel, context }) }),
  agentRuns: (id: string) => call<AgentRun[]>(`${base(id)}/agent?${q}`)
};
