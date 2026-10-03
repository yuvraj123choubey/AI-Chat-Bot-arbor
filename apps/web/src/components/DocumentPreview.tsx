import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, documentTitle, formatBytes, type DocumentPreview as Preview, type DocumentView, type Locator } from "../api.ts";
import { CloseIcon, SearchIcon } from "./Icons.tsx";
import "../files.css";

// Syntax highlighting loads with the editor bundle only when a code file is previewed.
const CodeEditor = React.lazy(() => import("./Editor.tsx").then(m => ({ default: m.CodeEditor })));

const CODE = /\.(m?[jt]sx?|cjs|py|java|c|h|cpp|hpp|cc|cs|go|rs|rb|php|swift|kt|scala|sql|sh|html?|css|scss|json|ya?ml|xml|toml|vue|svelte)$/i;

/** Listens for preview requests (from file citations or the Files page) and shows the preview over the app. */
export function PreviewHost() {
  const [open, setOpen] = useState<{ id: string; locator?: Locator } | null>(null);
  useEffect(() => {
    const onPreview = (e: Event) => setOpen((e as CustomEvent<{ id: string; locator?: Locator }>).detail);
    window.addEventListener("arbor:preview", onPreview);
    return () => window.removeEventListener("arbor:preview", onPreview);
  }, []);
  return open ? <DocumentPreview key={`${open.id}-${JSON.stringify(open.locator ?? {})}`} id={open.id} locator={open.locator} onClose={() => setOpen(null)} /> : null;
}

/** Wraps matches of the search term in <mark>, so they are visible inside page or section text. */
function highlight(text: string, term: string): React.ReactNode {
  if (!term.trim()) return text;
  const parts = text.split(new RegExp(`(${term.trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&")})`, "gi"));
  return parts.map((p, i) => (i % 2 ? <mark key={i}>{p}</mark> : p));
}

/**
 * Reader for an uploaded document: PDF pages with navigation, Word sections, text and code with line numbers
 * (syntax-highlighted for code), and images. Opens at the cited page, section or lines when given.
 */
