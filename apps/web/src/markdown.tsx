import React, { createContext, useContext, useState } from "react";

/** Numbered sources an answer may cite. Markers for any other number are hidden, never shown as citations. */
export interface Citations { ordinals: Set<number>; titles: Map<number, string>; onCite(ordinal: number): void }
const CitationContext = createContext<Citations | null>(null);

/**
 * Minimal Markdown for model answers: fenced code, headings, lists, quotes, tables, rules and inline
 * code/bold/italic/links/citations. Output is built from React elements, never raw HTML, so model text cannot
 * inject markup. Unclosed code fences render as code, which keeps partially streamed answers readable.
 */
export function Markdown({ text, citations }: { text: string; citations?: Citations }) {
  return <CitationContext.Provider value={citations ?? null}>{blocks(text)}</CitationContext.Provider>;
}
function Cite({ n, raw }: { n: number; raw: string }) {
  const citations = useContext(CitationContext);
  if (!citations) return <>{raw}</>;
  if (!citations.ordinals.has(n)) return null;
  return <button type="button" className="cite" title={citations.titles.get(n)} aria-label={`Source ${n}: ${citations.titles.get(n) ?? ""}`} onClick={() => citations.onCite(n)}>{n}</button>;
}

function blocks(text: string): React.ReactNode[] {
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  const out: React.ReactNode[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    const fence = line.match(/^\s*(```|~~~)\s*([\w+#.-]*)/);
    if (fence) {
      const body: string[] = [];
      i++;
      while (i < lines.length && !lines[i].trim().startsWith(fence[1])) body.push(lines[i++]);
      i++;
      out.push(<CodeBlock key={out.length} language={fence[2]} code={body.join("\n")} />);
      continue;
    }
    if (!line.trim()) { i++; continue; }
    const heading = line.match(/^(#{1,6})\s+(.*)$/);
    if (heading) {
      const Tag = `h${Math.min(heading[1].length + 2, 6)}` as "h3";
      out.push(<Tag key={out.length}>{inline(heading[2])}</Tag>);
      i++;
      continue;
    }
    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) { out.push(<hr key={out.length} />); i++; continue; }
    if (/^\s*>/.test(line)) {
      const quote: string[] = [];
      while (i < lines.length && /^\s*>/.test(lines[i])) quote.push(lines[i++].replace(/^\s*>\s?/, ""));
      out.push(<blockquote key={out.length}>{blocks(quote.join("\n"))}</blockquote>);
      continue;
    }
    if (/^\s*\|.*\|\s*$/.test(line) && /^\s*\|?\s*:?-{2,}/.test(lines[i + 1] || "")) {
      const cells = (row: string) => row.trim().replace(/^\||\|$/g, "").split("|").map(c => c.trim());
      const head = cells(line);
      i += 2;
      const rows: string[][] = [];
      while (i < lines.length && /^\s*\|/.test(lines[i])) rows.push(cells(lines[i++]));
      out.push(<div key={out.length} className="md-table"><table><thead><tr>{head.map((c, k) => <th key={k}>{inline(c)}</th>)}</tr></thead>
        <tbody>{rows.map((r, k) => <tr key={k}>{r.map((c, n) => <td key={n}>{inline(c)}</td>)}</tr>)}</tbody></table></div>);
      continue;
    }
    const listItem = /^\s*([-*+]|\d+[.)])\s+/;
    if (listItem.test(line)) {
      const ordered = /^\s*\d/.test(line);
      const sameKind = (l: string) => listItem.test(l) && /^\s*\d/.test(l) === ordered;
      const items: string[] = [];
      while (i < lines.length) {
        if (sameKind(lines[i])) items.push(lines[i].replace(listItem, ""));
        else if (/^\s{2,}\S/.test(lines[i]) && items.length) items[items.length - 1] += `\n${lines[i].trim()}`;
        // Models often put blank lines between items; the list continues if the next item follows.
        else if (!lines[i].trim() && sameKind(lines.slice(i + 1).find(l => l.trim()) ?? "")) { /* skip the blank line */ }
        else break;
        i++;
      }
      const start = ordered ? Number(line.match(/\d+/)![0]) : 1;
      const List = ordered ? "ol" : "ul";
      out.push(<List key={out.length} start={ordered && start !== 1 ? start : undefined}>{items.map((item, k) => <li key={k}>{withBreaks(item)}</li>)}</List>);
      continue;
    }
    const paragraph: string[] = [];
    while (i < lines.length && lines[i].trim() && !/^\s*(```|~~~|#{1,6}\s|>|([-*+]|\d+[.)])\s)/.test(lines[i])) paragraph.push(lines[i++]);
    if (!paragraph.length) paragraph.push(lines[i++]);
    out.push(<p key={out.length}>{withBreaks(paragraph.join("\n"))}</p>);
  }
  return out;
}
function withBreaks(text: string): React.ReactNode[] {
  return text.split("\n").flatMap((part, k) => k ? [<br key={`b${k}`} />, ...inline(part, `l${k}`)] : inline(part, `l${k}`));
}
function inline(text: string, prefix = "i"): React.ReactNode[] {
  // Underscores inside a word ("lab5_jlee_draft.pdf", snake_case) never mean emphasis, as in CommonMark.
  const pattern = /(`[^`]+`)|(\*\*[^*]+\*\*|(?<![A-Za-z0-9])__[^_]+__(?![A-Za-z0-9]))|(\*[^*\s][^*]*\*|(?<![A-Za-z0-9])_[^_\s][^_]*_(?![A-Za-z0-9]))|\[(\d{1,3})\](?!\()|\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g;
  const out: React.ReactNode[] = [];
  let last = 0;
  for (const m of text.matchAll(pattern)) {
    if (m.index! > last) out.push(text.slice(last, m.index));
    const key = `${prefix}${out.length}`;
    if (m[1]) out.push(<code key={key}>{m[1].slice(1, -1)}</code>);
    else if (m[2]) out.push(<strong key={key}>{inline(m[2].slice(2, -2), key)}</strong>);
    else if (m[3]) out.push(<em key={key}>{inline(m[3].slice(1, -1), key)}</em>);
    else if (m[4]) out.push(<Cite key={key} n={Number(m[4])} raw={m[0]} />);
    else out.push(<a key={key} href={m[6]} target="_blank" rel="noreferrer noopener">{m[5]}</a>);
    last = m.index! + m[0].length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}
/** A diff is shown with added and removed lines coloured; it is detected by language or by +/- line prefixes. */
function isDiff(language: string, code: string): boolean {
  if (/^(diff|patch)$/i.test(language)) return true;
  const lines = code.split("\n").filter(l => l.trim());
  return lines.length > 1 && /^(@@|--- |\+\+\+ )/m.test(code) && lines.every(l => /^[+\- @\\]/.test(l));
}
function CodeBlock({ language, code }: { language: string; code: string }) {
  const [copied, setCopied] = useState(false);
  const diff = isDiff(language, code);
  return <div className="md-code">
    <div className="md-code-bar">
      <span className="md-code-lang"><span className="md-code-dot" aria-hidden="true" />{diff && language !== "diff" ? `${language || "code"} · diff` : language || "code"}</span>
      <button type="button" onClick={() => navigator.clipboard.writeText(code).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1500); }, () => {})}>{copied ? "Copied" : "Copy"}</button>
    </div>
    <pre><code>{diff
      ? code.split("\n").map((line, i) => <span key={i} className={`diff-line${line.startsWith("+") && !line.startsWith("+++") ? " add" : line.startsWith("-") && !line.startsWith("---") ? " del" : line.startsWith("@@") ? " hunk" : ""}`}>{line}{"\n"}</span>)
      : code}</code></pre>
  </div>;
}
