import React, { useCallback, useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { Markdown } from "./markdown.tsx";
import "./style.css";

type Model = { id: string; provider: string; providerLabel: string; displayName: string; modelId: string; capabilities: string[] };
type Level = "fast" | "balanced" | "deep";
type Meta = { providerLabel: string; displayName: string; modelId: string; reasoningLevel: Level; fallbackFrom: string[] };
type ChatMessage = {
  id: string; role: "user" | "assistant"; content: string;
  status?: "streaming" | "complete" | "stopped" | "error"; meta?: Meta; stop?: "length" | "filtered"; error?: string; thinking?: boolean;
};
type Summary = { id: string; title: string; updatedAt: string };
type StoredConversation = Summary & { messages: (Omit<ChatMessage, "meta"> & { meta?: Meta })[] };

const WORKSPACE = "default";
const levelLabel: Record<Level, string> = { fast: "Fast", balanced: "Balanced", deep: "Deep" };
const starters = [
  { icon: "⌕", title: "Research a topic", prompt: "Research recent approaches to ransomware defense and cite credible sources." },
  { icon: "⌘", title: "Solve a hard problem", prompt: "Explain a rigorous approach to proving a mathematical result." },
  { icon: "</>", title: "Work through code", prompt: "Help debug a React application. Ask for the relevant files first." },
  { icon: "▤", title: "Plan an assignment", prompt: "Help me break down an assignment into research, implementation, testing, and rubric review." }
];
const stored = (key: string, fallback: string) => { try { return localStorage.getItem(key) || fallback; } catch { return fallback; } };
const remember = (key: string, value: string) => { try { localStorage.setItem(key, value); } catch { /* preferences are optional */ } };

function App() {
  const [models, setModels] = useState<Model[]>([]);
  const [modelsLoaded, setModelsLoaded] = useState(false);
  const [prompt, setPrompt] = useState("");
  const [mode, setMode] = useState<Level>(() => stored("arbor.level", "balanced") as Level);
  const [choice, setChoice] = useState(() => stored("arbor.model", "auto"));
  const [conversationId, setConversationId] = useState<string | null>(null);
  const [title, setTitle] = useState("");
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [history, setHistory] = useState<Summary[]>([]);
  const [error, setError] = useState("");
  const [streaming, setStreaming] = useState(false);
  const controller = useRef<AbortController | null>(null);
  const pending = useRef("");
  const frame = useRef(0);
  const followBottom = useRef(true);
  const endRef = useRef<HTMLDivElement>(null);

  const loadHistory = useCallback(() => {
    fetch(`/api/conversations?workspaceId=${WORKSPACE}`).then(r => r.ok ? r.json() : []).then(setHistory).catch(() => {});
  }, []);
  useEffect(() => {
    fetch("/api/models").then(r => r.json()).then((list: Model[]) => {
      setModels(list);
      setModelsLoaded(true);
      // A remembered model may no longer be configured on the server.
      setChoice(current => current === "auto" || list.some(m => m.id === current) ? current : "auto");
    }).catch(() => setError("Can't reach the Arbor server. Start it with npm run dev."));
    loadHistory();
  }, [loadHistory]);
  useEffect(() => remember("arbor.level", mode), [mode]);
  useEffect(() => remember("arbor.model", choice), [choice]);
  useEffect(() => {
    const onScroll = () => { followBottom.current = window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - 160; };
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);
  useEffect(() => { if (followBottom.current) endRef.current?.scrollIntoView({ block: "end" }); }, [messages]);

  const updateLast = (change: (m: ChatMessage) => ChatMessage) => setMessages(prior => prior.map((m, i) => i === prior.length - 1 ? change(m) : m));
  /** Deltas are batched per animation frame so long answers don't re-render on every token. */
  const flush = () => {
    frame.current = 0;
    const text = pending.current;
    pending.current = "";
    if (text) updateLast(m => ({ ...m, content: m.content + text, thinking: false }));
  };

  async function send(options: { regenerate?: boolean } = {}) {
    const text = prompt.trim();
    if (streaming || (!options.regenerate && !text)) return;
    setError("");
    followBottom.current = true;
    const placeholder: ChatMessage = { id: `pending-${Date.now()}`, role: "assistant", content: "", status: "streaming" };
    if (options.regenerate) {
      setMessages(prior => { const kept = [...prior]; while (kept.at(-1)?.role === "assistant") kept.pop(); return [...kept, placeholder]; });
    } else {
      setMessages(prior => [...prior, { id: `user-${Date.now()}`, role: "user", content: text }, placeholder]);
      setPrompt("");
    }
    const abort = new AbortController();
    controller.current = abort;
    setStreaming(true);
    try {
      const response = await fetch("/api/chat", {
        method: "POST", headers: { "content-type": "application/json" }, signal: abort.signal,
        body: JSON.stringify({ conversationId: conversationId || undefined, workspaceId: WORKSPACE, message: options.regenerate ? undefined : text, regenerate: options.regenerate || undefined, selectedModel: choice, reasoningLevel: mode })
      });
      if (!response.ok || !response.body) {
        const data = await response.json().catch(() => ({}));
        updateLast(m => ({ ...m, status: "error", error: data.error || "The request failed." }));
        return;
      }
      const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
      let buffer = "";
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += value;
        const lines = buffer.split("\n");
        buffer = lines.pop() || "";
        for (const line of lines.filter(Boolean)) {
          const event = JSON.parse(line);
          if (event.type === "conversation") { setConversationId(event.conversation.id); setTitle(event.conversation.title); }
          if (event.type === "model") updateLast(m => ({ ...m, id: event.messageId, meta: { providerLabel: event.model.providerLabel, displayName: event.model.displayName, modelId: event.model.modelId, reasoningLevel: event.reasoningLevel, fallbackFrom: event.fallbackFrom } }));
          if (event.type === "thinking") updateLast(m => ({ ...m, thinking: true }));
          if (event.type === "delta") { pending.current += event.text; frame.current ||= requestAnimationFrame(flush); }
          if (event.type === "done" || event.type === "stopped" || event.type === "error") {
            cancelAnimationFrame(frame.current); flush();
            updateLast(m => ({ ...m, thinking: false, status: event.type === "done" ? "complete" : event.type, stop: event.stop, error: event.message }));
          }
        }
      }
    } catch {
      cancelAnimationFrame(frame.current); flush();
      if (abort.signal.aborted) updateLast(m => ({ ...m, thinking: false, status: "stopped" }));
      else updateLast(m => ({ ...m, thinking: false, status: "error", error: "Lost the connection to the Arbor server." }));
    } finally {
      // A stream that ends without a final event (e.g. the server restarted) must not stay "streaming".
      updateLast(m => m.status === "streaming" ? { ...m, status: "error", thinking: false, error: m.error || "The response ended unexpectedly." } : m);
      controller.current = null;
      setStreaming(false);
      loadHistory();
    }
  }
  function stop() { controller.current?.abort(); }
  function newConversation() {
    if (streaming) return;
    setConversationId(null); setTitle(""); setMessages([]); setPrompt(""); setError("");
  }
  async function open(id: string) {
    if (streaming || id === conversationId) return;
    const response = await fetch(`/api/conversations/${id}`).catch(() => undefined);
    if (!response?.ok) { setError("Couldn't open that conversation."); return; }
    const conversation: StoredConversation = await response.json();
    setConversationId(conversation.id); setTitle(conversation.title); setMessages(conversation.messages); setError("");
    followBottom.current = true;
  }
  const lastAssistant = messages.findLastIndex(m => m.role === "assistant");
  const groups = [...new Set(models.map(m => m.providerLabel))];

  return <div className="shell">
    <aside className="sidebar">
      <div className="brand"><span className="brandmark">✳</span><span>arbor<span className="branddot">.</span></span></div>
      <button className="new-task" onClick={newConversation} disabled={streaming}>＋ <span>New conversation</span></button>
      <div className="nav-label">WORKSPACE</div>
      <div className="nav-item active">◈ <span>Ask Arbor</span></div>
      <div className="nav-item muted">▦ <span>Assignments <small>soon</small></span></div>
      <div className="nav-item muted">⌘ <span>Code workspace <small>soon</small></span></div>
      <div className="nav-item muted">◉ <span>Browser agent <small>soon</small></span></div>
      {history.length > 0 && <>
        <div className="nav-label">RECENT</div>
        <nav className="history">{history.slice(0, 30).map(c => <button key={c.id} className={`history-item${c.id === conversationId ? " current" : ""}`} onClick={() => open(c.id)} disabled={streaming} title={c.title}>{c.title}</button>)}</nav>
      </>}
      <div className="sidebar-bottom"><div className="status-dot" /> Local workspace <span className="version">v0.1</span></div>
    </aside>
    <main className="main">
      <header><span className="header-title">{title || "AI workspace"}</span><div className="header-right"><span className="model-count">{models.length} active models</span><span className="avatar">A</span></div></header>
      <div className="content">
        {!messages.length && <><div className="eyebrow">RESEARCH · REASON · BUILD</div><h1>One workspace for<br/><em>everything you’re working on.</em></h1><p className="lede">Ask a question, untangle a tough problem, or start a project. Arbor picks the right model for the work.</p>
          <div className="cards">{starters.map(s => <button key={s.title} className="card" onClick={() => setPrompt(s.prompt)}><span className="card-icon">{s.icon}</span><strong>{s.title}</strong><span className="arrow">↗</span></button>)}</div></>}
        {messages.length > 0 && <div className="thread" aria-live="polite">
          {messages.map((m, i) => m.role === "user"
            ? <div key={m.id} className="msg-user">{m.content}</div>
            : <section key={m.id} className="answer">
              <div className="answer-heading"><span className="answer-icon">✳</span><div><strong>Arbor</strong>
                {m.meta && <small title={`${m.meta.displayName} · ${m.meta.modelId}${m.meta.fallbackFrom.length ? ` · used after ${m.meta.fallbackFrom.join(", ")} failed` : ""}`}>{m.meta.providerLabel} • {levelLabel[m.meta.reasoningLevel]}{m.meta.fallbackFrom.length > 0 && " · fallback"}</small>}
              </div></div>
              <div className="answer-text md">
                {m.content ? <Markdown text={m.content} /> : m.status === "streaming" && <p className="thinking">{m.thinking ? "Thinking…" : "Working…"}</p>}
                {m.status === "streaming" && m.content && <span className="caret" aria-hidden="true" />}
              </div>
              {m.status === "stopped" && <div className="msg-note">Stopped.</div>}
              {m.stop === "length" && <div className="msg-note">The response reached its length limit. Ask Arbor to continue.</div>}
              {m.stop === "filtered" && <div className="msg-note">The provider cut this response short.</div>}
              {m.status === "error" && <div className="error" role="alert">{m.error}</div>}
              {m.status !== "streaming" && <div className="msg-actions">
                {m.content && <CopyButton text={m.content} />}
                {i === lastAssistant && conversationId && <button type="button" onClick={() => send({ regenerate: true })} disabled={streaming || !models.length}>↻ Regenerate</button>}
              </div>}
            </section>)}
          <div ref={endRef} />
        </div>}
        {error && <div className="error" role="alert">{error}</div>}
        {modelsLoaded && !models.length && <div className="setup-note">No models are configured yet. Add a provider API key and model ID to <code>.env</code> on the server, then restart it.</div>}
        <div className={messages.length ? "composer-dock" : undefined}>
          <div className="composer"><textarea value={prompt} onChange={e => setPrompt(e.target.value)}
            onKeyDown={e => { if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); send(); } }}
            placeholder={messages.length ? "Ask a follow-up…" : "Ask anything, or describe what you want to build..."} />
            <div className="composer-footer"><div className="selectors">
              <label>Model <select value={choice} onChange={e => setChoice(e.target.value)}><option value="auto">Auto</option>
                {groups.map(g => <optgroup key={g} label={g}>{models.filter(m => m.providerLabel === g).map(m => <option key={m.id} value={m.id}>{m.displayName} ({m.modelId})</option>)}</optgroup>)}
              </select></label>
              <label>Reasoning <select value={mode} onChange={e => setMode(e.target.value as Level)}><option value="fast">Fast</option><option value="balanced">Balanced</option><option value="deep">Deep</option></select></label>
            </div>
            {streaming
              ? <button className="send stop" onClick={stop}>■ Stop</button>
              : <button className="send" disabled={!prompt.trim() || !models.length} onClick={() => send()}>Send ↗</button>}
            </div></div>
          <div className="hint">Enter to send · Shift + Enter for a new line · Provider routing happens on the server</div>
        </div>
      </div>
    </main>
  </div>;
}
function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  return <button type="button" onClick={() => navigator.clipboard.writeText(text).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1500); }, () => {})}>{copied ? "✓ Copied" : "⧉ Copy"}</button>;
}
createRoot(document.getElementById("root")!).render(<React.StrictMode><App /></React.StrictMode>);
