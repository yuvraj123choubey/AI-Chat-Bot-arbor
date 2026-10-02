import { OpenAICompatibleProvider } from "./openai-compatible.ts";

/**
 * A model running on this machine behind an OpenAI-compatible endpoint: Arbor's built-in local model server
 * (`npm run dev` starts it) by default, or Ollama / LM Studio / llama.cpp via LOCAL_LLM_URL. Free, needs no key.
 * Set LOCAL_LLM=off to disable it.
 */
export class LocalProvider extends OpenAICompatibleProvider {
  constructor(baseUrl = process.env.LOCAL_LLM_URL || "http://127.0.0.1:11435/v1", private readonly enabled = process.env.LOCAL_LLM !== "off") {
    super("local", `${baseUrl.replace(/\/+$/, "")}/chat/completions`, process.env.LOCAL_LLM_API_KEY || "local");
  }
  isConfigured() { return this.enabled; }
}
