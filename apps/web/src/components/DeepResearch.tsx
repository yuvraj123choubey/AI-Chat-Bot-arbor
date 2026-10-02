import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, formatDate, ndjsonEvents, type Model, type ResearchDetail, type ResearchSummary, type TaskStep } from "../api.ts";
import { Markdown, type Citations } from "../markdown.tsx";
import { SourcesPanel } from "./Sources.tsx";

const statusLabel: Record<string, string> = { planning: "Planning", running: "Researching", completed: "Complete", failed: "Failed", cancelled: "Cancelled" };
const active = (status: string) => status === "planning" || status === "running";

/** Deep research: start a project, follow its live progress, and read the cited report. */
export function DeepResearch({ models, onPanelChange }: { models: Model[]; onPanelChange(open: boolean): void }) {
  const [list, setList] = useState<ResearchSummary[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [question, setQuestion] = useState("");
  const [choice, setChoice] = useState("auto");
  const [error, setError] = useState("");
  const [starting, setStarting] = useState(false);
  const refresh = useCallback(() => api.researchList().then(setList).catch(() => {}), []);
  useEffect(() => { void refresh(); }, [refresh]);

  async function start() {
    if (question.trim().length < 5 || starting) return;
    setStarting(true); setError("");
    try {
      const { researchId } = await api.startResearch(question.trim(), choice);
      setQuestion("");
      await refresh();
      setSelected(researchId);
    } catch (e) { setError(e instanceof Error ? e.message : "Could not start research."); }
    finally { setStarting(false); }
  }

  if (selected) return <ResearchView id={selected} onBack={() => { setSelected(null); onPanelChange(false); void refresh(); }} onPanelChange={onPanelChange} />;
  return <section className="research-home">
    <div className="eyebrow">DEEP RESEARCH</div>
    <h2>Research a question in depth</h2>
    <p className="lede">Arbor plans the research, searches several times, reads the sources, notes what each one supports, looks for gaps and disagreements, and writes a cited report. It takes a few minutes.</p>
    <div className="composer research-composer">
      <textarea value={question} onChange={e => setQuestion(e.target.value)} placeholder="What do you want researched? e.g. How effective are offline backups against ransomware?" aria-label="Research question"
        onKeyDown={e => { if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) { e.preventDefault(); void start(); } }} />
      <div className="composer-footer"><div className="selectors">
        <label>Model <select value={choice} onChange={e => setChoice(e.target.value)}><option value="auto">Auto</option>{models.map(m => <option key={m.id} value={m.id}>{m.displayName} ({m.modelId})</option>)}</select></label>
      </div><button className="send" disabled={question.trim().length < 5 || starting || !models.length} onClick={start}>{starting ? "Starting…" : "Start research ↗"}</button></div>
    </div>
    {error && <div className="error" role="alert">{error}</div>}
    {list.length > 0 && <>
      <div className="nav-label research-list-label">PAST RESEARCH</div>
      <div className="research-list">{list.map(r => <button key={r.id} type="button" className="research-item" onClick={() => setSelected(r.id)}>
        <span className="research-item-q">{r.question}</span>
        <span className={`research-badge ${r.status}`}>{statusLabel[r.status] ?? r.status}</span>
        <small>{formatDate(r.createdAt)}</small>
      </button>)}</div>
    </>}
  </section>;
}

