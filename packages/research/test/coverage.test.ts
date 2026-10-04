import test from "node:test";
import assert from "node:assert/strict";
import { evidenceCoverage, gapNote, gapQueries, RESEARCH_AGAIN_BELOW } from "../src/coverage.ts";
import type { EvidenceSource } from "../src/types.ts";

const source = (title: string, text: string): EvidenceSource => ({
  ordinal: 1, passages: [{ text, start: 0, score: 1 }],
  source: { url: "https://x.test", canonicalUrl: "https://x.test", title, domain: "x.test", snippet: "", fullText: text, sourceType: "web", searchQuery: "", readMode: "page", metadata: {} }
});

test("coverage finds the parts of a question the sources miss, and aims the next search at them", () => {
  const question = "What did the Zephyr-9 rover find on Europa's ice shelf?";
  const thin = [source("Europa", "Europa is a moon of Jupiter with an ice shelf over a subsurface ocean.")];
  const gap = evidenceCoverage(question, thin);
  assert.ok(gap.coverage < RESEARCH_AGAIN_BELOW, `coverage ${gap.coverage}`);
  assert.ok(gap.missing.some(t => t.startsWith("zephyr")) && gap.missing.some(t => t.startsWith("rover")), gap.missing.join(","));
  const queries = gapQueries(question, gap, ["Europa ice shelf"]);
  assert.ok(queries.length >= 1);
  assert.match(queries[0], /Zephyr-9/, "the user's own spelling of the missing name is searched");
  assert.match(queries[0], /Europa/i, "the search stays on the same subject");
  assert.match(gapNote(gap, question), /none of the sources mention "Zephyr-9"/);
  const full = evidenceCoverage(question, [...thin, source("Zephyr-9 mission", "The Zephyr-9 rover found salt deposits on the ice shelf.")]);
  assert.equal(full.missing.length, 0);
  assert.equal(gapNote(full, question), "");
});

test("an event no source mentions is reported as not found, never written around", async () => {
  const { eventNotFound, notFoundAnswer } = await import("../src/coverage.ts");
  const question = "what happened during the zorblax airways flight 4417 emergency landing in reykjavik in 2019?";
  const gap = evidenceCoverage(question, [source("List of air rage incidents", "In 2019 a passenger on a flight to Reykjavik was restrained after an emergency landing.")]);
  assert.ok(gap.missing.includes("4417") && gap.missing.includes("zorblax"), gap.missing.join(","));
  assert.equal(eventNotFound(gap, 0), true);
  assert.equal(eventNotFound(gap, 1), false, "an identified event is never reported as not found");
  const text = notFoundAnswer(question, gap, { queries: ["zorblax airways flight 4417"], sources: 6 });
  assert.match(text, /^I couldn't find any record of this\. I searched for "zorblax airways flight 4417" and read 6 sources, and none of them mention "4417", "zorblax"/);
  assert.match(notFoundAnswer(question, gap, { queries: ["zorblax 4417"], sources: 0 }), /^I couldn't find any record of this\. I searched for "zorblax 4417", and none of the searches returned a source about it\./);
  assert.equal(eventNotFound(evidenceCoverage("ever given suez canal 2021", [source("Ever Given", "The Ever Given blocked the Suez Canal in March 2021.")]), 0), false);
});
