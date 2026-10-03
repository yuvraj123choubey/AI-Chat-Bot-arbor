import { useCallback, useEffect, useRef, useState } from "react";
import { api, formatBytes, MAX_UPLOAD_BYTES, ndjsonEvents, UPLOAD_ACCEPT, type DocumentView } from "../api.ts";
import { CloseIcon, FileIcon, PlusIcon } from "./Icons.tsx";

export type UploadState = "uploading" | "processing" | "ready" | "failed";
export interface Upload { key: string; name: string; sizeBytes: number; state: UploadState; detail?: string; document?: DocumentView; error?: string }

/** Follows a document's ingest task until it is ready or failed, reporting each stage (parsing, chunking, embedding). */
async function followIngest(taskId: string, onStage: (label: string) => void, signal: AbortSignal): Promise<void> {
  const response = await api.taskEvents(taskId, signal);
  if (!response.ok) return;
  for await (const event of ndjsonEvents(response)) {
    if (event.type === "progress" && event.label) onStage(event.detail ? `${event.label} · ${event.detail}` : event.label);
    if (event.type === "status" && ["completed", "failed", "cancelled"].includes(event.status)) return;
    if (event.type === "snapshot" && ["completed", "failed", "cancelled"].includes(event.status)) return;
  }
}

/**
 * Uploads files and tracks each one through processing. A file already in the library comes back immediately
 * (no task). Problems that can be caught here (too large) are reported without uploading.
 */
export function useUploads(onChange?: () => void) {
  const [uploads, setUploads] = useState<Upload[]>([]);
  const aborts = useRef(new Map<string, AbortController>());
  useEffect(() => () => { for (const a of aborts.current.values()) a.abort(); }, []);
  const patch = useCallback((key: string, change: Partial<Upload>) => setUploads(list => list.map(u => (u.key === key ? { ...u, ...change } : u))), []);

  const add = useCallback(async (files: File[]) => {
    for (const file of files) {
      const key = `${file.name}-${file.size}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
      if (file.size > MAX_UPLOAD_BYTES) {
        setUploads(list => [...list, { key, name: file.name, sizeBytes: file.size, state: "failed", error: `Larger than ${formatBytes(MAX_UPLOAD_BYTES)}` }]);
        continue;
      }
      setUploads(list => [...list, { key, name: file.name, sizeBytes: file.size, state: "uploading", detail: "Uploading" }]);
      const abort = new AbortController();
      aborts.current.set(key, abort);
      try {
        const { document, taskId } = await api.uploadDocument(file);
        patch(key, { document, state: document.status === "ready" ? "ready" : document.status === "failed" ? "failed" : "processing", detail: document.status === "processing" ? "Processing" : undefined, error: document.error ?? undefined });
        if (taskId && document.status === "processing") {
          await followIngest(taskId, label => patch(key, { detail: label }), abort.signal).catch(() => {});
          const finished = await api.document(document.id);
          patch(key, { document: finished, state: finished.status === "ready" ? "ready" : finished.status === "failed" ? "failed" : "processing", detail: undefined, error: finished.error ?? undefined });
        }
      } catch (error) {
        if (!abort.signal.aborted) patch(key, { state: "failed", error: error instanceof Error ? error.message : "Upload failed" });
      } finally {
        aborts.current.delete(key);
        onChange?.();
      }
    }
  }, [patch, onChange]);
  const remove = useCallback((key: string) => {
    aborts.current.get(key)?.abort();
    setUploads(list => list.filter(u => u.key !== key));
  }, []);
  const clear = useCallback(() => setUploads([]), []);
  return { uploads, add, remove, clear };
}

const stateLabel: Record<UploadState, string> = { uploading: "Uploading", processing: "Processing", ready: "Ready", failed: "Failed" };

/** Files attached to the next message, shown above the message box. */
export function AttachmentChips({ uploads, onRemove }: { uploads: Upload[]; onRemove(key: string): void }) {
  if (!uploads.length) return null;
  return <div className="attachments" aria-label="Attached files">
    {uploads.map(u => <span key={u.key} className={`attachment ${u.state}`} title={u.error ?? u.detail ?? stateLabel[u.state]}>
      <FileIcon size={13} />
      <span className="attachment-name">{u.name}</span>
      <span className="attachment-state">{u.state === "failed" ? u.error ?? "Failed" : u.state === "ready" ? formatBytes(u.sizeBytes) : u.detail ?? stateLabel[u.state]}</span>
      <button type="button" onClick={() => onRemove(u.key)} aria-label={`Remove ${u.name}`}><CloseIcon size={11} /></button>
    </span>)}
  </div>;
}

/** A hidden file input plus a visible button that opens it. */
export function FilePickerButton({ onFiles, className = "icon-button", label, disabled }: { onFiles(files: File[]): void; className?: string; label?: string; disabled?: boolean }) {
  const input = useRef<HTMLInputElement>(null);
  return <>
    <input ref={input} type="file" multiple accept={UPLOAD_ACCEPT} hidden onChange={e => { const files = [...(e.target.files ?? [])]; e.target.value = ""; if (files.length) onFiles(files); }} />
    <button type="button" className={className} onClick={() => input.current?.click()} disabled={disabled} aria-label={label ?? "Attach files"} title="Attach PDF, Word, text, Markdown, code or images">
      {label ? <><PlusIcon size={13} /> {label}</> : <FileIcon size={15} />}
    </button>
  </>;
}

/** Drag-and-drop target behaviour for any element: returns props and whether files are being dragged over it. */
export function useFileDrop(onFiles: (files: File[]) => void) {
  const [over, setOver] = useState(false);
  const depth = useRef(0);
  const hasFiles = (e: React.DragEvent) => [...e.dataTransfer.types].includes("Files");
  return {
    over,
    props: {
      onDragEnter: (e: React.DragEvent) => { if (!hasFiles(e)) return; e.preventDefault(); depth.current++; setOver(true); },
      onDragOver: (e: React.DragEvent) => { if (hasFiles(e)) e.preventDefault(); },
      onDragLeave: () => { depth.current = Math.max(0, depth.current - 1); if (!depth.current) setOver(false); },
      onDrop: (e: React.DragEvent) => { if (!hasFiles(e)) return; e.preventDefault(); depth.current = 0; setOver(false); const files = [...e.dataTransfer.files]; if (files.length) onFiles(files); }
    }
  };
}


