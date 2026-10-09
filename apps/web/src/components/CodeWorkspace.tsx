import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, ndjsonEvents, formatDate, type Model } from "../api.ts";
import { projectsApi, type AgentOutput, type AgentRun, type Checkpoint, type Diff, type MemoryView, type PreviewState, type ProjectView, type RunInfo, type SearchHit, type Template, type TreeEntry } from "../projects.ts";
import { CodeEditor } from "./Editor.tsx";
import { ModelPicker } from "./Composer.tsx";
import { ArrowIcon, ChevronIcon, CloseIcon, CodeIcon, FileIcon, LayersIcon, PlusIcon, RefreshIcon, SearchIcon, StopIcon } from "./Icons.tsx";
import "../code.css";

const stored = (key: string) => { try { return localStorage.getItem(key) ?? ""; } catch { return ""; } };
const remember = (key: string, value: string) => { try { localStorage.setItem(key, value); } catch { /* optional */ } };
const baseName = (path: string) => path.split("/").pop() ?? path;

/** Code Workspace: projects, explorer, editor, terminal, preview, history and the coding agent. */
export function CodeWorkspace({ models, openProjectId, context, onConsumeOpen }: { models: Model[]; openProjectId?: string; context?: string; onConsumeOpen?(): void }) {
  const [projects, setProjects] = useState<ProjectView[] | null>(null);
  const [current, setCurrent] = useState<string>(() => openProjectId || stored("arbor.project"));
  const [error, setError] = useState("");
  const refresh = useCallback(() => projectsApi.list().then(setProjects, e => setError(e.message)), []);
  useEffect(() => { void refresh(); }, [refresh]);
  useEffect(() => { if (openProjectId) { setCurrent(openProjectId); onConsumeOpen?.(); } }, [openProjectId, onConsumeOpen]);
  useEffect(() => remember("arbor.project", current), [current]);
  const project = projects?.find(p => p.id === current);
  if (!projects) return <section className="code-home"><p className="thinking">{error || "Loading projects…"}</p></section>;
  if (!project) return <ProjectHome projects={projects} onOpen={id => setCurrent(id)} onCreated={p => { setProjects(list => [p, ...(list ?? [])]); setCurrent(p.id); }} />;
  return <Workspace key={project.id} project={project} models={models} context={context} onExit={() => { setCurrent(""); void refresh(); }} onChanged={refresh} />;
}

function ProjectHome({ projects, onOpen, onCreated }: { projects: ProjectView[]; onOpen(id: string): void; onCreated(p: ProjectView): void }) {
  const [templates, setTemplates] = useState<Template[]>([]);
  const [name, setName] = useState("");
  const [template, setTemplate] = useState("static");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => { projectsApi.templates().then(setTemplates, () => {}); }, []);
  async function create() {
    if (!name.trim()) return;
    setBusy(true); setError("");
    try { onCreated(await projectsApi.create(name.trim(), template)); } catch (e) { setError(e instanceof Error ? e.message : "Could not create the project."); } finally { setBusy(false); }
  }
  return <section className="code-home">
    <div className="eyebrow">CODE WORKSPACE</div>
    <h2>Build and fix code with Arbor</h2>
    <p className="lede">Create or open a project. Arbor's coding agent inspects your files, makes small precise edits, runs your tests and build, and keeps every change revertible. Projects live in data/projects on this machine.</p>
    <div className="glass new-project">
      <input value={name} onChange={e => setName(e.target.value)} placeholder="Project name" aria-label="Project name" onKeyDown={e => { if (e.key === "Enter") void create(); }} />
      <div className="template-grid" role="radiogroup" aria-label="Template">
        {templates.map(t => <button key={t.id} type="button" role="radio" aria-checked={template === t.id} className={`template${template === t.id ? " on" : ""}`} onClick={() => setTemplate(t.id)}><strong>{t.label}</strong><small>{t.description}</small></button>)}
      </div>
      <button type="button" className="send" disabled={!name.trim() || busy} onClick={create}>{busy ? "Creating…" : "Create project"} <ArrowIcon size={14} /></button>
    </div>
    {error && <div className="error" role="alert">{error}</div>}
    {projects.length > 0 && <>
      <div className="nav-label research-list-label">YOUR PROJECTS</div>
      <div className="research-list">{projects.map(p => <button key={p.id} type="button" className="research-item" onClick={() => onOpen(p.id)}>
        <span className="research-item-q"><CodeIcon size={13} /> {p.name}</span><span className="research-badge completed">{p.label}</span><small>{formatDate(p.createdAt)}</small>
      </button>)}</div>
    </>}
  </section>;
}