function ResearchView({ id, onBack, onPanelChange }: { id: string; onBack(): void; onPanelChange(open: boolean): void }) {
  const [detail, setDetail] = useState<ResearchDetail | null>(null);
  const [steps, setSteps] = useState<TaskStep[]>([]);
  const [progress, setProgress] = useState<{ label: string; detail?: string } | null>(null);
  const [panel, setPanel] = useState<number | undefined | null>(null);
  const [error, setError] = useState("");
  const reload = useRef<() => void>(() => {});

  const load = useCallback(async () => {
    try { const d = await api.research(id); setDetail(d); setSteps(d.steps); return d; }
    catch (e) { setError(e instanceof Error ? e.message : "Could not load research."); return null; }
  }, [id]);
  reload.current = () => { void load(); };

  // Follow the task's live events while it runs; plan, sources and notes trigger a (debounced) reload.
  useEffect(() => {
    let cancelled = false;
    const abort = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const soon = () => { clearTimeout(timer); timer = setTimeout(() => reload.current(), 400); };
    (async () => {
      const d = await load();
      if (!d?.taskId || !active(d.status) || cancelled) return;
      try {
        const response = await api.taskEvents(d.taskId, abort.signal);
        for await (const event of ndjsonEvents(response)) {
          if (event.type === "snapshot") setSteps(event.steps);
          if (event.type === "step") setSteps(prior => [...prior.filter(s => s.id !== event.step.id), event.step].sort((a, b) => a.ordinal - b.ordinal));
          if (event.type === "progress") setProgress({ label: event.label, detail: event.detail });
          if (["plan", "sources", "notes", "report"].includes(event.type)) soon();
          if (event.type === "status" && !active(event.status) && event.status !== "running") { setProgress(null); soon(); }
        }
      } catch { /* stream closed: the final reload shows the end state */ }
      if (!cancelled) reload.current();
    })();
    return () => { cancelled = true; abort.abort(); clearTimeout(timer); };
  }, [load]);

  useEffect(() => onPanelChange(panel !== null), [panel, onPanelChange]);
  const citations = useMemo<Citations | undefined>(() => detail?.sources.length ? {
    ordinals: new Set(detail.sources.map(s => s.ordinal)), titles: new Map(detail.sources.map(s => [s.ordinal, s.source.title])), onCite: n => setPanel(n)
  } : undefined, [detail?.sources]);

  if (!detail) return <section className="research-view">{error ? <div className="error" role="alert">{error}</div> : <p className="thinking">Loading…</p>}</section>;
  const running = active(detail.status);
  return <section className="research-view">
    <button type="button" className="back-link" onClick={onBack}>← All research</button>
    <div className="research-head">
      <h2>{detail.question}</h2>
      <div className="research-head-meta"><span className={`research-badge ${detail.status}`}>{statusLabel[detail.status] ?? detail.status}</span><small>{formatDate(detail.createdAt)} · {detail.sources.length} sources · {detail.notes.length} notes</small></div>
      <div className="research-actions">
        {running && detail.taskId && <button type="button" onClick={() => api.cancelTask(detail.taskId!).then(() => reload.current(), () => {})}>■ Cancel</button>}
        {!running && <button type="button" onClick={() => { if (confirm("Delete this research project?")) void api.deleteResearch(detail.id).then(onBack, () => {}); }}>Delete</button>}
        {detail.sources.length > 0 && <button type="button" onClick={() => setPanel(undefined)}>⌕ Sources ({detail.sources.length})</button>}
      </div>
    </div>
    {detail.error && detail.status !== "completed" && <div className="error" role="alert">{detail.error}</div>}

    {(running || !detail.report) && <ol className="task-steps" aria-live="polite">
      {steps.map(s => <li key={s.id} className={s.status}><span className="step-mark" aria-hidden="true">{s.status === "completed" ? "✓" : s.status === "running" ? "◌" : s.status === "failed" ? "!" : "–"}</span>{s.title}</li>)}
      {running && progress && <li className="running live"><span className="step-mark" aria-hidden="true">◌</span>{progress.label}{progress.detail && <small>{progress.detail}</small>}</li>}
    </ol>}

    {detail.plan && <details className="research-block" open={running}>
      <summary>Plan · {detail.plan.subquestions.length} sub-questions</summary>
      <p className="research-objective">{detail.plan.objective}</p>
      <ol>{detail.plan.subquestions.map(s => <li key={s.question}>{s.question}<small>{s.queries.join(" · ")}</small></li>)}</ol>
    </details>}

    {detail.report && <article className="answer research-report"><div className="answer-text md"><Markdown text={detail.report} citations={citations} /></div></article>}

    {detail.notes.length > 0 && <details className="research-block">
      <summary>Research notes · {detail.notes.length}</summary>
      <ul className="research-notes">{detail.notes.map((n, i) => <li key={i}><span className="note-topic">{n.topic}</span>{n.content} {n.sourceOrdinals.map(o => <button key={o} type="button" className="cite" onClick={() => setPanel(o)}>{o}</button>)}</li>)}</ul>
    </details>}
    {detail.queries.length > 0 && <details className="research-block"><summary>Searches · {detail.queries.length}</summary><ul className="research-queries">{detail.queries.map(q => <li key={q}>{q}</li>)}</ul></details>}

    {panel !== null && detail.sources.length > 0 && <SourcesPanel sources={detail.sources} active={panel} onClose={() => setPanel(null)} />}
  </section>;
}
