import { useEffect, useRef } from "react";
import { EditorState, type Extension } from "@codemirror/state";
import { EditorView, keymap, lineNumbers, highlightActiveLine, highlightActiveLineGutter, drawSelection } from "@codemirror/view";
import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import { bracketMatching, foldGutter, indentOnInput, syntaxHighlighting, HighlightStyle } from "@codemirror/language";
import { highlightSelectionMatches, searchKeymap, search } from "@codemirror/search";
import { tags as t } from "@lezer/highlight";
import { javascript } from "@codemirror/lang-javascript";
import { html } from "@codemirror/lang-html";
import { css } from "@codemirror/lang-css";
import { python } from "@codemirror/lang-python";
import { json } from "@codemirror/lang-json";
import { markdown } from "@codemirror/lang-markdown";
import { java } from "@codemirror/lang-java";
import { cpp } from "@codemirror/lang-cpp";

/** Syntax support per file extension; unknown types are edited as plain text. */
export function languageFor(path: string): Extension {
  const ext = path.split(".").pop()?.toLowerCase() ?? "";
  if (["ts", "mts", "cts"].includes(ext)) return javascript({ typescript: true });
  if (ext === "tsx") return javascript({ typescript: true, jsx: true });
  if (["js", "mjs", "cjs"].includes(ext)) return javascript();
  if (ext === "jsx") return javascript({ jsx: true });
  if (["html", "htm", "vue", "svelte"].includes(ext)) return html();
  if (["css", "scss"].includes(ext)) return css();
  if (ext === "py") return python();
  if (ext === "json") return json();
  if (["md", "markdown"].includes(ext)) return markdown();
  if (ext === "java") return java();
  if (["c", "h", "cpp", "hpp", "cc", "cs"].includes(ext)) return cpp();
  return [];
}

const arborHighlight = HighlightStyle.define([
  { tag: [t.keyword, t.controlKeyword, t.moduleKeyword, t.operatorKeyword], color: "#5eead4" },
  { tag: [t.string, t.special(t.string), t.regexp], color: "#a7f3d0" },
  { tag: [t.number, t.bool, t.null, t.atom], color: "#fcd34d" },
  { tag: [t.comment, t.lineComment, t.blockComment], color: "#5f7a6a", fontStyle: "italic" },
  { tag: [t.function(t.variableName), t.function(t.propertyName)], color: "#67e8f9" },
  { tag: [t.typeName, t.className, t.namespace], color: "#86efac" },
  { tag: [t.tagName], color: "#5eead4" }, { tag: [t.attributeName], color: "#93c5fd" },
  { tag: [t.propertyName], color: "#d1fae5" }, { tag: [t.heading], color: "#fff", fontWeight: "700" },
  { tag: [t.link, t.url], color: "#67e8f9", textDecoration: "underline" }, { tag: t.invalid, color: "#fb7185" }
]);
const arborTheme = EditorView.theme({
  "&": { color: "#d6e6dc", backgroundColor: "#070b09", height: "100%", fontSize: "13px" },
  ".cm-content": { fontFamily: "'JetBrains Mono', Consolas, monospace", caretColor: "#34d399", padding: "10px 0" },
  ".cm-gutters": { backgroundColor: "#070b09", color: "#3f574a", border: "none", borderRight: "1px solid rgba(255,255,255,0.06)" },
  ".cm-activeLine": { backgroundColor: "rgba(52, 211, 153, 0.06)" },
  ".cm-activeLineGutter": { backgroundColor: "rgba(52, 211, 153, 0.08)", color: "#a7f3d0" },
  "&.cm-focused .cm-cursor": { borderLeftColor: "#34d399" },
  "&.cm-focused .cm-selectionBackground, .cm-selectionBackground, ::selection": { backgroundColor: "rgba(16, 185, 129, 0.28) !important" },
  ".cm-selectionMatch": { backgroundColor: "rgba(103, 232, 249, 0.14)" },
  ".cm-matchingBracket": { backgroundColor: "rgba(52, 211, 153, 0.25)", outline: "none" },
  ".cm-panels": { backgroundColor: "#0c1310", color: "#d6e6dc", borderColor: "rgba(255,255,255,0.08)" },
  ".cm-panel input, .cm-panel button": { fontFamily: "inherit" },
  ".cm-searchMatch": { backgroundColor: "rgba(251, 191, 36, 0.25)" },
  ".cm-foldGutter span": { color: "#3f574a" },
  ".cm-scroller": { overflow: "auto" }
}, { dark: true });

/**
 * CodeMirror 6 editor. The document is replaced when `path` changes (a different file) or when `value` changes
 * from outside (e.g. the agent edited the file); typing reports changes through `onChange`.
 */
export function CodeEditor({ path, value, readOnly, line, lineEnd, firstLine = 1, onChange, onSave }: { path: string; value: string; readOnly?: boolean; line?: number; lineEnd?: number; firstLine?: number; onChange?(text: string): void; onSave?(): void }) {
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);
  const callbacks = useRef({ onChange, onSave });
  callbacks.current = { onChange, onSave };
  useEffect(() => {
    const state = EditorState.create({
      doc: value,
      extensions: [
        lineNumbers({ formatNumber: n => String(n + firstLine - 1) }), highlightActiveLineGutter(), foldGutter(), history(), drawSelection(), indentOnInput(), bracketMatching(), highlightActiveLine(), highlightSelectionMatches(), search({ top: true }),
        keymap.of([{ key: "Mod-s", preventDefault: true, run: () => { callbacks.current.onSave?.(); return true; } }, indentWithTab, ...defaultKeymap, ...historyKeymap, ...searchKeymap]),
        syntaxHighlighting(arborHighlight), arborTheme, languageFor(path), EditorState.readOnly.of(Boolean(readOnly)), EditorView.editable.of(!readOnly),
        EditorView.updateListener.of(u => { if (u.docChanged) callbacks.current.onChange?.(u.state.doc.toString()); })
      ]
    });
    view.current = new EditorView({ state, parent: host.current! });
    return () => { view.current?.destroy(); view.current = null; };
    // The editor is rebuilt only for a different file or mode; content updates are applied below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path, readOnly, firstLine]);
  useEffect(() => {
    const v = view.current;
    if (v && v.state.doc.toString() !== value) v.dispatch({ changes: { from: 0, to: v.state.doc.length, insert: value } });
  }, [value]);
  // Jump to a line (from a search hit) once the document is in place.
  useEffect(() => {
    const v = view.current;
    // Lines are given in the file's own numbering; a slice that starts at firstLine is offset accordingly.
    const start = (line ?? 0) - firstLine + 1, end = Math.max(start, (lineEnd ?? line ?? 0) - firstLine + 1);
    if (!v || !line || start < 1 || start > v.state.doc.lines) return;
    const from = v.state.doc.line(start), to = v.state.doc.line(Math.min(end, v.state.doc.lines));
    v.dispatch({ selection: { anchor: from.from, head: to.to }, scrollIntoView: true });
    if (!readOnly) v.focus();
  }, [line, lineEnd, firstLine, path, readOnly]);
  return <div className="code-editor" ref={host} />;
}