type Tab = { path: string; content: string; saved: string; binary: boolean; truncated: boolean };
type Bottom = "terminal" | "preview";
type Side = "agent" | "history";

function Workspace({ project, models, context, onExit, onChanged }: { project: ProjectView; models: Model[]; context?: string; onExit(): void; onChanged(): void }) {
  const id = project.id;
  const [tree, setTree] = useState<TreeEntry[]>([]);
  const [tabs, setTabs] = useState<Tab[]>([]);
  const [active, setActive] = useState<string>("");
  const [gotoLine, setGotoLine] = useState<number | undefined>();
  const [diffView, setDiffView] = useState<{ title: string; diff: Diff } | null>(null);
  const [bottom, setBottom] = useState<Bottom>("terminal");
  // The bottom panel (terminal or preview) can take most of the centre column, e.g. to see the app properly.
  const [bottomLarge, setBottomLarge] = useState(false);
  const [side, setSide] = useState<Side>("agent");
  const [notice, setNotice] = useState("");
  const [focusRun, setFocusRun] = useState<string | undefined>();
  const loadTree = useCallback(() => projectsApi.tree(id).then(setTree, e => setNotice(e.message)), [id]);
  useEffect(() => { void loadTree(); }, [loadTree]);
  const flash = (text: string) => { setNotice(text); setTimeout(() => setNotice(n => (n === text ? "" : n)), 4000); };

  const open = useCallback(async (path: string, line?: number) => {
    setDiffView(null);
    setGotoLine(line);
    if (tabs.some(t => t.path === path)) { setActive(path); return; }
    try {
      const file = await projectsApi.read(id, path);
      const text = file.content ?? "";
      setTabs(list => [...list.filter(t => t.path !== path), { path, content: text, saved: text, binary: file.binary, truncated: file.truncated }]);
      setActive(path);
    } catch (e) { flash(e instanceof Error ? e.message : "Could not open the file"); }
  }, [id, tabs]);
  const tab = tabs.find(t => t.path === active);
  async function save(path = active) {
    const t = tabs.find(x => x.path === path);
    if (!t || t.binary || t.content === t.saved) return;
    try { await projectsApi.write(id, path, t.content); setTabs(list => list.map(x => (x.path === path ? { ...x, saved: x.content } : x))); flash(`Saved ${baseName(path)}`); }
    catch (e) { flash(e instanceof Error ? e.message : "Save failed"); }
  }
  function close(path: string) {
    const t = tabs.find(x => x.path === path);
    if (t && t.content !== t.saved && !confirm(`${baseName(path)} has unsaved changes. Close anyway?`)) return;
    const rest = tabs.filter(x => x.path !== path);
    setTabs(rest);
    if (active === path) setActive(rest.at(-1)?.path ?? "");
  }
  /** After the agent or a restore changed files on disk, open tabs without local edits pick up the new content. */
  const reloadFromDisk = useCallback(async () => {
    await loadTree();
    const fresh = await Promise.all(tabs.map(async t => {
      if (t.content !== t.saved) return t;
      try { const f = await projectsApi.read(id, t.path); const text = f.content ?? ""; return { ...t, content: text, saved: text }; } catch { return null; }
    }));
    const kept = fresh.filter((t): t is Tab => t !== null);
    setTabs(kept);
    if (!kept.some(t => t.path === active)) setActive(kept.at(-1)?.path ?? "");
  }, [id, tabs, active, loadTree]);

  async function runCommand(command: string) {
    try { const run = await projectsApi.run(id, command); setBottom("terminal"); setFocusRun(run.id); }
    catch (e) { flash(e instanceof Error ? e.message : "Could not run the command"); }
  }
  async function saveVersion() {
    const label = prompt("Describe this version", "Saved version");
    if (label === null) return;
    const r = await projectsApi.checkpoint(id, label).catch(e => ({ error: e.message }));
    flash("error" in r ? r.error : "unchanged" in r ? "Nothing changed since the last version" : `Saved version "${label}"`);
  }
  const dirty = tabs.filter(t => t.content !== t.saved).length;

  return <div className="code-ws">
    <div className="code-bar">
      <button type="button" className="back-link" onClick={() => { if (!dirty || confirm("You have unsaved files. Leave anyway?")) onExit(); }}>← Projects</button>
      <strong className="code-title">{project.name}</strong><span className="tag">{project.label}</span>
      <div className="code-bar-actions">
        {notice && <span className="code-notice" role="status">{notice}</span>}
        {project.testCommand && <button type="button" className="chip" onClick={() => runCommand(project.testCommand!)}>Run tests</button>}
        {project.buildCommand && <button type="button" className="chip" onClick={() => runCommand(project.buildCommand!)}>Build</button>}
        <button type="button" className="chip" onClick={() => { setBottom("preview"); setBottomLarge(true); }}>Preview</button>
        <button type="button" className="chip" onClick={saveVersion}><LayersIcon size={12} /> Save version</button>
      </div>
    </div>
    <div className="code-grid">
      <Explorer projectId={id} tree={tree} active={active} onOpen={open} onChanged={async () => { await loadTree(); onChanged(); }} flash={flash} />
      {/* With no file open the editor area would be empty, so a preview gets the room. */}
      <div className={`code-center${bottomLarge || (bottom === "preview" && !tab && !diffView) ? " bottom-large" : ""}`}>
        {diffView ? <DiffViewer title={diffView.title} diff={diffView.diff} onClose={() => setDiffView(null)} onOpen={p => open(p)} /> : <>
          <div className="code-tabs" role="tablist">
            {tabs.map(t => <div key={t.path} role="tab" aria-selected={t.path === active} className={`code-tab${t.path === active ? " on" : ""}`} onClick={() => setActive(t.path)} title={t.path}>
              {baseName(t.path)}{t.content !== t.saved && <span className="dirty" aria-label="unsaved">●</span>}
              <button type="button" onClick={e => { e.stopPropagation(); close(t.path); }} aria-label={`Close ${t.path}`}><CloseIcon size={11} /></button>
            </div>)}
            {tab && !tab.binary && <button type="button" className="code-save" disabled={tab.content === tab.saved} onClick={() => save()}>Save</button>}
          </div>
          <div className="code-editor-wrap">
            {!tab ? <div className="code-empty"><CodeIcon size={22} /><p>Open a file from the explorer, or ask the assistant to make a change.</p></div>
              : tab.binary ? (/\.(png|jpe?g|gif|webp|svg)$/i.test(tab.path) ? <div className="code-empty"><img src={projectsApi.rawUrl(id, tab.path)} alt={tab.path} className="code-image" /></div> : <div className="code-empty"><p>{tab.path} is a binary file and can't be edited here.</p></div>)
                : <CodeEditor key={tab.path} path={tab.path} value={tab.content} line={gotoLine} onChange={text => setTabs(list => list.map(x => (x.path === tab.path ? { ...x, content: text } : x)))} onSave={() => save(tab.path)} />}
            {tab?.truncated && <div className="msg-note">This file is larger than 2 MB; only the beginning is shown and saving is disabled.</div>}
          </div>
        </>}
        <div className="code-bottom">
          <div className="code-bottom-tabs" role="tablist">
            <button type="button" role="tab" aria-selected={bottom === "terminal"} className={bottom === "terminal" ? "on" : ""} onClick={() => setBottom("terminal")}>Terminal</button>
            <button type="button" role="tab" aria-selected={bottom === "preview"} className={bottom === "preview" ? "on" : ""} onClick={() => setBottom("preview")}>Preview</button>
            <span className="spacer" />
            <button type="button" className="bottom-size" aria-pressed={bottomLarge} title={bottomLarge ? "Make this panel smaller" : "Make this panel larger"} onClick={() => setBottomLarge(v => !v)}>{bottomLarge ? "▾ Collapse" : "▴ Expand"}</button>
          </div>
          {bottom === "terminal" ? <Terminal projectId={id} focusRun={focusRun} onRun={runCommand} /> : <Preview projectId={id} onShowRun={runId => { setFocusRun(runId); setBottom("terminal"); }} />}
        </div>
      </div>
      <div className="code-side">
        <div className="code-bottom-tabs" role="tablist">
          <button type="button" role="tab" aria-selected={side === "agent"} className={side === "agent" ? "on" : ""} onClick={() => setSide("agent")}>Assistant</button>
          <button type="button" role="tab" aria-selected={side === "history"} className={side === "history" ? "on" : ""} onClick={() => setSide("history")}>History</button>
        </div>
        {side === "agent"
          ? <AgentPanel projectId={id} models={models} context={context} dirty={dirty} onDone={reloadFromDisk} onOpen={open} onDiff={(title, diff) => setDiffView({ title, diff })} />
          : <HistoryPanel projectId={id} onDiff={(title, diff) => setDiffView({ title, diff })} onRestored={reloadFromDisk} />}
      </div>
    </div>
  </div>;
}

function Explorer({ projectId, tree, active, onOpen, onChanged, flash }: { projectId: string; tree: TreeEntry[]; active: string; onOpen(path: string, line?: number): void; onChanged(): Promise<void>; flash(t: string): void }) {
  const [open, setOpen] = useState<Set<string>>(() => new Set());
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<SearchHit[] | null>(null);
  const upload = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (!query.trim()) { setHits(null); return; }
    const t = setTimeout(() => projectsApi.search(projectId, query.trim()).then(setHits, () => setHits([])), 250);
    return () => clearTimeout(t);
  }, [query, projectId]);
  const act = async (fn: () => Promise<unknown>, done: string) => { try { await fn(); await onChanged(); flash(done); } catch (e) { flash(e instanceof Error ? e.message : "That didn't work"); } };
  const folderOf = (path: string) => (path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "");
  const base = active ? folderOf(active) : "";
  async function newFile() {
    const path = prompt("New file path", base ? `${base}/` : "");
    if (path?.trim()) await act(async () => { await projectsApi.write(projectId, path.trim(), ""); onOpen(path.trim()); }, `Created ${path.trim()}`);
  }
  async function newFolder() {
    const path = prompt("New folder path", base ? `${base}/` : "");
    if (path?.trim()) await act(() => projectsApi.fs(projectId, "mkdir", path.trim()), `Created ${path.trim()}/`);
  }
  async function uploadFiles(files: File[]) {
    for (const f of files) {
      const b64 = await new Promise<string>((resolve, reject) => { const r = new FileReader(); r.onload = () => resolve(String(r.result).split(",")[1] ?? ""); r.onerror = () => reject(r.error); r.readAsDataURL(f); });
      await act(() => projectsApi.writeBase64(projectId, base ? `${base}/${f.name}` : f.name, b64), `Uploaded ${f.name}`);
    }
  }
  const render = (entries: TreeEntry[], depth: number) => entries.map(e => <div key={e.path}>
    <div className={`tree-row${e.path === active ? " on" : ""}`} style={{ paddingLeft: 8 + depth * 12 }}>
      <button type="button" className="tree-name" onClick={() => (e.type === "dir" ? setOpen(s => { const n = new Set(s); if (n.has(e.path)) n.delete(e.path); else n.add(e.path); return n; }) : onOpen(e.path))} title={e.path}>
        {e.type === "dir" ? <ChevronIcon size={11} className={open.has(e.path) ? "" : "rot"} /> : <FileIcon size={11} />}<span>{e.name}</span>
      </button>
      <span className="tree-actions">
        <button type="button" title="Rename" onClick={() => { const to = prompt("Rename to", e.path); if (to?.trim() && to.trim() !== e.path) void act(() => projectsApi.fs(projectId, "rename", e.path, to.trim()), `Renamed to ${to.trim()}`); }}>✎</button>
        <button type="button" title="Delete" onClick={() => { if (confirm(`Delete ${e.path}${e.type === "dir" ? " and everything in it" : ""}? You can restore it from History.`)) void act(() => projectsApi.fs(projectId, "delete", e.path), `Deleted ${e.path}`); }}>✕</button>
      </span>
    </div>
    {e.type === "dir" && open.has(e.path) && e.children && render(e.children, depth + 1)}
  </div>);
  return <aside className="code-explorer" aria-label="Project files">
    <div className="explorer-tools">
      <span className="nav-label">FILES</span>
      <button type="button" className="icon-button" title="New file" onClick={newFile}><PlusIcon size={13} /></button>
      <button type="button" className="icon-button" title="New folder" onClick={newFolder}><LayersIcon size={13} /></button>
      <button type="button" className="icon-button" title="Upload files" onClick={() => upload.current?.click()}><FileIcon size={13} /></button>
      <button type="button" className="icon-button" title="Refresh" onClick={() => void onChanged()}><RefreshIcon size={13} /></button>
      <input ref={upload} type="file" multiple hidden onChange={e => { const f = [...(e.target.files ?? [])]; e.target.value = ""; void uploadFiles(f); }} />
    </div>
    <label className="explorer-search"><SearchIcon size={12} /><input value={query} onChange={e => setQuery(e.target.value)} placeholder="Search in project" aria-label="Search in project" /></label>
    <div className="tree">
      {hits ? (hits.length ? hits.map((h, i) => <button key={i} type="button" className="hit" onClick={() => onOpen(h.path, h.line || undefined)}><span>{h.path}{h.line ? `:${h.line}` : ""}</span><small>{h.text}</small></button>) : <p className="tree-empty">No matches.</p>)
        : tree.length ? render(tree, 0) : <p className="tree-empty">Empty project.</p>}
    </div>
  </aside>;
}

