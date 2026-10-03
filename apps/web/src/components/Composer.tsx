import { useEffect, useId, useRef, useState } from "react";
import type { Level, Model, SearchMode, SearchScope } from "../api.ts";
import { ArrowIcon, ChevronIcon, CompassIcon, FileIcon, GlobeIcon, LayersIcon, MicIcon, StopIcon } from "./Icons.tsx";
import { AttachmentChips, FilePickerButton, useFileDrop, type Upload } from "./Files.tsx";

const levelLabel: Record<Level, string> = { fast: "Fast", balanced: "Balanced", deep: "Deep" };
const searchLabel: Record<SearchMode, string> = { auto: "Auto", on: "Always", off: "Off" };
const nextLevel: Record<Level, Level> = { fast: "balanced", balanced: "deep", deep: "fast" };
const nextSearch: Record<SearchMode, SearchMode> = { auto: "on", on: "off", off: "auto" };
const scopeLabel: Record<SearchScope, string> = { auto: "Auto", web: "Web", files: "Files", both: "Web + Files" };
const nextScope: Record<SearchScope, SearchScope> = { auto: "web", web: "files", files: "both", both: "auto" };
const capabilityText = (m: Model) => m.capabilities.filter(c => c !== "fast").slice(0, 3).join(" · ") || "general";

export interface ComposerProps {
  value: string; onChange(value: string): void; onSend(): void; onStop(): void;
  streaming: boolean; disabled: boolean; placeholder: string;
  models: Model[]; choice: string; onChoice(id: string): void;
  level: Level; onLevel(level: Level): void;
  search: SearchMode; onSearch(mode: SearchMode): void;
  onDeepResearch(): void;
  scope: SearchScope; onScope(scope: SearchScope): void;
  uploads: Upload[]; onAttach(files: File[]): void; onRemoveUpload(key: string): void;
}

