import { OpenAICompatibleProvider } from "./openai-compatible.ts";

export class OpenAIProvider extends OpenAICompatibleProvider {
  constructor(key = process.env.OPENAI_API_KEY, baseUrl = process.env.OPENAI_BASE_URL || "https://api.openai.com/v1") {
    super("openai", `${baseUrl.replace(/\/+$/, "")}/chat/completions`, key, "max_completion_tokens");
  }
}