function Terminal({ projectId, focusRun, onRun }: { projectId: string; focusRun?: string; onRun(command: string): void }) {
  const [runs, setRuns] = useState<RunInfo[]>([]);
  const [selected, setSelected] = useState<string | undefined>(focusRun);
  const [output, setOutput] = useState("");
  const [command, setCommand] = useState("");
  const [status, setStatus] = useState<RunInfo["status"] | "">("");
  const box = useRef<HTMLPreElement>(null);
  const loadRuns = useCallback(() => projectsApi.runs(projectId).then(r => { setRuns(r); return r; }, () => [] as RunInfo[]), [projectId]);
  useEffect(() => { void loadRuns().then(r => setSelected(s => s ?? r[0]?.id)); }, [loadRuns]);
  useEffect(() => { if (focusRun) { setSelected(focusRun); void loadRuns(); } }, [focusRun, loadRuns]);
  useEffect(() => {
    if (!selected) return;
    const abort = new AbortController();
    setOutput(""); setStatus("running");
    (async () => {
      try {
        const res = await projectsApi.runEvents(projectId, selected, abort.signal);
        if (!res.ok) { setOutput((await res.json().catch(() => ({}))).error ?? "This run's output is no longer available."); setStatus(""); return; }
        for await (const e of ndjsonEvents(res)) {
          if (e.type === "output") setOutput(o => (o + e.text).slice(-200_000));
          if (e.type === "end") { setStatus(e.info.status); void loadRuns(); }
        }
      } catch { /* closed */ }
    })();
    return () => abort.abort();
  }, [selected, projectId, loadRuns]);
  useEffect(() => { if (box.current) box.current.scrollTop = box.current.scrollHeight; }, [output]);
  return <div className="terminal">
    <div className="terminal-bar">
      <select value={selected ?? ""} onChange={e => setSelected(e.target.value || undefined)} aria-label="Command run">
        {!runs.length && <option value="">No commands yet</option>}
        {runs.map(r => <option key={r.id} value={r.id}>{r.status === "running" ? "● " : ""}{r.command} — {r.status}</option>)}
      </select>
      {status === "running" && selected && <button type="button" className="send stop" onClick={() => projectsApi.cancelRun(projectId, selected).catch(() => {})}><StopIcon size={12} /> Stop</button>}
      {status && status !== "running" && <span className={`run-status ${status}`}>{status}</span>}
    </div>
    <pre ref={box} className="terminal-out" aria-live="polite">{output || "Run a command below. Allowed: node, npm, npx, python, pip, pytest, tsc, read-only git and a few build tools. One command at a time; no shell operators."}</pre>
    <form className="terminal-in" onSubmit={e => { e.preventDefault(); if (command.trim()) { onRun(command.trim()); setCommand(""); } }}>
      <span>$</span><input value={command} onChange={e => setCommand(e.target.value)} placeholder="npm test" aria-label="Command" spellCheck={false} />
    </form>
  </div>;
}

