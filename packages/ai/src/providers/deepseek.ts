import { OpenAICompatibleProvider } from "./openai-compatible.ts";

/**
 * DeepSeek's OpenAI-compatible chat-completions API. Credentials are read only on the API server.
 * Reasoning models also return `reasoning_content`; the shared parser reads only `content`, so private reasoning is never surfaced.
 */
export class DeepSeekProvider extends OpenAICompatibleProvider {
  constructor(key = process.env.DEEPSEEK_API_KEY, baseUrl = process.env.DEEPSEEK_BASE_URL || "https://api.deepseek.com") {
    super("deepseek", `${baseUrl.replace(/\/+$/, "")}/chat/completions`, key, "max_tokens", "object");
  }
}
