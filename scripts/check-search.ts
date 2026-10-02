/** Live check of the research pipeline (no model calls): `npm run check:search -- "your question"`. */
import "../apps/api/src/setup-env.ts";
import { gatherEvidence } from "../packages/research/src/pipeline.ts";
import { heuristicQueries, searchIntent } from "../packages/research/src/intent.ts";
import { searchProviders } from "../packages/research/src/index.ts";

const question = process.argv.slice(2).join(" ") || "What are the most effective defenses against ransomware?";
const intent = searchIntent(question, "auto");
const queries = heuristicQueries(question);
console.log(`Question: ${question}\nIntent: search=${intent.search} academic=${intent.academic} fresh=${intent.fresh} technical=${intent.technical} (${intent.reason})\nQueries: ${queries.join(" | ")}\n`);
const started = Date.now();
const result = await gatherEvidence({ providers: searchProviders() }, { question, queries, focus: intent, depth: "balanced", onStatus: s => console.log(`… ${s.label}${s.detail ? `: ${s.detail}` : ""}`) });
console.log(`\nProviders: ${result.providers.join(", ")} · read ${result.retrieved.length} · ${Date.now() - started}ms`);
for (const n of result.notices) console.log(`Notice: ${n}`);
for (const e of result.evidence) {
  const s = e.source;
  console.log(`\n[${e.ordinal}] ${s.title}\n    ${s.url}\n    ${s.sourceType} · ${s.readMode} · ${s.publisher || s.domain}${s.publishedAt ? ` · ${s.publishedAt.slice(0, 10)}` : ""}${s.author ? ` · ${s.author}` : ""}`);
  for (const p of e.passages) console.log(`    > (${p.score.toFixed(1)}) ${p.text.replace(/\s+/g, " ").slice(0, 160)}…`);
}