function Preview({ projectId, onShowRun }: { projectId: string; onShowRun(runId: string): void }) {
  const [state, setState] = useState<PreviewState>({ status: "idle" });
  const [nonce, setNonce] = useState(0);
  useEffect(() => { projectsApi.preview(projectId).then(setState, () => {}); }, [projectId]);
  useEffect(() => {
    if (!["installing", "starting"].includes(state.status)) return;
    const t = setInterval(() => projectsApi.preview(projectId).then(setState, () => {}), 1500);
    return () => clearInterval(t);
  }, [state.status, projectId]);
  const start = async () => setState(await projectsApi.previewAction(projectId, "start").catch(e => ({ status: "failed" as const, message: e.message })));
  return <div className="preview">
    <div className="terminal-bar">
      <span className={`run-status ${state.status}`}>{state.status}</span>
      {state.url && <a href={state.url} target="_blank" rel="noreferrer" className="preview-url">{state.url.startsWith("/") ? "Open in new tab" : state.url}</a>}
      <span className="spacer" />
      {(state.runId || state.installRunId) && <button type="button" className="chip" onClick={() => onShowRun((state.installRunId && state.status === "installing" ? state.installRunId : state.runId) ?? state.installRunId!)}>Output</button>}
      {state.status === "running" && <button type="button" className="chip" onClick={() => setNonce(n => n + 1)}><RefreshIcon size={12} /> Reload</button>}
      {state.status !== "idle" && <button type="button" className="chip" onClick={() => projectsApi.previewAction(projectId, "stop").then(setState, () => {})}>Stop</button>}
      <button type="button" className="send" onClick={start}>{state.status === "idle" ? "Start preview" : "Restart"}</button>
    </div>
    {state.status === "running" && state.url
      ? <iframe key={nonce} className="preview-frame" src={state.url} title="Project preview" sandbox="allow-scripts allow-forms allow-modals allow-popups allow-same-origin" />
      : <div className="code-empty"><p>{state.status === "idle" ? "Start a preview to see the app. Static sites open directly; Vite, React and Next.js projects install dependencies and start a dev server." : state.status === "installing" ? "Installing dependencies…" : state.status === "starting" ? "Starting the dev server…" : state.message ?? state.status}</p></div>}
  </div>;
}

