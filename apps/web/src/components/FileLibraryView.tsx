import { useCallback, useEffect, useState } from "react";
import { api, documentKinds, documentTitle, formatBytes, formatDate, MAX_UPLOAD_BYTES, openDocumentPreview, type DocumentLinkView, type DocumentView } from "../api.ts";
import { projectsApi } from "../projects.ts";
import { AttachmentChips, FilePickerButton, useFileDrop, useUploads } from "./Files.tsx";
import { CloseIcon, FileIcon, SearchIcon } from "./Icons.tsx";
import "../files.css";

type Target = { type: DocumentLinkView["type"]; id: string; label: string };
const typeLabel: Record<DocumentLinkView["type"], string> = { project: "Code project", research: "Research", conversation: "Conversation", assignment: "Assignment" };
const typeName = (d: DocumentView) => {
  const ext = d.name.split(".").pop()?.toUpperCase() ?? "";
  return d.mimeType === "application/pdf" ? "PDF" : /wordprocessingml/.test(d.mimeType) ? "Word" : d.mimeType.startsWith("image/") ? "Image" : ext || "File";
};

/** Everything a file can be attached to in this workspace (assignments appear once that service is available). */
async function loadTargets(): Promise<Target[]> {
  const [projects, research, conversations, assignments] = await Promise.all([
    projectsApi.list().catch(() => []), api.researchList().catch(() => []), api.conversations().catch(() => []),
    fetch("/api/assignments?workspaceId=default").then(r => (r.ok ? r.json() : []), () => []) as Promise<{ id: string; title: string }[]>
  ]);
  return [
    ...assignments.map(a => ({ type: "assignment" as const, id: a.id, label: a.title })),
    ...projects.map(p => ({ type: "project" as const, id: p.id, label: p.name })),
    ...research.map(r => ({ type: "research" as const, id: r.id, label: r.question })),
    ...conversations.slice(0, 30).map(c => ({ type: "conversation" as const, id: c.id, label: c.title }))
  ];
}

