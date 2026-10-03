import { useEffect, useRef, useState } from "react";
import { api, documentHref, documentIdFromUrl, formatDate, locatorText, openDocumentPreview, typeLabel, type Locator, type MessageSource, type SourceInfo } from "../api.ts";
import { CloseIcon } from "./Icons.tsx";


export function SourceCard({ source, ordinal, cited, active, locator, onSavedChange }: { source: SourceInfo; ordinal?: number; cited?: boolean; active?: boolean; locator?: Locator; onSavedChange?(saved: boolean): void }) {
  const file = source.sourceType === "uploaded_file";
  const [saved, setSaved] = useState(source.saved);
  const [busy, setBusy] = useState(false);
  const ref = useRef<HTMLElement>(null);
  useEffect(() => setSaved(source.saved), [source.saved]);
  useEffect(() => { if (active) ref.current?.scrollIntoView({ block: "nearest", behavior: "smooth" }); }, [active]);
  async function toggle() {
    setBusy(true);
    try { const r = await api.saveSource(source.id, !saved); setSaved(r.saved); onSavedChange?.(r.saved); } catch { /* keep the previous state */ } finally { setBusy(false); }
  }
  const by = [source.author, source.publisher && source.publisher !== source.domain ? source.publisher : null].filter(Boolean).join(" · ");
  return <article ref={ref} className={`source-card${active ? " active" : ""}`} id={ordinal ? `source-${ordinal}` : undefined}>
    <div className="source-card-head">
      {ordinal !== undefined && <span className="source-num">{ordinal}</span>}
      <span className="source-type">{typeLabel[source.sourceType] || source.sourceType}</span>
      {ordinal !== undefined && !cited && <span className="source-uncited" title="Given to the model but not cited in the answer">not cited</span>}
      <button type="button" className={`source-save${saved ? " on" : ""}`} onClick={toggle} disabled={busy} aria-pressed={saved}>{saved ? "★ Saved" : "☆ Save"}</button>
    </div>
    <a className="source-title" href={documentHref(source.url, locator)} target="_blank" rel="noreferrer noopener"
      onClick={e => { const docId = file ? documentIdFromUrl(source.url) : undefined; if (docId) { e.preventDefault(); openDocumentPreview(docId, locator); } }}>{source.title} <span aria-hidden="true">{file ? "▸" : "↗"}</span></a>
    <div className="source-meta">{file ? "Your file" : source.domain}{locator && locatorText(locator) ? <span className="source-locator"> · {locatorText(locator)}</span> : null}{!file && by && ` · ${by}`}{source.publicationDate && ` · ${formatDate(source.publicationDate)}`}</div>
    {source.snippet && <p className="source-snippet">{source.snippet.length > 280 ? `${source.snippet.slice(0, 277)}…` : source.snippet}</p>}
  </article>;
}

/** Drawer listing every source the answer was given, opened at the clicked citation. */
export function SourcesPanel({ sources, active, onClose }: { sources: MessageSource[]; active?: number; onClose(): void }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  const cited = sources.filter(s => s.cited).length;
  return <>
    <div className="sheet-scrim" onClick={onClose} aria-hidden="true" />
    <aside className="sources-panel glass" aria-label="Sources">
      <div className="sheet-handle" aria-hidden="true" />
      <div className="sources-panel-head"><div><strong><span className="dot" /> Sources</strong><small>{sources.length} read · {cited} cited</small></div><button type="button" className="icon-button" onClick={onClose} aria-label="Close sources"><CloseIcon size={15} /></button></div>
      <div className="sources-panel-list">{sources.map(s => <SourceCard key={s.ordinal} source={s.source} ordinal={s.ordinal} cited={s.cited} locator={s.locator} active={s.ordinal === active} />)}</div>
    </aside>
  </>;
}

/** Saved sources (and recently retrieved ones) across the workspace. */
export function SourceLibrary() {
  const [savedOnly, setSavedOnly] = useState(true);
  const [query, setQuery] = useState("");
  const [items, setItems] = useState<SourceInfo[] | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    let live = true;
    const t = setTimeout(() => api.sources(savedOnly, query.trim()).then(list => { if (live) { setItems(list); setError(""); } }, e => live && setError(e.message)), 200);
    return () => { live = false; clearTimeout(t); };
  }, [savedOnly, query]);
  return <section className="library">
    <div className="eyebrow">SOURCES</div>
    <h2>Your source library</h2>
    <p className="lede">Sources Arbor has read for you. Save the ones you want to keep for assignments and research.</p>
    <div className="library-controls">
      <div className="segmented" role="tablist">
        <button type="button" role="tab" aria-selected={savedOnly} className={savedOnly ? "on" : ""} onClick={() => setSavedOnly(true)}>Saved</button>
        <button type="button" role="tab" aria-selected={!savedOnly} className={!savedOnly ? "on" : ""} onClick={() => setSavedOnly(false)}>All retrieved</button>
      </div>
      <input type="search" placeholder="Filter by title or site" value={query} onChange={e => setQuery(e.target.value)} aria-label="Filter sources" />
    </div>
    {error && <div className="error" role="alert">{error}</div>}
    {items && !items.length && <div className="setup-note">{savedOnly ? "No saved sources yet. Use ☆ Save on any source in an answer." : "No sources yet. Ask a question that needs a web search."}</div>}
    <div className="library-grid">{items?.map(s => <SourceCard key={s.id} source={s} onSavedChange={saved => savedOnly && !saved && setItems(prior => prior?.filter(x => x.id !== s.id) ?? null)} />)}</div>
  </section>;
}
