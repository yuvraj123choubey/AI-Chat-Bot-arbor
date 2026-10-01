export type ProviderName = "openai" | "anthropic" | "google" | "deepseek" | (string & {});
export type Capability = "fast" | "reasoning" | "coding" | "tools" | "vision" | "documents" | "large-context" | "technical-analysis";
export type ReasoningMode = "fast" | "balanced" | "deep";
export type TaskKind = "chat" | "research" | "code" | "math" | "browser" | "build";
export type ModelChoice = "auto" | ProviderName;
/** The job a model performs inside one task; each role is routed independently. */
export type Role = "planner" | "answer" | "verifier" | "reviewer";
export type ProgressStep = "Planning" | "Searching sources" | "Analyzing" | "Checking code" | "Verifying result" | "Reviewing final answer";
export interface ProgressEvent { step: ProgressStep; status: "started" | "done" | "skipped" | "failed"; detail?: string }

export interface ModelDefinition {
  /** Stable registry ID used by the UI and API; independent of the provider's model ID, which can change. */
  id: string;
  provider: ProviderName;
  modelId: string;
  /** Environment variable holding the model ID; takes precedence over modelId so IDs can change without code edits. */
  modelIdEnv?: string;
  displayName: string;
  capabilities: Capability[];
  supportsStreaming: boolean;
  supportsTools: boolean;
  supportsVision: boolean;
  supportsReasoning: boolean;
  supportsCoding: boolean;
  contextWindow: number;
  /** Provider limit on output tokens, if lower than the reasoning level's budget. */
  maxOutputTokens?: number;
  inputUsdPerMillion: number;
  outputUsdPerMillion: number;
  enabled: boolean;
}
export interface Message { role: "system" | "user" | "assistant"; content: string }
export interface ToolDefinition { name: string; description: string; parameters: Record<string, unknown> }
export interface ToolCall { id: string; name: string; arguments: Record<string, unknown> }
export interface Usage { inputTokens: number; outputTokens: number }
export interface GenerateRequest { model: ModelDefinition; messages: Message[]; tools?: ToolDefinition[]; maxOutputTokens?: number; signal?: AbortSignal }
export interface GenerateResult { text: string; toolCalls: ToolCall[]; usage: Usage }
/**
 * `thinking` marks that the model is reasoning privately; its content is never forwarded.
 * `stop` reports an abnormal end: the output budget ran out, or the provider filtered the response.
 */
export interface StreamChunk { text?: string; toolCall?: ToolCall; usage?: Usage; thinking?: true; stop?: "length" | "filtered" }
export interface AIProvider {
  readonly name: ProviderName;
  isConfigured(): boolean;
  generate(request: GenerateRequest): Promise<GenerateResult>;
  stream(request: GenerateRequest): AsyncIterable<StreamChunk>;
  toolCall(request: GenerateRequest): Promise<GenerateResult>;
  reason(request: GenerateRequest): Promise<GenerateResult>;
  analyzeCode(request: GenerateRequest): Promise<GenerateResult>;
}
export interface TaskRequest {
  prompt: string;
  mode: ReasoningMode;
  taskKind?: TaskKind;
  modelChoice: ModelChoice;
  allowedProviders?: ProviderName[];
  workspaceId?: string;
  userId?: string;
}
export interface CallRecord { role: Role; provider: ProviderName; model: string; usage: Usage; estimatedCostUsd: number | null }
export interface CitationCheck {
  method: "structural" | "model";
  checked: number;
  /** Citation markers that point at no retrieved source. */
  invalid: number[];
  /** Cited claims the verifier judged unsupported or only partly supported by the cited source. */
  flagged: { citation: number; claim: string; verdict: "partial" | "unsupported"; note: string }[];
}
export interface TaskResult {
  answer: string;
  provider: ProviderName;
  model: string;
  taskKind: TaskKind;
  /** Totals across every model call in the task. */
  usage: Usage;
  estimatedCostUsd: number | null;
  fallbackFrom: string[];
  /** Behaviour changes the user should know about, e.g. a capability downgrade or a skipped check. */
  notices: string[];
  calls: CallRecord[];
  plan?: string[];
  review?: { provider: ProviderName; model: string; note: string };
  sources?: { title: string; url: string }[];
  citationCheck?: CitationCheck;
}