/** The workspace's uploaded files: upload, search and filter, preview, rename, attach, delete. */
export function FileLibrary() {
  const [docs, setDocs] = useState<DocumentView[] | null>(null);
  const [error, setError] = useState("");
  const [q, setQ] = useState("");
  const [kind, setKind] = useState("");
  const [status, setStatus] = useState("");
  const [targets, setTargets] = useState<Target[]>([]);
  const [attaching, setAttaching] = useState<string | null>(null);
  const refresh = useCallback(() => {
    api.documents({ q: q.trim(), kind, status }).then(list => { setDocs(list); setError(""); }, e => setError(e instanceof Error ? e.message : "Couldn't load files."));
  }, [q, kind, status]);
  const { uploads, add, remove } = useUploads(refresh);
  const drop = useFileDrop(add);
  useEffect(() => { const t = setTimeout(refresh, 200); return () => clearTimeout(t); }, [refresh]);
  useEffect(() => { void loadTargets().then(setTargets); }, []);
  // While anything is processing, the list refreshes so statuses move on without a reload.
  useEffect(() => {
    if (!docs?.some(d => d.status === "processing")) return;
    const t = setInterval(refresh, 4000);
    return () => clearInterval(t);
  }, [docs, refresh]);
  const active = uploads.filter(u => u.state !== "ready" && !(u.document && docs?.some(d => d.id === u.document!.id && d.status !== "processing")));
  const run = async (fn: () => Promise<unknown>) => { try { await fn(); refresh(); } catch (e) { setError(e instanceof Error ? e.message : "That didn't work."); } };
  const del = (d: DocumentView) => { if (confirm(`Delete "${documentTitle(d)}"? Answers that cited it keep their text but lose the link.`)) void run(() => api.deleteDocument(d.id)); };
  const rename = (d: DocumentView) => { const name = prompt("Display name (leave empty to use the file name)", documentTitle(d)); if (name !== null) void run(() => api.renameDocument(d.id, name.trim() || null)); };
  const targetLabel = (l: DocumentLinkView) => targets.find(t => t.type === l.type && t.id === l.targetId)?.label ?? typeLabel[l.type];

  return <section className="library files" {...drop.props}>
    <div className="eyebrow">FILES</div>
    <h2>Your files</h2>
    <p className="lede">Upload notes, readings, assignment briefs or code. Arbor reads them and cites the exact page, section or lines when it uses them. Attach files to a conversation, research project, assignment or code project to keep them together. Files stay on this machine.</p>
    <div className={`dropzone${drop.over ? " over" : ""}`}>
      <FileIcon size={22} />
      <div><strong>Drop files here</strong><small>PDF, Word, text, Markdown, JSON, CSV, HTML, code or images · up to {formatBytes(MAX_UPLOAD_BYTES)} each</small></div>
      <FilePickerButton onFiles={add} className="pill-button" label="Choose files" />
    </div>
    {active.length > 0 && <AttachmentChips uploads={active} onRemove={remove} />}
    <div className="library-controls">
      <label className="explorer-search grow"><SearchIcon size={12} /><input type="search" value={q} onChange={e => setQ(e.target.value)} placeholder="Search file names" aria-label="Search files" /></label>
      <select value={kind} onChange={e => setKind(e.target.value)} aria-label="Filter by kind"><option value="">All kinds</option>{Object.entries(documentKinds).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select>
      <select value={status} onChange={e => setStatus(e.target.value)} aria-label="Filter by status"><option value="">Any status</option><option value="ready">Ready</option><option value="processing">Processing</option><option value="failed">Failed</option></select>
    </div>
    {error && <div className="error" role="alert">{error}</div>}
    {docs && !docs.length && !uploads.length && <div className="setup-note">{q || kind || status ? "No files match these filters." : "No files yet."}</div>}
    {docs && docs.length > 0 && <div className="file-list" role="list">
      {docs.map(d => <div key={d.id} className="file-row" role="listitem">
        <span className="file-type">{typeName(d)}</span>
        <div className="file-main">
          <button type="button" className="file-name" onClick={() => openDocumentPreview(d.id)} disabled={d.status === "failed"} title="Preview">{documentTitle(d)}</button>
          <small>{d.displayName && d.displayName !== d.name ? `${d.name} · ` : ""}{documentKinds[d.kind] && d.kind !== "upload" ? `${documentKinds[d.kind]} · ` : ""}{formatBytes(d.sizeBytes)}{d.pageCount ? ` · ${d.pageCount} page${d.pageCount === 1 ? "" : "s"}` : ""}{d.chunkCount ? ` · ${d.chunkCount} passages` : ""} · {formatDate(d.createdAt)}</small>
          {d.status === "failed" && d.error && <small className="file-error">{d.error}</small>}
          {(d.links?.length ?? 0) > 0 && <div className="file-links">{d.links!.map(l => <span key={l.id} className="file-link">{typeLabel[l.type]}: {targetLabel(l)}<button type="button" onClick={() => void run(() => api.unlinkDocument(d.id, l.id))} aria-label="Detach"><CloseIcon size={10} /></button></span>)}</div>}
          {attaching === d.id && <div className="attach-row">
            <select autoFocus defaultValue="" aria-label="Attach to" onChange={e => { const t = targets[Number(e.target.value)]; if (t) { setAttaching(null); void run(() => api.linkDocument(d.id, t.type, t.id)); } }}>
              <option value="" disabled>Attach to…</option>
              {(["assignment", "project", "research", "conversation"] as const).map(type => targets.some(t => t.type === type) && <optgroup key={type} label={typeLabel[type]}>{targets.map((t, i) => t.type === type && <option key={`${t.type}-${t.id}`} value={i}>{t.label.slice(0, 80)}</option>)}</optgroup>)}
            </select>
            <button type="button" className="chip" onClick={() => setAttaching(null)}>Cancel</button>
          </div>}
        </div>
        <span className={`research-badge ${d.status === "ready" ? "completed" : d.status === "processing" ? "running" : "failed"}`}>{d.status === "ready" ? "Ready" : d.status === "processing" ? "Processing" : "Failed"}</span>
        <div className="file-actions">
          <button type="button" className="chip" onClick={() => rename(d)}>Rename</button>
          <button type="button" className="chip" onClick={() => setAttaching(a => (a === d.id ? null : d.id))} disabled={!targets.length}>Attach</button>
          <button type="button" className="icon-button" onClick={() => del(d)} aria-label={`Delete ${documentTitle(d)}`}><CloseIcon size={14} /></button>
        </div>
      </div>)}
    </div>}
  </section>;
}