/** The floating glass input: mode chips, the message box, model picker, dictation and send/stop. */
export function Composer(p: ComposerProps) {
  const area = useRef<HTMLTextAreaElement>(null);
  // The box grows with its content up to a limit, then scrolls.
  useEffect(() => {
    const el = area.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 220)}px`;
  }, [p.value]);
  const drop = useFileDrop(p.onAttach);
  // Attached files must finish processing before the message can use them.
  const waiting = p.uploads.some(u => u.state === "uploading" || u.state === "processing");
  return <div className={`composer-card${drop.over ? " dropping" : ""}`} {...drop.props}>
    {drop.over && <div className="drop-hint">Drop files to attach them</div>}
    <AttachmentChips uploads={p.uploads} onRemove={p.onRemoveUpload} />
    <div className="chip-row" role="group" aria-label="Answer settings">
      <button type="button" className={`chip${p.search !== "off" ? " on" : ""}`} onClick={() => p.onSearch(nextSearch[p.search])} title="Auto searches when a question needs facts; Always searches every message; Off never searches">
        <GlobeIcon size={12} /> Web search · {searchLabel[p.search]}
      </button>
      <button type="button" className={`chip${p.scope !== "auto" ? " on" : ""}`} onClick={() => p.onScope(nextScope[p.scope])} title="Where answers look for evidence: the web, your uploaded files, or both (Auto decides from the question)">
        <FileIcon size={12} /> Sources · {scopeLabel[p.scope]}
      </button>
      <button type="button" className={`chip${p.level === "deep" ? " on" : ""}`} onClick={() => p.onLevel(nextLevel[p.level])} title="Fast keeps answers short; Deep uses a reasoning model and a larger budget">
        <LayersIcon size={12} /> Reasoning · {levelLabel[p.level]}
      </button>
      <button type="button" className="chip" onClick={p.onDeepResearch} title="Multi-step research with a cited report">
        <CompassIcon size={12} /> Deep research
      </button>
    </div>
    <textarea ref={area} rows={2} value={p.value} placeholder={p.placeholder} aria-label="Message"
      onChange={e => p.onChange(e.target.value)}
      onKeyDown={e => { if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); if (!p.streaming && !waiting) p.onSend(); } }} />
    <div className="composer-bar">
      <ModelPicker models={p.models} choice={p.choice} onChoice={p.onChoice} />
      <div className="composer-actions">
        {waiting && <span className="composer-wait">Processing files…</span>}
        <FilePickerButton onFiles={p.onAttach} />
        <Dictation onText={text => p.onChange(p.value ? `${p.value.trimEnd()} ${text}` : text)} />
        {p.streaming
          ? <button type="button" className="send stop" onClick={p.onStop}><StopIcon size={13} /> Stop</button>
          : <button type="button" className="send" disabled={p.disabled || !p.value.trim() || waiting} onClick={p.onSend}>Send <ArrowIcon size={14} /></button>}
      </div>
    </div>
  </div>;
}

/** Model menu listing only models the server reports as configured; "Auto" lets the router decide. */
export function ModelPicker({ models, choice, onChoice }: { models: Model[]; choice: string; onChoice(id: string): void }) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const listId = useId();
  useEffect(() => {
    if (!open) return;
    const away = (e: PointerEvent) => { if (!root.current?.contains(e.target as Node)) setOpen(false); };
    const key = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    window.addEventListener("pointerdown", away);
    window.addEventListener("keydown", key);
    return () => { window.removeEventListener("pointerdown", away); window.removeEventListener("keydown", key); };
  }, [open]);
  const selected = models.find(m => m.id === choice);
  const pick = (id: string) => { onChoice(id); setOpen(false); };
  const groups = [...new Set(models.map(m => m.providerLabel))];
  return <div className="picker" ref={root}>
    <button type="button" className="picker-button" aria-haspopup="listbox" aria-expanded={open} aria-controls={listId} onClick={() => setOpen(o => !o)} disabled={!models.length}>
      <span className={`dot${models.length ? "" : " off"}`} />
      <span className="picker-label">{selected ? selected.displayName : "Auto"}<small>{selected ? selected.providerLabel : "Arbor picks the model"}</small></span>
      <ChevronIcon size={12} />
    </button>
    {open && <div className="picker-menu" role="listbox" id={listId} aria-label="Model">
      <button type="button" role="option" aria-selected={choice === "auto"} className="picker-option" onClick={() => pick("auto")}>
        <span><strong>Auto</strong><small>Routes each message to a suitable model</small></span>{choice === "auto" && <span className="tick">✓</span>}
      </button>
      {groups.map(g => <div key={g} className="picker-group">
        <div className="picker-group-label">{g}</div>
        {models.filter(m => m.providerLabel === g).map(m => <button key={m.id} type="button" role="option" aria-selected={choice === m.id} className="picker-option" onClick={() => pick(m.id)}>
          <span><strong>{m.displayName}</strong><small>{m.modelId} · {capabilityText(m)}</small></span>{choice === m.id && <span className="tick">✓</span>}
        </button>)}
      </div>)}
    </div>}
  </div>;
}

type Recognition = { lang: string; interimResults: boolean; continuous: boolean; start(): void; stop(): void; onresult: ((e: any) => void) | null; onend: (() => void) | null; onerror: ((e: any) => void) | null };
const RecognitionClass = ((window as any).SpeechRecognition || (window as any).webkitSpeechRecognition) as (new () => Recognition) | undefined;

/** Browser dictation, shown only where the browser provides speech recognition. */
function Dictation({ onText }: { onText(text: string): void }) {
  const [listening, setListening] = useState(false);
  const recognition = useRef<Recognition | null>(null);
  const latest = useRef(onText);
  latest.current = onText;
  useEffect(() => () => recognition.current?.stop(), []);
  const Speech = RecognitionClass;
  if (!Speech) return null;
  function toggle() {
    if (listening) { recognition.current?.stop(); return; }
    const r: Recognition = new Speech!();
    r.lang = navigator.language || "en-US";
    r.interimResults = false;
    r.continuous = false;
    r.onresult = e => { const text = Array.from(e.results as ArrayLike<any>).map(x => x[0].transcript).join(" ").trim(); if (text) latest.current(text); };
    r.onend = () => setListening(false);
    r.onerror = () => setListening(false);
    recognition.current = r;
    r.start();
    setListening(true);
  }
  return <button type="button" className={`icon-button mic${listening ? " live" : ""}`} onClick={toggle} aria-pressed={listening}
    title={listening ? "Stop dictation" : "Dictate (uses your browser's speech recognition)"} aria-label={listening ? "Stop dictation" : "Dictate"}>
    {listening ? <span className="wave"><i /><i /><i /></span> : <MicIcon size={15} />}
  </button>;
}
