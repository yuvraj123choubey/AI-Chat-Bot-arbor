import { extractJson, generateStructured, generateText, type CallRecord } from "../../ai/src/structured.ts";
import type { AIProvider, Message, ModelDefinition, ProviderName } from "../../ai/src/types.ts";
import { actionSchema, validateAction, type AgentAction } from "./agent.ts";

export interface DecideOptions {
  candidates: ModelDefinition[];
  providers: Map<ProviderName, AIProvider>;
  signal?: AbortSignal;
  onCall?: (call: CallRecord) => void | Promise<void>;
}

/**
 * Chooses the agent's next tool call with whatever model is configured. A model that reasons privately first
 * (e.g. a "thinking" model) is asked for a JSON reply without a grammar, since a grammar would switch its reasoning
 * off; its answer is parsed and validated, with one corrective retry. Other models get schema-constrained output.
 * If the reasoning path fails, the constrained path with the remaining models is used, so a step never stalls.
 */
export function modelDecider(options: DecideOptions): (messages: Message[]) => Promise<AgentAction> {
  const [first] = options.candidates;
  const common = { providers: options.providers, signal: options.signal, onCall: options.onCall };
  // One tool call is at most ~3000 tokens (a whole small file); a call far slower than that is stuck, not thinking.
  const constrained = (candidates: ModelDefinition[], messages: Message[]) => generateStructured({ ...common, name: "agent_action", schema: actionSchema, validate: validateAction, candidates, messages, maxOutputTokens: 3000, temperature: 0.1, timeoutMs: 120_000 }).then(r => r.data);
  if (!first?.supportsReasoning) return messages => constrained(options.candidates, messages);
  const instruction = "Reply with only one JSON object: the tool call, with an \"action\" field and the fields that tool needs, plus a short \"note\".";
  return async messages => {
    let convo: Message[] = [...messages, { role: "user", content: instruction }];
    for (let attempt = 0; attempt < 2; attempt++) {
      let text: string;
      try { text = (await generateText({ ...common, candidates: [first], messages: convo, maxOutputTokens: 6000, timeoutMs: 300_000 })).text; }
      catch (error) { if (options.signal?.aborted) throw error; break; }
      let problem: string;
      try {
        const checked = validateAction(extractJson(text));
        if (typeof checked !== "string") return checked;
        problem = checked;
      } catch (error) { problem = error instanceof Error ? error.message : "invalid JSON"; }
      convo = [...convo, { role: "assistant", content: text.slice(-2000) }, { role: "user", content: `That reply was not a usable tool call (${problem}). ${instruction}` }];
    }
    const rest = options.candidates.slice(1);
    return constrained(rest.length ? rest : [first], messages);
  };
}