function DiffViewer({ title, diff, onClose, onOpen }: { title: string; diff: Diff; onClose(): void; onOpen(path: string): void }) {
  const chunks = useMemo(() => diff.patch.split(/(?=^diff --git )/m).filter(c => c.trim()), [diff.patch]);
  return <div className="diff-view">
    <div className="code-tabs"><strong className="diff-title">{title}</strong><span className="spacer" /><button type="button" className="code-save" onClick={onClose}>Close diff</button></div>
    <div className="diff-files">{diff.files.map(f => <button key={f.path} type="button" onClick={() => f.status !== "deleted" && onOpen(f.path)} className={`diff-file ${f.status}`}>{f.status === "added" ? "A" : f.status === "deleted" ? "D" : f.status === "renamed" ? "R" : "M"} {f.path} <span className="plus">+{f.added}</span> <span className="minus">−{f.removed}</span></button>)}</div>
    <div className="diff-body md-code"><pre><code>{chunks.length ? chunks.flatMap((chunk, ci) => chunk.split("\n").filter(l => !/^(index |new file mode|deleted file mode|similarity index)/.test(l)).map((line, i) => <span key={`${ci}-${i}`} className={`diff-line${line.startsWith("diff --git") ? " file" : line.startsWith("+") && !line.startsWith("+++") ? " add" : line.startsWith("-") && !line.startsWith("---") ? " del" : line.startsWith("@@") ? " hunk" : ""}`}>{line.startsWith("diff --git") ? line.replace(/^diff --git a\/(.*) b\/.*$/, "▸ $1") : line}{"\n"}</span>)) : "No changes."}</code></pre>
      {diff.truncated && <div className="msg-note">The diff is too large to show in full.</div>}</div>
  </div>;
}

