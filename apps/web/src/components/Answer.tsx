import { useMemo, useState } from "react";
import type { ChatMessage, Level } from "../api.ts";
import { Markdown, type Citations } from "../markdown.tsx";
import { ChevronIcon, CopyIcon, LinkIcon, LogoIcon, RefreshIcon } from "./Icons.tsx";

const levelLabel: Record<Level, string> = { fast: "Fast", balanced: "Balanced", deep: "Deep" };
const seconds = (ms?: number) => (ms === undefined ? undefined : ms < 10_000 ? `${(ms / 1000).toFixed(1)}s` : `${Math.round(ms / 1000)}s`);

/** The real research steps behind an answer (searching, reading, comparing, writing), collapsible once done. */
function Trace({ message }: { message: ChatMessage }) {
  const stages = (message.steps || []).filter(s => s.stage !== "notice");
  const notices = (message.steps || []).filter(s => s.stage === "notice");
  const live = message.status === "streaming";
  const [open, setOpen] = useState(false);
  if (!stages.length && !notices.length) return null;
  const current = live ? stages.at(-1) : undefined;
  const sources = message.sources?.length ?? 0;
  const expanded = open || (live && !message.content);
  return <div className={`trace${live ? " live" : ""}`}>
    <button type="button" className="trace-head" onClick={() => setOpen(o => !o)} aria-expanded={expanded}>
      <span className="trace-pulse" aria-hidden="true" />
      <span className="trace-title">{live && current ? current.label : `Research trace · ${stages.length} step${stages.length === 1 ? "" : "s"}`}</span>
      {!live && stages.length > 0 && <span className="badge">{sources} source{sources === 1 ? "" : "s"}</span>}
      <ChevronIcon size={14} className={`trace-chevron${expanded ? " up" : ""}`} />
    </button>
    {live && <div className="trace-bar"><span /></div>}
    {expanded && <ol className="trace-body">
      {stages.map((s, i) => <li key={s.stage}>
        <span className="trace-num">{String(i + 1).padStart(2, "0")}</span>
        <span>{s.label}{s.detail && <small>{s.detail}</small>}</span>
        <span className={`trace-state${live && i === stages.length - 1 && !message.content ? " running" : ""}`}>{live && i === stages.length - 1 && !message.content ? "…" : "✓"}</span>
      </li>)}
      {notices.map(n => <li key={n.label} className="trace-notice"><span className="trace-num">!</span><span>{n.label}</span></li>)}
    </ol>}
  </div>;
}

export function AnswerCard({ message, isLast, canRegenerate, streaming, onRegenerate, onOpenSources }: {
  message: ChatMessage; isLast: boolean; canRegenerate: boolean; streaming: boolean; onRegenerate(): void; onOpenSources(ordinal?: number): void;
}) {
  const citations = useMemo<Citations | undefined>(() => message.sources?.length ? {
    ordinals: new Set(message.sources.map(s => s.ordinal)), titles: new Map(message.sources.map(s => [s.ordinal, s.source.title])), onCite: n => onOpenSources(n)
  } : undefined, [message.sources, onOpenSources]);
  const meta = message.meta;
  const time = seconds(message.elapsedMs);
  // Cited sources first, so the chips show what the answer actually rests on.
  const grounded = [...(message.sources ?? [])].sort((a, b) => Number(b.cited) - Number(a.cited) || a.ordinal - b.ordinal);
  return <section className="answer glass">
    <header className="answer-head">
      <span className="answer-mark"><LogoIcon size={14} /></span>
      <div className="answer-who">
        <div className="answer-name">Arbor{meta && <span className="badge">{meta.providerLabel}</span>}</div>
        <span className="answer-route">{meta
          ? <>{meta.displayName} · {levelLabel[meta.reasoningLevel]}{meta.fallbackFrom.length > 0 && ` · fallback after ${meta.fallbackFrom.join(", ")}`}</>
          : message.status === "streaming" ? "Choosing a model…" : "—"}</span>
      </div>
      {time && <span className="time-pill" title={message.firstTextMs !== undefined ? `First text after ${seconds(message.firstTextMs)}` : undefined}>{time}</span>}
    </header>
    <Trace message={message} />
    <div className="answer-text md">
      {message.content ? <Markdown text={message.content} citations={citations} /> : message.status === "streaming" && !message.steps?.length && <p className="thinking">{message.thinking ? "Thinking…" : "Working…"}</p>}
      {message.status === "streaming" && message.content && <span className="caret" aria-hidden="true" />}
    </div>
    {message.status === "stopped" && <div className="msg-note">Stopped.</div>}
    {message.stop === "length" && <div className="msg-note">The response reached its length limit. Ask Arbor to continue.</div>}
    {message.stop === "filtered" && <div className="msg-note">The provider cut this response short.</div>}
    {message.status === "error" && <div className="error" role="alert">{message.error}</div>}
    {grounded.length > 0 && <div className="grounded">
      <span className="grounded-label">Grounded in</span>
      {grounded.slice(0, 5).map(s => <button key={s.ordinal} type="button" className={`ground-chip${s.cited ? "" : " uncited"}`} onClick={() => onOpenSources(s.ordinal)} title={s.source.title}>
        <span className="ground-num">{s.ordinal}</span><span className="ground-text">{s.source.sourceType === "uploaded_file"
          ? `${s.source.title}${s.locator?.page ? ` · p. ${s.locator.page}` : s.locator?.lines ? ` · L${s.locator.lines[0]}` : ""}`
          : s.source.domain === "doi.org" && s.source.publisher ? s.source.publisher : s.source.domain}</span>
      </button>)}
      {grounded.length > 5 && <button type="button" className="ground-chip" onClick={() => onOpenSources()}>+{grounded.length - 5}</button>}
    </div>}
    {message.status !== "streaming" && <div className="msg-actions">
      {message.content && <CopyButton text={message.content} />}
      {grounded.length > 0 && <button type="button" onClick={() => onOpenSources()}><LinkIcon size={13} /> Sources</button>}
      {isLast && canRegenerate && <button type="button" onClick={onRegenerate} disabled={streaming}><RefreshIcon size={13} /> Regenerate</button>}
    </div>}
  </section>;
}

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  return <button type="button" onClick={() => navigator.clipboard.writeText(text).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1500); }, () => {})}><CopyIcon size={13} /> {copied ? "Copied" : "Copy"}</button>;
}
