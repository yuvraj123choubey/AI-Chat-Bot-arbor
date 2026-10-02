import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { canonicalUrl, classifySource, extractDoi } from "../src/url.ts";
import { splitPassages, selectEvidence, tokenize } from "../src/passages.ts";
import { citationClaims, parseMarker, sanitizeCitations } from "../src/citations.ts";
import { heuristicQueries, parseQueries, searchIntent } from "../src/intent.ts";
import { chooseProviders, gatherEvidence, mergeResults } from "../src/pipeline.ts";
import { extractHtml } from "../src/extract.ts";
import { reconstructAbstract } from "../src/providers/openalex.ts";
import { isPublicAddress, safeFetch } from "../src/net.ts";
import { groundedUserPrompt } from "../src/prompt.ts";
import type { RetrievedSource, SearchProvider, SearchResult } from "../src/types.ts";

const retrieved = (title: string, fullText: string, extra: Partial<RetrievedSource> = {}): RetrievedSource => ({
  url: `https://${title.toLowerCase().replace(/\W+/g, "")}.example/a`, canonicalUrl: `https://${title}.example/a`, title, domain: `${title}.example`,
  snippet: fullText.slice(0, 100), fullText, sourceType: "web", searchQuery: "q", readMode: "page", metadata: {}, ...extra
});

test("canonical URLs collapse tracking parameters, hosts, fragments and DOIs", () => {
  assert.equal(canonicalUrl("http://WWW.Example.com/a/b/?utm_source=x&b=2&a=1#frag"), "https://example.com/a/b?a=1&b=2");
  assert.equal(canonicalUrl("https://example.com/docs/index.html"), "https://example.com/docs");
  assert.equal(canonicalUrl("https://doi.org/10.1093/CYBSEC/tyz003"), canonicalUrl("https://dx.doi.org/10.1093/cybsec/tyz003"));
  assert.equal(extractDoi("doi: 10.1016/j.x.2021.100013."), "10.1016/j.x.2021.100013");
});

test("sources are classified by host", () => {
  assert.deepEqual(
    ["https://arxiv.org/abs/1", "https://www.cisa.gov/ransomware", "https://developer.mozilla.org/x", "https://www.reuters.com/a", "https://stackoverflow.com/q/1", "https://en.wikipedia.org/wiki/X", "https://github.com/o/r/issues/4", "https://blog.example.com"].map(classifySource),
    ["academic", "government", "documentation", "news", "forum", "encyclopedia", "forum", "web"]
  );
});

test("passages split on paragraphs and sentences without losing text", () => {
  const text = `${"Alpha sentence one. ".repeat(10)}\n\n${"Beta sentence two is longer. ".repeat(80)}\nGamma.`;
  const passages = splitPassages(text, 300, 500);
  assert.ok(passages.every(p => p.text.length <= 500));
  assert.ok(passages.length > 3);
  for (const p of passages) assert.ok(text.slice(p.start).startsWith(p.text.split("\n")[0].slice(0, 20)));
  assert.deepEqual(tokenize("The attackers attacked systems"), ["attacker", "attack", "system"]);
});

test("evidence keeps relevant sources only, ranks them, and numbers them from 1", () => {
  const sources = [
    retrieved("Cooking", "How to bake bread with yeast and flour."),
    retrieved("Backups", "Offline backups are the most effective defense against ransomware because encrypted files can be restored."),
    retrieved("Patching", "Patching known vulnerabilities reduces ransomware infections. Ransomware defense also relies on segmentation.")
  ];
  const evidence = selectEvidence(sources, "effective ransomware defense", [], { maxSources: 5, perSource: 2, maxPassages: 10 });
  assert.deepEqual(evidence.map(e => [e.ordinal, e.source.title]).map(([o]) => o), [1, 2]);
  assert.ok(evidence.every(e => e.source.title !== "Cooking"));
});

