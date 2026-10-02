import React, { useCallback, useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { api, ndjsonEvents, WORKSPACE, type ChatMessage, type Level, type Model, type SearchMode, type Summary } from "./api.ts";
import { AnswerCard } from "./components/Answer.tsx";
import { SourceLibrary, SourcesPanel } from "./components/Sources.tsx";
import { DeepResearch } from "./components/DeepResearch.tsx";
import "./style.css";

type View = "chat" | "research" | "sources";
const starters = [
  { icon: "⌕", title: "Research a topic", prompt: "Research recent approaches to ransomware defense and cite credible sources." },
  { icon: "⌘", title: "Solve a hard problem", prompt: "Explain a rigorous approach to proving a mathematical result." },
  { icon: "</>", title: "Work through code", prompt: "Help debug a React application. Ask for the relevant files first." },
  { icon: "▤", title: "Plan an assignment", prompt: "Help me break down an assignment into research, implementation, testing, and rubric review." }
];
const stored = (key: string, fallback: string) => { try { return localStorage.getItem(key) || fallback; } catch { return fallback; } };
const remember = (key: string, value: string) => { try { localStorage.setItem(key, value); } catch { /* preferences are optional */ } };

function App() {
  const [view, setView] = useState<View>("chat");
  const [models, setModels] = useState<Model[]>([]);
  const [modelsLoaded, setModelsLoaded] = useState(false);
  const [prompt, setPrompt] = useState("");
  const [mode, setMode] = useState<Level>(() => stored("arbor.level", "balanced") as Level);
  const [choice, setChoice] = useState(() => stored("arbor.model", "auto"));
  const [searchMode, setSearchMode] = useState<SearchMode>(() => stored("arbor.search", "auto") as SearchMode);
  const [conversationId, setConversationId] = useState<string | null>(null);
  const [title, setTitle] = useState("");
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [history, setHistory] = useState<Summary[]>([]);
  const [error, setError] = useState("");
  const [streaming, setStreaming] = useState(false);
  const [panel, setPanel] = useState<{ messageId: string; ordinal?: number } | null>(null);
  const [researchPanel, setResearchPanel] = useState(false);
  const controller = useRef<AbortController | null>(null);
  const pending = useRef("");
  const frame = useRef(0);
  const followBottom = useRef(true);
  const endRef = useRef<HTMLDivElement>(null);

  const loadHistory = useCallback(() => { api.conversations().then(setHistory).catch(() => {}); }, []);
  useEffect(() => {
    api.models().then(list => {
      setModels(list);
      setModelsLoaded(true);
      // A remembered model may no longer be configured on the server.
      setChoice(current => current === "auto" || list.some(m => m.id === current) ? current : "auto");
    }).catch(() => setError("Can't reach the Arbor server. Start it with npm run dev."));
    loadHistory();
  }, [loadHistory]);
  useEffect(() => remember("arbor.level", mode), [mode]);
  useEffect(() => remember("arbor.model", choice), [choice]);
  useEffect(() => remember("arbor.search", searchMode), [searchMode]);
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
    setPanel(null);
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
        body: JSON.stringify({ conversationId: conversationId || undefined, workspaceId: WORKSPACE, message: options.regenerate ? undefined : text, regenerate: options.regenerate || undefined, selectedModel: choice, reasoningLevel: mode, searchMode })
      });
      if (!response.ok || !response.body) {
        const data = await response.json().catch(() => ({}));
        updateLast(m => ({ ...m, status: "error", error: data.error || "The request failed." }));
        return;
      }
      for await (const event of ndjsonEvents(response)) {
        switch (event.type) {
          case "conversation": setConversationId(event.conversation.id); setTitle(event.conversation.title); updateLast(m => ({ ...m, id: event.messageId })); break;
          case "status": updateLast(m => ({ ...m, steps: [...(m.steps || []).filter(s => s.stage !== event.stage), { stage: event.stage, label: event.label, detail: event.detail }] })); break;
          case "notice": updateLast(m => ({ ...m, steps: [...(m.steps || []), { stage: "notice", label: event.message }] })); break;
          case "sources": updateLast(m => ({ ...m, sources: event.sources })); break;
          case "model": updateLast(m => ({ ...m, meta: { providerLabel: event.model.providerLabel, displayName: event.model.displayName, modelId: event.model.modelId, reasoningLevel: event.reasoningLevel, fallbackFrom: event.fallbackFrom } })); break;
          case "thinking": updateLast(m => ({ ...m, thinking: true })); break;
          // The server discarded an unverified draft and is searching first; the searched answer replaces it.
          case "reset": cancelAnimationFrame(frame.current); frame.current = 0; pending.current = ""; updateLast(m => ({ ...m, content: "", thinking: false })); break;
          case "delta": pending.current += event.text; frame.current ||= requestAnimationFrame(flush); break;
          case "done": case "stopped": case "error":
            cancelAnimationFrame(frame.current); flush();
            updateLast(m => ({
              ...m, thinking: false, status: event.type === "done" ? "complete" : event.type, stop: event.stop, error: event.message,
              // The backend removes citations to sources it did not supply; adopt its cleaned text.
              ...(typeof event.content === "string" ? { content: event.content } : {}),
              ...(event.cited && m.sources ? { sources: m.sources.map(s => ({ ...s, cited: event.cited.includes(s.ordinal) })) } : {})
            }));
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
    setView("chat"); setPanel(null);
    setConversationId(null); setTitle(""); setMessages([]); setPrompt(""); setError("");
  }
  async function open(id: string) {
    if (streaming) return;
    setView("chat"); setPanel(null);
    if (id === conversationId) return;
    try {
      const conversation = await api.conversation(id);
      setConversationId(conversation.id); setTitle(conversation.title); setMessages(conversation.messages); setError("");
      followBottom.current = true;
    } catch { setError("Couldn't open that conversation."); }
  }
  const openSources = useCallback((messageId: string, ordinal?: number) => setPanel({ messageId, ordinal }), []);
  const lastAssistant = messages.findLastIndex(m => m.role === "assistant");
  const groups = [...new Set(models.map(m => m.providerLabel))];
  const panelMessage = panel ? messages.find(m => m.id === panel.messageId) : undefined;

  return <div className={`shell${(view === "chat" && panelMessage?.sources?.length) || (view === "research" && researchPanel) ? " with-panel" : ""}`}>
    <aside className="sidebar">
      <div className="brand"><span className="brandmark">✳</span><span>arbor<span className="branddot">.</span></span></div>
      <button className="new-task" onClick={newConversation} disabled={streaming}>＋ <span>New conversation</span></button>
      <div className="nav-label">WORKSPACE</div>
      <button type="button" className={`nav-item${view === "chat" ? " active" : ""}`} onClick={() => setView("chat")}>◈ <span>Ask Arbor</span></button>
      <button type="button" className={`nav-item${view === "research" ? " active" : ""}`} onClick={() => { setView("research"); setPanel(null); }} disabled={streaming}>◎ <span>Deep research</span></button>
      <button type="button" className={`nav-item${view === "sources" ? " active" : ""}`} onClick={() => { setView("sources"); setPanel(null); }} disabled={streaming}>⌕ <span>Sources</span></button>
      <div className="nav-item muted">▦ <span>Assignments <small>soon</small></span></div>
      <div className="nav-item muted">⌘ <span>Code workspace <small>soon</small></span></div>
      <div className="nav-item muted">◉ <span>Browser agent <small>soon</small></span></div>
      {history.length > 0 && <>
        <div className="nav-label">RECENT</div>
        <nav className="history">{history.slice(0, 30).map(c => <button key={c.id} className={`history-item${c.id === conversationId && view === "chat" ? " current" : ""}`} onClick={() => open(c.id)} disabled={streaming} title={c.title}>{c.title}</button>)}</nav>
      </>}
      <div className="sidebar-bottom"><div className="status-dot" /> Local workspace <span className="version">v0.2</span></div>
    </aside>
    <main className="main">
      <header><span className="header-title">{view === "sources" ? "Sources" : view === "research" ? "Deep research" : title || "AI workspace"}</span><div className="header-right"><span className="model-count">{models.length} active models</span><span className="avatar">A</span></div></header>
      {view === "sources" ? <div className="content"><SourceLibrary /></div> : view === "research" ? <div className="content"><DeepResearch models={models} onPanelChange={setResearchPanel} /></div> : <div className="content">
        {!messages.length && <><div className="eyebrow">RESEARCH · REASON · BUILD</div><h1>One workspace for<br/><em>everything you’re working on.</em></h1><p className="lede">Ask a question, untangle a tough problem, or start a project. Arbor picks the right model for the work.</p>
          <div className="cards">{starters.map(s => <button key={s.title} className="card" onClick={() => setPrompt(s.prompt)}><span className="card-icon">{s.icon}</span><strong>{s.title}</strong><span className="arrow">↗</span></button>)}</div></>}
        {messages.length > 0 && <div className="thread" aria-live="polite">
          {messages.map((m, i) => m.role === "user"
            ? <div key={m.id} className="msg-user">{m.content}</div>
            : <AnswerCard key={m.id} message={m} isLast={i === lastAssistant} canRegenerate={Boolean(conversationId) && models.length > 0} streaming={streaming}
                onRegenerate={() => send({ regenerate: true })} onOpenSources={ordinal => openSources(m.id, ordinal)} />)}
          <div ref={endRef} />
        </div>}
        {error && <div className="error" role="alert">{error}</div>}
        {modelsLoaded && !models.length && <div className="setup-note">No models are configured yet. Add a provider API key and model ID to <code>.env</code> on the server; the API picks it up automatically.</div>}
        <div className={messages.length ? "composer-dock" : undefined}>
          <div className="composer"><textarea value={prompt} onChange={e => setPrompt(e.target.value)} aria-label="Message"
            onKeyDown={e => { if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); send(); } }}
            placeholder={messages.length ? "Ask a follow-up…" : "Ask anything, or describe what you want to build..."} />
            <div className="composer-footer"><div className="selectors">
              <label>Model <select value={choice} onChange={e => setChoice(e.target.value)}><option value="auto">Auto</option>
                {groups.map(g => <optgroup key={g} label={g}>{models.filter(m => m.providerLabel === g).map(m => <option key={m.id} value={m.id}>{m.displayName} ({m.modelId})</option>)}</optgroup>)}
              </select></label>
              <label>Reasoning <select value={mode} onChange={e => setMode(e.target.value as Level)}><option value="fast">Fast</option><option value="balanced">Balanced</option><option value="deep">Deep</option></select></label>
              <label>Search <select value={searchMode} onChange={e => setSearchMode(e.target.value as SearchMode)}><option value="auto">Auto</option><option value="on">Always</option><option value="off">Off</option></select></label>
            </div>
            {streaming
              ? <button className="send stop" onClick={stop}>■ Stop</button>
              : <button className="send" disabled={!prompt.trim() || !models.length} onClick={() => send()}>Send ↗</button>}
            </div></div>
          <div className="hint">Enter to send · Shift + Enter for a new line · Provider routing happens on the server</div>
        </div>
      </div>}
    </main>
    {view === "chat" && panelMessage?.sources?.length ? <SourcesPanel sources={panelMessage.sources} active={panel?.ordinal} onClose={() => setPanel(null)} /> : null}
  </div>;
}
createRoot(document.getElementById("root")!).render(<React.StrictMode><App /></React.StrictMode>);
