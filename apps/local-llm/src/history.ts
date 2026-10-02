import type { ChatHistoryItem } from "node-llama-cpp";

export interface IncomingMessage { role: string; content: unknown }

/** OpenAI message content may be a string or an array of parts; only text parts are used. */
export function messageText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.map(p => (p && typeof p === "object" && "text" in p ? String((p as { text: unknown }).text) : "")).join("");
  return "";
}
/** Converts OpenAI-style messages to node-llama-cpp history, ending with the empty model turn to be completed. */
export function toHistory(messages: IncomingMessage[]): ChatHistoryItem[] {
  const history: ChatHistoryItem[] = [];
  for (const m of messages) {
    const content = messageText(m.content);
    if (m.role === "system" || m.role === "developer") history.push({ type: "system", text: content });
    else if (m.role === "assistant") history.push({ type: "model", response: [content] });
    else history.push({ type: "user", text: content });
  }
  history.push({ type: "model", response: [] });
  return history;
}
