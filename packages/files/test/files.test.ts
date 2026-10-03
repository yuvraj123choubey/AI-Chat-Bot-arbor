import test from "node:test";
import assert from "node:assert/strict";
import { chunkDocument, detectFileType, parseDocument, retrieveChunks, UnsupportedFileError, EmptyDocumentError, type StoredChunk } from "../src/index.ts";
import { fakeEmbedder, makeDocx, makePdf } from "./fixtures.ts";

test("file types are checked against their content, not just their name", () => {
  assert.equal(detectFileType("notes.pdf", makePdf(["x"])).kind, "pdf");
  assert.equal(detectFileType("essay.docx", makeDocx([["A", "b"]])).kind, "docx");
  assert.equal(detectFileType("main.py", Buffer.from("print('hi')\n")).kind, "code");
  assert.equal(detectFileType("README.md", Buffer.from("# Title\n")).mimeType, "text/markdown; charset=utf-8");
  assert.throws(() => detectFileType("fake.pdf", Buffer.from("<html>not a pdf</html>")), UnsupportedFileError);
  assert.throws(() => detectFileType("tool.exe", Buffer.from("MZ...")), UnsupportedFileError);
  assert.throws(() => detectFileType("data.txt", Buffer.from([0x00, 0x01, 0xff])), UnsupportedFileError, "binary renamed to .txt");
  assert.equal(detectFileType("page.html", Buffer.from("<script>alert(1)</script>")).mimeType, "text/plain; charset=utf-8", "HTML is only ever served as text");
});

test("PDF text is read per page, so citations can name the page", async () => {
  const parsed = await parseDocument(makePdf(["Offline backups stop ransomware.", "Patching closes initial access."]), detectFileType("x.pdf", makePdf(["a"])), "x.pdf");
  assert.equal(parsed.pageCount, 2);
  assert.deepEqual(parsed.units.map(u => [u.page, u.text]), [[1, "Offline backups stop ransomware."], [2, "Patching closes initial access."]]);
});

test("DOCX headings become sections", async () => {
  const docx = makeDocx([["Grading", "Essays are worth 40 percent."], ["Late policy", "Ten percent off per day."]]);
  const parsed = await parseDocument(docx, detectFileType("s.docx", docx), "s.docx");
  assert.deepEqual(parsed.units.map(u => [u.section, u.text]), [["Grading", "Essays are worth 40 percent."], ["Late policy", "Ten percent off per day."]]);
});

test("Markdown keeps sections and line numbers; empty files are rejected clearly", async () => {
  const md = Buffer.from("# Intro\nhello\n\n## Setup\nnpm install\nnpm test\n```\n# not a heading\n```\n");
  const parsed = await parseDocument(md, detectFileType("r.md", md), "r.md");
  assert.deepEqual(parsed.units.map(u => [u.section, u.firstLine]), [["Intro", 1], ["Setup", 4]]);
  assert.match(parsed.units[1].text, /# not a heading/, "headings inside code fences are not sections");
  await assert.rejects(parseDocument(Buffer.from("   \n"), detectFileType("e.txt", Buffer.from(" ")), "e.txt"), EmptyDocumentError);
});

test("chunks never cross a page and line-based chunks keep exact line ranges", () => {
  const chunks = chunkDocument([{ text: "a ".repeat(800), page: 1 }, { text: "b", page: 2 }]);
  assert.ok(chunks.every(c => c.page === 1 || c.page === 2) && chunks.at(-1)!.page === 2 && chunks.at(-1)!.text === "b");
  const code = Array.from({ length: 150 }, (_, i) => `line ${i + 1}`).join("\n");
  const lines = chunkDocument([{ text: code, firstLine: 1 }]);
  assert.deepEqual(lines[0].lines, [1, 60]);
  assert.equal(lines.at(-1)!.lines![1], 150);
  for (const c of lines) assert.equal(c.text.split("\n")[0], `line ${c.lines![0]}`);
});

test("hybrid retrieval finds keyword and meaning matches and ignores unrelated text", async () => {
  const embedder = fakeEmbedder();
  const texts = ["The final exam is worth 40 percent of the grade.", "Office hours are Tuesdays in Coover 3043.", "CPRE 4300 covers TCP/IP and network security."];
  const vectors = await embedder.embed(texts);
  const chunks: StoredChunk[] = texts.map((text, i) => ({ id: `c${i}`, documentId: i < 2 ? "syllabus" : "catalog", text, embedding: vectors[i], page: i + 1 }));
  const [q] = await embedder.embed(["how much is the final exam worth"]);
  const hits = retrieveChunks("how much is the final exam worth", q, chunks);
  assert.equal(hits[0].id, "c0");
  const [code] = await embedder.embed(["CPRE 4300"]);
  assert.equal(retrieveChunks("CPRE 4300", code, chunks)[0].id, "c2");
  const [none] = await embedder.embed(["photosynthesis in plants"]);
  assert.deepEqual(retrieveChunks("photosynthesis in plants", none, chunks), []);
});