test("citations to unsupplied sources are removed and claims are mapped", () => {
  assert.deepEqual(parseMarker("1, 3-5"), [1, 3, 4, 5]);
  const answer = "Backups help [1]. Patching helps [2, 7]. Made up [9]. Code `arr[0]` stays.\n```js\nx[3] = 1\n```";
  const result = sanitizeCitations(answer, new Set([1, 2]));
  assert.equal(result.text, "Backups help [1]. Patching helps [2]. Made up. Code `arr[0]` stays.\n```js\nx[3] = 1\n```");
  assert.deepEqual(result.cited, [1, 2]);
  assert.deepEqual(result.removed, [7, 9]);
  assert.deepEqual(citationClaims(result.text, new Set([1, 2])), [{ ordinal: 1, claim: "Backups help." }, { ordinal: 2, claim: "Patching helps." }]);
});

test("search intent: explicit and factual questions search; code, writing and chit-chat do not", () => {
  const decide = (m: string) => searchIntent(m, "auto").search;
  assert.equal(decide("What are the latest ransomware attacks in 2026?"), true);
  assert.equal(decide("Find me sources on sleep and memory"), true);
  assert.equal(decide("Who won the 2022 World Cup final?"), true);
  assert.equal(decide("Debug this function that throws a TypeError"), false);
  assert.equal(decide("Write a poem about autumn"), false);
  assert.equal(decide("thanks!"), false);
  assert.equal(searchIntent("hello", "on").search, true);
  assert.equal(searchIntent("latest news", "off").search, false);
  assert.equal(searchIntent("Summarize the literature on remote work productivity", "auto").academic, true);
});

test("fallback queries drop filler; model queries are parsed defensively", () => {
  assert.deepEqual(heuristicQueries("Can you tell me what are the most effective defenses against ransomware?"), ["most effective defenses against ransomware"]);
  assert.deepEqual(heuristicQueries("what about Europe?", "How common is ransomware in the US?"), ["common is ransomware in the US Europe"]);
  assert.deepEqual(parseQueries('Sure! {"queries": ["a b", "a b", " c ", 3]}', 5), ["a b", "c"]);
  assert.deepEqual(parseQueries("not json", 3), []);
});

test("results from several queries and providers are merged by URL, DOI and title", () => {
  const r = (url: string, title: string, rank: number, query: string, extra: Partial<SearchResult> = {}): SearchResult => ({ url, title, snippet: "", provider: "p", query, rank, ...extra });
  const merged = mergeResults([
    r("https://example.com/a?utm_source=x", "Alpha report on things", 0, "q1"),
    r("https://www.example.com/a", "Alpha report on things", 3, "q2"),
    r("https://other.org/mirror", "Alpha report on things", 1, "q1"),
    r("https://doi.org/10.1234/xyz", "Paper", 0, "q1", { metadata: { doi: "https://doi.org/10.1234/XYZ" } }),
    r("https://publisher.com/paper", "Paper copy", 2, "q2", { metadata: { doi: "10.1234/xyz" } })
  ]);
  assert.equal(merged.length, 2);
  assert.deepEqual([...merged[0].queries].sort(), ["q1", "q2"]);
});

