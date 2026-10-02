import { useMemo, useState } from "react";
import type { ChatMessage, Level } from "../api.ts";
import { Markdown, type Citations } from "../markdown.tsx";
import { SourceStrip } from "./Sources.tsx";

const levelLabel: Record<Level, string> = { fast: "Fast", balanced: "Balanced", deep: "Deep" };

/** Research progress: the live stage while working, a one-line summary once done. */
function ResearchSteps({ message }: { message: ChatMessage }) {
  const stages = (message.steps || []).filter(s => s.stage !== "notice");
  if (!stages.length) return null;
  if (message.status !== "streaming") {
    const read = message.sources?.length ?? 0;
    return <div className="research-summary">⌕ Searched the web · {read} source{read === 1 ? "" : "s"} used</div>;
  }
  return <ol className="research-steps" aria-live="polite">
    {stages.map((s, i) => {
      const current = i === stages.length - 1 && !message.content;
      return <li key={s.stage} className={current ? "active" : "done"}><span className="step-mark" aria-hidden="true">{current ? "◌" : "✓"}</span>{s.label}{s.detail && <small>{s.detail}</small>}</li>;
    })}
  </ol>;
}

export function AnswerCard({ message, isLast, canRegenerate, streaming, onRegenerate, onOpenSources }: {
  message: ChatMessage; isLast: boolean; canRegenerate: boolean; streaming: boolean; onRegenerate(): void; onOpenSources(ordinal?: number): void;
}) {
  const notices = (message.steps || []).filter(s => s.stage === "notice");
  const citations = useMemo<Citations | undefined>(() => message.sources?.length ? {
    ordinals: new Set(message.sources.map(s => s.ordinal)), titles: new Map(message.sources.map(s => [s.ordinal, s.source.title])), onCite: n => onOpenSources(n)
  } : undefined, [message.sources, onOpenSources]);
  return <section className="answer">
    <div className="answer-heading"><span className="answer-icon">✳</span><div><strong>Arbor</strong>
      {message.meta && <small title={`${message.meta.displayName} · ${message.meta.modelId}${message.meta.fallbackFrom.length ? ` · used after ${message.meta.fallbackFrom.join(", ")} failed` : ""}`}>{message.meta.providerLabel} • {levelLabel[message.meta.reasoningLevel]}{message.meta.fallbackFrom.length > 0 && " · fallback"}</small>}
    </div></div>
    <ResearchSteps message={message} />
    {notices.map(n => <div key={n.label} className="msg-note">{n.label}</div>)}
    {message.sources && message.sources.length > 0 && <SourceStrip sources={message.sources} onOpen={onOpenSources} />}
    <div className="answer-text md">
      {message.content ? <Markdown text={message.content} citations={citations} /> : message.status === "streaming" && !message.steps?.length && <p className="thinking">{message.thinking ? "Thinking…" : "Working…"}</p>}
      {message.status === "streaming" && message.content && <span className="caret" aria-hidden="true" />}
    </div>
    {message.status === "stopped" && <div className="msg-note">Stopped.</div>}
    {message.stop === "length" && <div className="msg-note">The response reached its length limit. Ask Arbor to continue.</div>}
    {message.stop === "filtered" && <div className="msg-note">The provider cut this response short.</div>}
    {message.status === "error" && <div className="error" role="alert">{message.error}</div>}
    {message.status !== "streaming" && <div className="msg-actions">
      {message.content && <CopyButton text={message.content} />}
      {message.sources && message.sources.length > 0 && <button type="button" onClick={() => onOpenSources()}>⌕ Sources ({message.sources.length})</button>}
      {isLast && canRegenerate && <button type="button" onClick={onRegenerate} disabled={streaming}>↻ Regenerate</button>}
    </div>}
  </section>;
}

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  return <button type="button" onClick={() => navigator.clipboard.writeText(text).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1500); }, () => {})}>{copied ? "✓ Copied" : "⧉ Copy"}</button>;
}