function HistoryPanel({ projectId, onDiff, onRestored }: { projectId: string; onDiff(title: string, d: Diff): void; onRestored(): Promise<void> }) {
  const [log, setLog] = useState<Checkpoint[] | null>(null);
  const [pending, setPending] = useState<Diff | null>(null);
  const load = useCallback(() => { projectsApi.history(projectId).then(setLog, () => setLog([])); projectsApi.changes(projectId).then(setPending, () => {}); }, [projectId]);
  useEffect(() => { load(); }, [load]);
  return <div className="history-panel">
    {pending && pending.files.length > 0 && <button type="button" className="checkpoint pending" onClick={() => onDiff("Unsaved changes since the last version", pending)}>
      <strong>Changes since last version</strong><small>{pending.files.length} file{pending.files.length === 1 ? "" : "s"} · +{pending.files.reduce((n, f) => n + f.added, 0)} −{pending.files.reduce((n, f) => n + f.removed, 0)}</small>
    </button>}
    {log === null ? <p className="thinking">Loading…</p> : !log.length ? <p className="tree-empty">No versions yet.</p> : log.map(c => <div key={c.commit} className="checkpoint">
      <button type="button" onClick={async () => onDiff(c.message, await projectsApi.checkpointDiff(projectId, c.commit))}>
        <strong>{c.message}</strong><small><span className={`who ${c.author}`}>{c.author === "agent" ? "Arbor agent" : c.author === "system" ? "Arbor" : "You"}</span> · {new Date(c.createdAt).toLocaleString()} · {c.files.length} file{c.files.length === 1 ? "" : "s"}</small>
      </button>
      <button type="button" className="chip" title="Put all files back as they were at this version" onClick={async () => { if (confirm(`Restore all files to "${c.message}"? Your current state is saved first, so this can be undone.`)) { await projectsApi.restore(projectId, c.commit); await onRestored(); load(); } }}>Restore</button>
    </div>)}
  </div>;
}

