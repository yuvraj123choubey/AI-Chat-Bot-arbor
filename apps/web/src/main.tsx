import React, { useCallback, useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { api, ndjsonEvents, WORKSPACE, type ChatMessage, type Level, type Model, type SearchMode, type Summary } from "./api.ts";
import { AnswerCard } from "./components/Answer.tsx";
import { Background } from "./components/Background.tsx";
import { Composer } from "./components/Composer.tsx";
import { DeepResearch } from "./components/DeepResearch.tsx";
import { BookIcon, ChatIcon, CodeIcon, CompassIcon, GridIcon, LogoIcon, MenuIcon, PlusIcon, SearchIcon, SparkIcon } from "./components/Icons.tsx";
import { SourceLibrary, SourcesPanel } from "./components/Sources.tsx";
import "./style.css";

type View = "chat" | "research" | "sources";
const VERSION = "v0.3";
const stored = (key: string, fallback: string) => { try { return localStorage.getItem(key) || fallback; } catch { return fallback; } };
const remember = (key: string, value: string) => { try { localStorage.setItem(key, value); } catch { /* preferences are optional */ } };
const searchWord: Record<SearchMode, string> = { auto: "auto", on: "always", off: "off" };

function App() {
  const [view, setView] = useState<View>("chat");
  const [drawer, setDrawer] = useState(false);
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
  const [lastReplyMs, setLastReplyMs] = useState<number | undefined>();
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
    }).catch(() => { setModelsLoaded(true); setError("Can't reach the Arbor server. Start it with npm run dev."); });
    loadHistory();
  }, [loadHistory]);
  useEffect(() => remember("arbor.level", mode), [mode]);
  useEffect(() => remember("arbor.model", choice), [choice]);
  useEffect(() => remember("arbor.search", searchMode), [searchMode]);
  useEffect(() => {
    const onScroll = () => { followBottom.current = window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - 220; };
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);
  useEffect(() => { if (followBottom.current) endRef.current?.scrollIntoView({ block: "end" }); }, [messages]);
  useEffect(() => {
    if (!drawer) return;
    const key = (e: KeyboardEvent) => { if (e.key === "Escape") setDrawer(false); };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [drawer]);

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
    const started = performance.now();
    let sawText = false;
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
          case "delta":
            if (!sawText) { sawText = true; const ms = performance.now() - started; updateLast(m => ({ ...m, firstTextMs: ms })); }
            pending.current += event.text; frame.current ||= requestAnimationFrame(flush); break;
          case "done": case "stopped": case "error": {
            cancelAnimationFrame(frame.current); flush();
            const elapsedMs = performance.now() - started;
            if (event.type === "done") setLastReplyMs(elapsedMs);
            updateLast(m => ({
              ...m, thinking: false, status: event.type === "done" ? "complete" : event.type, stop: event.stop, error: event.message, elapsedMs,
              // The backend removes citations to sources it did not supply; adopt its cleaned text.
              ...(typeof event.content === "string" ? { content: event.content } : {}),
              ...(event.cited && m.sources ? { sources: m.sources.map(s => ({ ...s, cited: event.cited.includes(s.ordinal) })) } : {})
            }));
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
  function go(next: View) { setView(next); setPanel(null); setDrawer(false); }
  function newConversation() {
    if (streaming) return;
    go("chat");
    setConversationId(null); setTitle(""); setMessages([]); setPrompt(""); setError("");
  }
  async function open(id: string) {
    if (streaming) return;
    go("chat");
    if (id === conversationId) return;
    try {
      const conversation = await api.conversation(id);
      setConversationId(conversation.id); setTitle(conversation.title); setMessages(conversation.messages); setError("");
      followBottom.current = true;
    } catch { setError("Couldn't open that conversation."); }
  }
  const openSources = useCallback((messageId: string, ordinal?: number) => setPanel({ messageId, ordinal }), []);
  const lastAssistant = messages.findLastIndex(m => m.role === "assistant");
  const panelMessage = panel ? messages.find(m => m.id === panel.messageId) : undefined;
  const panelOpen = (view === "chat" && Boolean(panelMessage?.sources?.length)) || (view === "research" && researchPanel);
  const providerNames = [...new Set(models.map(m => m.providerLabel))];
  const status = !modelsLoaded ? "Connecting…" : models.length ? `${providerNames.join(" + ")} · ${models.length} model${models.length === 1 ? "" : "s"} ready` : "No model connected";
  const starters = [
    { icon: <SearchIcon size={16} />, badge: "Cited", title: "Research a topic", note: "Plans, searches and writes a cited report", run: () => go("research") },
    { icon: <CodeIcon size={16} />, badge: "Code", title: "Work through code", note: "Debug, explain or review code", run: () => setPrompt("Help me debug this code. Here's what it should do and what happens instead:\n\n") },
    { icon: <SparkIcon size={16} />, badge: "Deep", title: "Solve hard logic", note: "Step-by-step reasoning", run: () => { setMode("deep"); setPrompt("Work through this problem step by step: "); } },
    { icon: <GridIcon size={16} />, badge: "Plan", title: "Plan an assignment", note: "Break work into steps", run: () => setPrompt("Help me break this assignment into research, writing, testing and a final check against the rubric: ") }
  ];

  return <div className={`app${panelOpen ? " with-panel" : ""}${view === "chat" ? " has-dock" : ""}`}>
    <Background />
    <header className="topbar">
      <button type="button" className="icon-button menu-toggle" onClick={() => setDrawer(d => !d)} aria-label="Menu" aria-expanded={drawer}><MenuIcon size={17} /></button>
      <button type="button" className="brand" onClick={newConversation} aria-label="Arbor home">
        <span className="logo"><LogoIcon size={16} /><span className="logo-dot" /></span>
        <span className="brand-text">
          <span className="brand-line"><span className="brand-name">Arbor<span>.OS</span></span><span className="tag">{VERSION}</span></span>
          <span className={`status-line${models.length ? "" : " warn"}`}><span className="dot" />{status}</span>
        </span>
      </button>
      <div className="topbar-right">
        <button type="button" className="pill-button" onClick={newConversation} disabled={streaming}><PlusIcon size={13} /> New</button>
        <span className="avatar" aria-hidden="true">A<span className="avatar-dot" /></span>
      </div>
    </header>

    <div className="layout">
      <aside className={`sidebar${drawer ? " open" : ""}`} aria-label="Navigation">
        <div className="nav-label">Workspace</div>
        <button type="button" className={`nav-item${view === "chat" ? " active" : ""}`} onClick={() => go("chat")}><ChatIcon size={15} /> Ask Arbor</button>
        <button type="button" className={`nav-item${view === "research" ? " active" : ""}`} onClick={() => go("research")} disabled={streaming}><CompassIcon size={15} /> Deep research</button>
        <button type="button" className={`nav-item${view === "sources" ? " active" : ""}`} onClick={() => go("sources")} disabled={streaming}><BookIcon size={15} /> Sources</button>
        <div className="nav-item muted"><GridIcon size={15} /> Assignments <small>soon</small></div>
        <div className="nav-item muted"><CodeIcon size={15} /> Code workspace <small>soon</small></div>
        {history.length > 0 && <>
          <div className="nav-label">Recent</div>
          <nav className="history">{history.slice(0, 30).map(c => <button key={c.id} className={`history-item${c.id === conversationId && view === "chat" ? " current" : ""}`} onClick={() => open(c.id)} disabled={streaming} title={c.title}>{c.title}</button>)}</nav>
        </>}
        <div className="sidebar-foot"><span className="dot" /> Local workspace · data stays on this machine</div>
      </aside>
      {drawer && <div className="drawer-scrim" onClick={() => setDrawer(false)} aria-hidden="true" />}

      <main className="main">
        {view === "sources" ? <SourceLibrary /> : view === "research" ? <DeepResearch models={models} onPanelChange={setResearchPanel} /> : <>
          {!messages.length && <>
            <section className="hero">
              <div className="hero-meta">
                <span className="eyebrow-pill"><span className="dot" />Workspace // Ask Arbor</span>
                <span className="mono-note">Search · {searchWord[searchMode]}{lastReplyMs !== undefined && ` · last reply ${(lastReplyMs / 1000).toFixed(1)}s`}</span>
              </div>
              <h1>Orchestrate intelligence.<br /><span className="gradient-text">Research, reason and build in one place.</span></h1>
              <p className="lede">Ask anything. When a question depends on facts, Arbor searches real sources first and cites them, and it runs on a free model on your own machine.</p>
            </section>
            <section className="carousel" aria-label="Ways to start">
              {starters.map(s => <button key={s.title} type="button" className="mode-card glass" onClick={s.run}>
                <span className="mode-top"><span className="mode-icon">{s.icon}</span><span className="tag">{s.badge}</span></span>
                <strong>{s.title}</strong><small>{s.note}</small>
              </button>)}
            </section>
          </>}
          {messages.length > 0 && <div className="thread" aria-live="polite">
            {title && <div className="thread-title">{title}</div>}
            {messages.map((m, i) => m.role === "user"
              ? <div key={m.id} className="msg-user">{m.content}</div>
              : <AnswerCard key={m.id} message={m} isLast={i === lastAssistant} canRegenerate={Boolean(conversationId) && models.length > 0} streaming={streaming}
                  onRegenerate={() => send({ regenerate: true })} onOpenSources={ordinal => openSources(m.id, ordinal)} />)}
            <div ref={endRef} />
          </div>}
          {error && <div className="error" role="alert">{error}</div>}
          {modelsLoaded && !models.length && !error && <div className="setup-note">No model is connected. Start the local model with <code>npm run dev</code>, or add a provider key and model ID to <code>.env</code>.</div>}
        </>}
      </main>
    </div>

    {view === "chat" && <div className="dock">
      <Composer value={prompt} onChange={setPrompt} onSend={() => send()} onStop={stop} streaming={streaming} disabled={!models.length}
        placeholder={messages.length ? "Ask a follow-up…" : "Ask anything, untangle a problem, or start a project…"}
        models={models} choice={choice} onChoice={setChoice} level={mode} onLevel={setMode} search={searchMode} onSearch={setSearchMode} onDeepResearch={() => go("research")} />
      <div className="hint">Enter to send · Shift + Enter for a new line</div>
    </div>}
    {view === "chat" && panelMessage?.sources?.length ? <SourcesPanel sources={panelMessage.sources} active={panel?.ordinal} onClose={() => setPanel(null)} /> : null}
  </div>;
}
createRoot(document.getElementById("root")!).render(<React.StrictMode><App /></React.StrictMode>);