test("the pipeline searches, reads pages, and returns numbered evidence with status updates", async () => {
  const provider = (id: string, coverage: SearchProvider["coverage"], results: (q: string) => SearchResult[]): SearchProvider => ({ id, label: id, coverage, isConfigured: () => true, search: async q => results(q) });
  const web = provider("web", "web", q => [
    { url: "https://news.example/ransomware", title: "Ransomware defense guide", snippet: "Defense guide", provider: "web", query: q, rank: 0 },
    { url: "https://down.example/x", title: "Unreachable ransomware page", snippet: "Ransomware backups snippet only", provider: "web", query: q, rank: 1 }
  ]);
  const encyclopedia = provider("wiki", "encyclopedia", q => [{ url: "https://wiki.example/Ransomware", title: "Ransomware", snippet: "", provider: "wiki", query: q, rank: 0, fullText: "Ransomware is malware that encrypts files. ".repeat(50) }]);
  const fetched: string[] = [];
  const statuses: string[] = [];
  const result = await gatherEvidence({
    providers: [web, encyclopedia],
    fetch: async url => {
      fetched.push(url);
      if (url.includes("down")) throw new Error("offline");
      return { url, status: 200, contentType: "text/html", body: Buffer.from(`<html><head><title>Guide</title><meta name="author" content="A. Writer"><meta property="article:published_time" content="2025-05-01"></head><body><article><h1>Ransomware defense guide</h1>${"<p>Offline backups and patching are the core ransomware defenses for organisations of every size.</p>".repeat(8)}</article></body></html>`) };
    }
  }, { question: "ransomware defenses", queries: ["ransomware defenses"], academic: false, depth: "balanced", onStatus: s => statuses.push(s.stage) });
  assert.deepEqual(statuses, ["searching", "reading", "comparing"]);
  assert.ok(!fetched.some(u => u.includes("wiki")), "provider-supplied full text is not re-fetched");
  const guide = result.evidence.find(e => e.source.url === "https://news.example/ransomware")!;
  assert.equal(guide.source.readMode, "page");
  assert.equal(guide.source.author, "A. Writer");
  assert.equal(guide.source.publishedAt, "2025-05-01T00:00:00.000Z");
  const down = result.retrieved.find(s => s.url.includes("down"))!;
  assert.equal(down.readMode, "snippet");
  assert.deepEqual(result.evidence.map(e => e.ordinal), result.evidence.map((_, i) => i + 1));
  assert.match(groundedUserPrompt("Q?", result.evidence), /\[1\] [^\n]+\nhttps:\/\/[^\n]+\n<<<\n/);
  assert.ok(!guide.source.fullText.includes("guideOffline"), "block elements stay separated in extracted text");
});

test("provider choice discloses missing web search", () => {
  const p = (id: string, coverage: SearchProvider["coverage"], configured = true): SearchProvider => ({ id, label: id, coverage, isConfigured: () => configured, search: async () => [] });
  const without = chooseProviders([p("brave", "web", false), p("wiki", "encyclopedia"), p("openalex", "academic")], false);
  assert.deepEqual(without.chosen.map(x => x.id), ["wiki", "openalex"]);
  assert.equal(without.notices.length, 1);
  const withWeb = chooseProviders([p("brave", "web"), p("wiki", "encyclopedia"), p("openalex", "academic")], false);
  assert.deepEqual(withWeb.chosen.map(x => x.id), ["brave", "wiki"]);
});

test("HTML extraction finds main text and metadata; OpenAlex abstracts are rebuilt", () => {
  const page = extractHtml(`<html><head><title>T</title><link rel="canonical" href="/canon"><script type="application/ld+json">{"@type":"NewsArticle","datePublished":"2024-02-03","author":{"name":"J. Doe"},"publisher":{"name":"Daily"}}</script></head><body><nav>Menu Menu</nav><article>${"<p>Real article content sentence here.</p>".repeat(20)}</article><footer>Footer</footer></body></html>`, "https://site.example/a/b");
  assert.equal(page.author, "J. Doe");
  assert.equal(page.publisher, "Daily");
  assert.equal(page.canonical, "https://site.example/canon");
  assert.ok(page.text.includes("Real article content") && !page.text.includes("Menu Menu"));
  assert.equal(reconstructAbstract({ world: [1], hello: [0], again: [2] }), "hello world again");
});

test("the fetcher refuses private and loopback addresses, including via redirects", async () => {
  assert.equal(isPublicAddress("10.1.2.3"), false);
  assert.equal(isPublicAddress("::ffff:127.0.0.1"), false);
  assert.equal(isPublicAddress("fd00::1"), false);
  assert.equal(isPublicAddress("8.8.8.8"), true);
  const server = createServer((_, res) => res.end("internal secret")).listen(0, "127.0.0.1");
  await new Promise(r => server.once("listening", r));
  const { port } = server.address() as { port: number };
  try {
    await assert.rejects(safeFetch(`http://127.0.0.1:${port}/`), /non-public/);
    await assert.rejects(safeFetch(`http://localhost:${port}/`), /non-public|fetch failed/);
  } finally { server.close(); }
});