export function DocumentPreview({ id, locator, onClose }: { id: string; locator?: Locator; onClose(): void }) {
  const [doc, setDoc] = useState<DocumentView | null>(null);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [error, setError] = useState("");
  const [zoom, setZoom] = useState(1);
  const [term, setTerm] = useState("");
  const [jump, setJump] = useState("");
  const body = useRef<HTMLDivElement>(null);
  const target = locator?.page ?? locator?.lines?.[0];

  const load = useCallback(async (from?: number, to?: number) => {
    try { setPreview(await api.documentPages(id, from, to)); setError(""); }
    catch (e) { setError(e instanceof Error ? e.message : "This file can't be previewed."); }
  }, [id]);
  useEffect(() => {
    api.document(id).then(setDoc, e => setError(e.message));
    // Open around the cited place: two pages before a cited page, or 30 lines before cited lines.
    if (locator?.page) void load(Math.max(1, locator.page - 1), locator.page + 3);
    else if (locator?.lines) void load(Math.max(1, locator.lines[0] - 30), locator.lines[0] + 370);
    else void load();
  }, [id, locator, load]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  // Scroll the cited page or section into view once it is rendered.
  useEffect(() => {
    if (!preview || !body.current) return;
    const el = locator?.page ? body.current.querySelector(`[data-page="${locator.page}"]`) : locator?.section ? [...body.current.querySelectorAll("[data-section]")].find(n => n.getAttribute("data-section") === locator.section) : null;
    el?.scrollIntoView({ block: "start" });
  }, [preview, locator]);

  const matches = useMemo(() => {
    if (!preview || !term.trim() || preview.kind === "image") return 0;
    const re = new RegExp(term.trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi");
    const texts = preview.kind === "pages" ? preview.pages.map(p => p.text) : preview.kind === "sections" ? preview.sections.map(s => s.text) : preview.lines.map(l => l.text);
    return texts.reduce((n, t) => n + (t.match(re)?.length ?? 0), 0);
  }, [preview, term]);
  const shown = preview && preview.kind !== "image" ? { from: preview.from, to: preview.to, total: preview.total, unit: preview.kind === "pages" ? "page" : preview.kind === "sections" ? "section" : "line" } : null;
  const span = preview?.kind === "lines" ? 400 : preview?.kind === "sections" ? 10 : 5;
  const go = (from: number) => { if (shown) void load(Math.max(1, from), Math.min(shown.total, Math.max(1, from) + span - 1)); };
  const isCode = doc ? CODE.test(doc.name) : false;

  return <div className="doc-preview-backdrop" onClick={onClose}>
    <div className="doc-preview glass" role="dialog" aria-modal="true" aria-label={doc ? documentTitle(doc) : "Document preview"} onClick={e => e.stopPropagation()}>
      <div className="doc-preview-head">
        <div className="doc-preview-title"><strong>{doc ? documentTitle(doc) : "Loading…"}</strong>{doc && <small>{doc.mimeType} · {formatBytes(doc.sizeBytes)}{doc.pageCount ? ` · ${doc.pageCount} pages` : ""}{target ? ` · cited at ${locator?.page ? `p. ${locator.page}` : `line ${target}`}` : locator?.section ? ` · cited at § ${locator.section}` : ""}</small>}</div>
        <a className="chip" href={`/api/documents/${id}/file${locator?.page ? `#page=${locator.page}` : ""}`} target="_blank" rel="noreferrer">Open original</a>
        <button type="button" className="icon-button" onClick={onClose} aria-label="Close preview"><CloseIcon size={15} /></button>
      </div>
      {shown && <div className="doc-preview-tools">
        <button type="button" className="chip" disabled={shown.from <= 1} onClick={() => go(shown.from - span)}>‹ Prev</button>
        <span className="mono-note">{shown.unit}s {shown.from}–{shown.to} of {shown.total}</span>
        <button type="button" className="chip" disabled={shown.to >= shown.total} onClick={() => go(shown.to + 1)}>Next ›</button>
        <form onSubmit={e => { e.preventDefault(); const n = Number(jump); if (n >= 1) go(n - (preview?.kind === "lines" ? 30 : 0)); }}><input value={jump} onChange={e => setJump(e.target.value)} placeholder={`Go to ${shown.unit}`} aria-label={`Go to ${shown.unit}`} inputMode="numeric" /></form>
        {preview?.kind !== "lines" && <><button type="button" className="chip" onClick={() => setZoom(z => Math.max(0.8, z - 0.1))} aria-label="Smaller text">A−</button><button type="button" className="chip" onClick={() => setZoom(z => Math.min(1.6, z + 0.1))} aria-label="Larger text">A+</button></>}
        <label className="doc-search"><SearchIcon size={12} /><input value={term} onChange={e => setTerm(e.target.value)} placeholder="Find in shown text" aria-label="Find in document" />{term && <small>{matches}</small>}</label>
        {term && shown.to - shown.from + 1 < shown.total && preview?.kind !== "lines" && <button type="button" className="chip" onClick={() => void load(1, Math.min(shown.total, preview?.kind === "pages" ? 20 : 50))}>Search more</button>}
      </div>}
      <div className="doc-preview-body" ref={body} style={{ fontSize: `${13 * zoom}px` }}>
        {error ? <div className="error" role="alert">{error}</div>
          : !preview ? <p className="thinking">Loading…</p>
            : preview.kind === "image" ? <img className="doc-image" src={`/api/documents/${id}/file`} alt={doc ? documentTitle(doc) : "Uploaded image"} />
              : preview.kind === "pages" ? preview.pages.map(p => <section key={p.page} data-page={p.page} className={`doc-page${p.page === locator?.page ? " cited" : ""}`}><div className="doc-page-label">Page {p.page}{p.page === locator?.page && " · cited"}</div><div className="doc-text">{p.text.trim() ? highlight(p.text, term) : <em>No text on this page.</em>}</div></section>)
                : preview.kind === "sections" ? preview.sections.map(s => <section key={s.index} data-section={s.section ?? ""} className={`doc-page${s.section && s.section === locator?.section ? " cited" : ""}`}>{s.section && <div className="doc-page-label">{s.section}</div>}<div className="doc-text">{highlight(s.text, term)}</div></section>)
                  : isCode && !term ? <React.Suspense fallback={<p className="thinking">Loading…</p>}><div className="doc-code"><CodeEditor path={doc!.name} value={preview.lines.map(l => l.text).join("\n")} readOnly firstLine={preview.from} line={locator?.lines?.[0]} lineEnd={locator?.lines?.[1]} /></div></React.Suspense>
                    : <pre className="doc-lines">{preview.lines.map(l => <span key={l.n} className={locator?.lines && l.n >= locator.lines[0] && l.n <= locator.lines[1] ? "cited" : ""}><i>{l.n}</i>{highlight(l.text, term)}{"\n"}</span>)}</pre>}
      </div>
    </div>
  </div>;
}