type AgentLine = { kind: string; title: string; detail?: string };
function AgentPanel({ projectId, models, context, dirty, onDone, onOpen, onDiff }: { projectId: string; models: Model[]; context?: string; dirty: number; onDone(): Promise<void>; onOpen(path: string): void; onDiff(title: string, d: Diff): void }) {
  const [task, setTask] = useState("");
  const [choice, setChoice] = useState("auto");
  const [taskId, setTaskId] = useState<string | null>(null);
  const [lines, setLines] = useState<AgentLine[]>([]);
  const [state, setState] = useState<MemoryView | null>(null);
  const [result, setResult] = useState<{ status: string; output: AgentOutput | null; error?: string } | null>(null);
  const [runs, setRuns] = useState<AgentRun[]>([]);
  const [error, setError] = useState("");
  const log = useRef<HTMLOListElement>(null);
  const loadRuns = useCallback(() => projectsApi.agentRuns(projectId).then(setRuns, () => {}), [projectId]);
  useEffect(() => { void loadRuns(); }, [loadRuns]);
  // Reattach to an agent that is still running (e.g. after a page reload).
  useEffect(() => { const live = runs.find(r => r.status === "running" || r.status === "queued"); if (live && !taskId) setTaskId(live.taskId); }, [runs, taskId]);
  useEffect(() => {
    if (!taskId) return;
    const abort = new AbortController();
    (async () => {
      try {
        const res = await api.taskEvents(taskId, abort.signal);
        // The task ended (seen live, or already over when the stream opened): show its stored result.
        const settle = async (status: string, error?: string) => {
          const runsNow = await projectsApi.agentRuns(projectId).catch(() => [] as AgentRun[]);
          setRuns(runsNow);
          const mine = runsNow.find(r => r.taskId === taskId);
          setResult({ status, output: mine?.output ?? null, error: error ?? mine?.error ?? undefined });
          await onDone();
        };
        // A task that already ended replays the events it kept and closes; the snapshot settles it if none were kept.
        let ended: { status: string; error?: string } | undefined;
        for await (const e of ndjsonEvents(res)) {
          if (e.type === "agent") { if (e.kind === "state") setState(e.state); else setLines(l => [...l, { kind: e.kind, title: e.title, detail: e.detail }].slice(-200)); }
          if (e.type === "snapshot" && ["completed", "failed", "cancelled"].includes(e.status)) ended = { status: e.status, error: e.error ?? undefined };
          if (e.type === "status" && ["completed", "failed", "cancelled"].includes(e.status)) { ended = undefined; await settle(e.status, e.error ?? undefined); break; }
        }
        if (ended) await settle(ended.status, ended.error);
      } catch { /* stream closed */ }
      setTaskId(null);
    })();
    return () => abort.abort();
    // onDone changes identity with open tabs; the stream must not restart because of that.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [taskId, projectId]);
  useEffect(() => { if (log.current) log.current.scrollTop = log.current.scrollHeight; }, [lines]);
  async function start() {
    if (task.trim().length < 3) return;
    if (dirty && !confirm(`You have ${dirty} unsaved file(s). The agent works on the saved files. Continue?`)) return;
    setError(""); setLines([]); setState(null); setResult(null);
    try { setTaskId((await projectsApi.startAgent(projectId, task.trim(), choice, context)).taskId); }
    catch (e) { setError(e instanceof Error ? e.message : "Could not start the agent"); }
  }
  async function revert(output: AgentOutput) {
    if (!output.baseCommit || !confirm("Revert every change this agent run made?")) return;
    await projectsApi.restore(projectId, output.baseCommit);
    await onDone();
    setResult(r => (r ? { ...r, status: "reverted" } : r));
  }
  const running = Boolean(taskId);
  const out = result?.output;
  const m = out?.metrics;
  return <div className="agent-panel">
    {context && <div className="agent-context" title={context}><strong>Assignment context attached</strong><small>{context.slice(0, 140)}{context.length > 140 ? "…" : ""}</small></div>}
    <textarea value={task} onChange={e => setTask(e.target.value)} disabled={running} rows={4} placeholder="Describe a change, a bug (paste the error), or a question about this project…" aria-label="Task for the coding agent"
      onKeyDown={e => { if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) { e.preventDefault(); void start(); } }} />
    <div className="agent-controls">
      <ModelPicker models={models} choice={choice} onChoice={setChoice} />
      {running ? <button type="button" className="send stop" onClick={() => taskId && api.cancelTask(taskId).catch(() => {})}><StopIcon size={12} /> Stop</button>
        : <button type="button" className="send" disabled={task.trim().length < 3 || !models.length} onClick={start}>Run agent <ArrowIcon size={13} /></button>}
    </div>
    {error && <div className="error" role="alert">{error}</div>}
    {state && <div className="agent-state">
      {state.plan.length > 0 && <div><span className="nav-label">PLAN</span><ul className="plan-list">{state.plan.map((p, i) => <li key={i} className={p.status}>{p.status === "done" ? "✓" : p.status === "doing" ? "◌" : "○"} {p.step}</li>)}</ul></div>}
      {state.relevant.length > 0 && <div><span className="nav-label">RELEVANT FILES</span><div className="file-chips">{state.relevant.slice(0, 8).map(r => <button key={r.path} type="button" title={r.reason} onClick={() => onOpen(r.path)}>{r.path}</button>)}</div></div>}
      {state.edits.length > 0 && <div><span className="nav-label">EDITS</span><ul className="plan-list">{state.edits.map((e, i) => <li key={i} className="done">✎ {e.path} <small>{e.summary}</small></li>)}</ul></div>}
      {state.remainingChecks.length > 0 && <div><span className="nav-label">REMAINING CHECKS</span><div className="file-chips">{state.remainingChecks.map(c => <span key={c}>{c}</span>)}</div></div>}
      {state.failures.length > 0 && running && <div><span className="nav-label">LATEST FAILURE</span><pre className="agent-failure">{state.failures.at(-1)}</pre></div>}
    </div>}
    {lines.length > 0 && <ol className="agent-log" ref={log} aria-live="polite">{lines.map((l, i) => <li key={i} className={l.kind}><span className="agent-kind">{l.kind}</span><span>{l.title}{l.detail && <small>{l.detail}</small>}</span></li>)}{running && <li className="live"><span className="agent-kind">…</span><span>Working</span></li>}</ol>}
    {result && <div className={`agent-result ${result.status === "completed" && (m?.success ?? true) ? "ok" : "bad"}`}>
      <strong>{result.status === "reverted" ? "Changes reverted" : result.status === "cancelled" ? "Stopped" : result.status === "failed" ? "Failed" : m?.success === false ? (m.checksPassing === false ? "Finished — checks still failing" : "Finished (not verified)") : "Done"}</strong>
      <p>{result.error ?? out?.summary}</p>
      {m && <div className="metrics"><span>{m.filesChanged} file{m.filesChanged === 1 ? "" : "s"} · +{m.linesAdded} −{m.linesRemoved}</span><span>{m.finalChecks.length ? m.finalChecks.map(c => `${c.name} ${c.status}`).join(" · ") : "no checks"}</span><span>{m.retries} retr{m.retries === 1 ? "y" : "ies"} · {m.steps} steps · {Math.round(m.elapsedMs / 1000)}s</span></div>}
      {out && out.files.length > 0 && <div className="result-actions">
        {out.commit && out.baseCommit && <button type="button" className="chip" onClick={async () => onDiff("Agent changes", await projectsApi.checkpointDiff(projectId, out.commit!, out.baseCommit))}>View diff</button>}
        {result.status !== "reverted" && out.baseCommit && <button type="button" className="chip" onClick={() => revert(out)}>Revert</button>}
      </div>}
    </div>}
    {!running && runs.length > 0 && <div className="agent-history"><span className="nav-label">PAST RUNS</span>{runs.slice(0, 8).map(r => <div key={r.taskId} className="past-run" title={r.output?.summary ?? r.error ?? ""}>
      <span className={`research-badge ${r.status === "completed" ? (r.output?.metrics?.success === false ? "failed" : "completed") : r.status === "running" ? "running" : "failed"}`}>{r.status === "completed" ? (r.output?.metrics?.success === false ? "unverified" : "done") : r.status}</span>
      <span className="past-task">{r.task}</span>
    </div>)}</div>}
  </div>;
}
