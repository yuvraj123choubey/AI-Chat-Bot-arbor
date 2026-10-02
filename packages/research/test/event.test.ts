import test from "node:test";
import assert from "node:assert/strict";
import { applySuggestion } from "../src/normalize.ts";
import { searchIntent } from "../src/intent.ts";
import { fallbackQueries, findAnchors, keyTerms, leadDate } from "../src/resolve.ts";
import { parseFacts, sourcesForExtraction, factSheetBlock } from "../src/facts.ts";
import { enforcePrecision, ensureUnidentified } from "../src/precision.ts";
import type { EvidenceSource, RetrievedSource } from "../src/types.ts";

// Text from the Wikipedia article on Flydubai Flight 1073 (as retrieved on 2026-10-02).
const article = `Flydubai Flight 1073 was a regularly scheduled international passenger flight operated by Flydubai from Dubai International Airport in the United Arab Emirates (UAE) to Ben Gurion Airport near Tel Aviv, Israel. On 30 September 2026, while en route, the Boeing 737 MAX 8 broadcast the squawk code for a hijacking, diverted from its flight path, and made an emergency landing at Prince Sultan bin Abdulaziz Airport in Tabuk, Saudi Arabia.
The aircraft involved in the incident was a Boeing 737 MAX 8, registered A6-FKF.
There were 174 passengers including 150 Israeli citizens and six crew members onboard.
The crew consisted of two pilots: an Indian captain, Smit Machchhar, who was the pilot flying, and an Omani first officer performing pilot monitoring.
Flight 1073 departed from Dubai at 7:05 a.m. (GST) traveling west to Tel Aviv.
According to passenger reports, the first officer stabbed and seriously wounded the captain during the flight in an apparent attempt to hijack and crash the plane.
The plane landed safely at Prince Sultan bin Abdulaziz Airport in Tabuk, in northwestern Saudi Arabia at 10:45 a.m. GST (9:45 a.m. local time).
Netanyahu and Indian Prime Minister Narendra Modi both praised the captain, Smit Machchhar.`;
const source = (title: string, text: string, n = 1): EvidenceSource => {
  const s: RetrievedSource = { url: `https://en.wikipedia.org/wiki/${title.replace(/ /g, "_")}`, canonicalUrl: `https://en.wikipedia.org/wiki/${title.replace(/ /g, "_")}`, title, domain: "en.wikipedia.org", snippet: text.slice(0, 200), fullText: text, sourceType: "encyclopedia", searchQuery: "q", readMode: "page", metadata: {} };
  return { ordinal: n, source: s, passages: [{ text, start: 0, score: 1 }] };
};
const fz = source("Flydubai Flight 1073", article);
const list = source("List of aircraft hijackings", "On 6 September 1970, El Al Flight 219 from Amsterdam to New York was attacked by the PFLP. Swissair Flight 100 from Zürich was hijacked.", 2);

test("regression: misspelled place names are corrected word by word, real words are kept", () => {
  assert.deepEqual(applySuggestion("hijack part dubai to telaviv", "hijack park dubai to tel aviv"), { text: "hijack part dubai to tel aviv", corrections: [{ from: "telaviv", to: "tel aviv" }] });
  assert.equal(applySuggestion("hijack part dubai to telaviiv", "hijack park dubai to tel aviv").text, "hijack part dubai to tel aviv");
  assert.equal(applySuggestion("tell me about fly dubai case", "tell me about flydubai case").text, "tell me about flydubai case");
  assert.equal(applySuggestion("photosynthesis in plants", undefined).text, "photosynthesis in plants");
});

test("regression: lowercase event questions are searched as events", () => {
  for (const q of ["hijack part dubai to tel aviv", "tell me about flydubai case", "what happened in the bank robbery case yesterday"]) {
    const intent = searchIntent(q, "auto");
    assert.equal(intent.search, true, q);
    assert.equal(intent.event, true, q);
  }
  assert.equal(searchIntent("write a short story about a hijacking", "auto").search, false);
  assert.equal(searchIntent("hi there", "auto").event, false);
});

test("regression: the specific event page is the anchor, not a page about a place that merely mentions it", () => {
  const q = "hijack part dubai to tel aviv";
  assert.deepEqual(keyTerms(q), ["hijack", "dubai", "tel", "aviv"]);
  const airport = { title: "Dubai International Airport", url: "u1", text: "Dubai International Airport is the primary international airport serving Dubai, United Arab Emirates, and the busiest airport in the world by international passenger traffic. Flights to Tel Aviv began in 2020." };
  const anchors = findAnchors(q, [airport, { title: "Flydubai Flight 1073", url: "u2", text: article }, { title: "List of aircraft hijackings", url: "u3", text: list.source.fullText }]);
  assert.deepEqual(anchors.map(a => a.title), ["Flydubai Flight 1073"]);
  assert.equal(anchors[0].date, "2026-09-30");
  assert.equal(leadDate("on September 30, 2026 the plane"), "2026-09-30");
  assert.deepEqual(fallbackQueries(q, [q]), ["dubai tel aviv hijacking", "dubai tel aviv"]);
});

test("regression: several equally good events are listed newest first; the bare name page is not an event", () => {
  const anchors = findAnchors("tell me about flydubai case", [
    { title: "Flydubai", url: "a", text: "Flydubai is an airline based in Dubai." },
    { title: "Flydubai Flight 981", url: "b", text: "Flydubai Flight 981 crashed on 19 March 2016 at Rostov-on-Don." },
    { title: "Flydubai Flight 1073", url: "c", text: article }
  ]);
  assert.deepEqual(anchors.map(a => a.title), ["Flydubai Flight 1073", "Flydubai Flight 981"]);
});

test("regression: extraction keeps only details the cited source states, and never invents a name", () => {
  const raw = [
    "FACT | Identifier | Flight 1073 | 1",
    "FACT | Registration | A6-FKF | 1",
    "FACT | Aircraft or vehicle type | Boeing 737 MAX 8 | 2",
    "FACT | Date | 30 September 2026 | 1",
    "FACT | Origin | NOT STATED | 1",
    "FACT | Injuries or deaths | 24 dead | 1",
    "PERSON | captain | Smit Machchhar | 1",
    "PERSON | first officer | NOT NAMED | 1",
    "PERSON | first officer | Ahmed Al-Balushi | 1",
    "PERSON | passengers | NOT NAMED | 1",
    "TIME | 7:05 a.m. GST | departed from Dubai | 1",
    "SAID | Narendra Modi | praised the captain | 1",
    "FACT | Outcome | reportedly: the first officer stabbed and seriously wounded the captain | 1",
    "OPEN | Motive of the first officer"
  ].join("\n");
  const sheet = parseFacts(raw, [fz, list]);
  const show = sheet.facts.map(f => `${f.kind}:${f.label}=${f.value}:${f.status}:${f.sources.join(",")}`);
  assert.deepEqual(show, [
    "fact:Identifier=Flight 1073:known:1",
    "fact:Registration=A6-FKF:known:1",
    "fact:Aircraft or vehicle type=Boeing 737 MAX 8:known:1",
    "fact:Date=30 September 2026:known:1",
    "person:captain=Smit Machchhar:known:1",
    "person:first officer=NOT NAMED:not_identified:1",
    "time:7:05 a.m. GST=departed from Dubai:known:1",
    "said:Narendra Modi=praised the captain:reported:1",
    "fact:Outcome=the first officer stabbed and seriously wounded the captain:reported:1",
    "open:Open question=Motive of the first officer:unknown:"
  ]);
  // The invented name and the unsupported death toll are dropped; the aircraft was moved to the source that states it.
  assert.deepEqual(sheet.dropped.map(d => d.line), ["FACT | Injuries or deaths | 24 dead | 1", "PERSON | first officer | Ahmed Al-Balushi | 1"]);
  assert.match(factSheetBlock(sheet), /first officer: NOT PUBLICLY IDENTIFIED/);
  assert.deepEqual(sourcesForExtraction([fz, list], [{ title: "Flydubai Flight 1073", url: fz.source.url, coverage: 1 }]).map(e => e.ordinal), [1]);
});

test("regression: answer precision — citations must support the detail, invented names and quotes are removed", () => {
  const answer = [
    "Flydubai Flight 1073 diverted to Tabuk on 30 September 2026 [1].",
    "The aircraft carried 174 passengers [2].",
    "There were 24 other passengers aboard [1].",
    "The first officer, Ahmed Al-Balushi, was arrested [1].",
    "Israeli officials praised his \"extraordinary bravery under fire\" [1].",
    "Saudi Arabia refused to allow Israeli military rescue aircraft into its territory over diplomatic disputes [1].",
    "## People involved",
    "- **Captain**: Smit Machchhar [1]."
  ].join("\n");
  const result = enforcePrecision(answer, [fz, list], "hijack part dubai to tel aviv");
  assert.equal(result.text, [
    "Flydubai Flight 1073 diverted to Tabuk on 30 September 2026 [1].",
    "The aircraft carried 174 passengers [1].",
    "There were 24 other passengers aboard.",
    "",
    "",
    "Saudi Arabia refused to allow Israeli military rescue aircraft into its territory over diplomatic disputes.",
    "## People involved",
    "- **Captain**: Smit Machchhar [1]."
  ].join("\n").replace(/\n{3,}/g, "\n\n"));
  assert.equal(result.recited, 1);
  assert.equal(result.droppedSentences.length, 2);
  // Word overlap alone cannot prove this invented claim false; it loses its citation here and is left to model verification.
  assert.equal(result.uncited, 2);
});

test("regression: an unnamed person is always reported as not identified", () => {
  const facts = parseFacts("PERSON | first officer | NOT NAMED | 1\nPERSON | captain | Smit Machchhar | 1", [fz]).facts;
  const out = ensureUnidentified("Summary [1].\n\n## People involved\n- **Captain**: Smit Machchhar [1]\n- **First officer**: Omani national [1]\n\n## Timeline\n- 7:05 departed [1]", facts);
  assert.match(out, /## People involved\n- \*\*Captain\*\*: Smit Machchhar \[1\]\n- \*\*First officer\*\*: Omani national \[1\]\n- \*\*First officer\*\*: the person's name was not identified in the sources I found \[1\]\n\n## Timeline/);
  const already = "## People involved\n- First officer: name not identified in the sources [1]";
  assert.equal(ensureUnidentified(already, facts), already);
  assert.match(ensureUnidentified("Just a summary [1].", facts), /## People involved\n- \*\*First officer\*\*: the person's name was not identified/);
});

test("regression: verifier verdicts remove only the claims judged unsupported", async () => {
  const { claimsToVerify, applyVerdicts } = await import("../src/precision.ts");
  const answer = "The plane landed safely in Tabuk at 10:45 a.m. GST [1].\n- Saudi Arabia refused to allow Israeli military rescue aircraft into its territory [1].\n- Modi praised the captain, Smit Machchhar [1].";
  const claims = claimsToVerify(answer, [fz]);
  assert.ok(claims.some(c => c.sentence.startsWith("- Saudi") || c.sentence.startsWith("Saudi")));
  const saudi = claims.find(c => /Saudi Arabia refused/.test(c.sentence))!;
  const out = applyVerdicts(answer, claims, `${saudi.id}: NOT SUPPORTED\nC99: SUPPORTED`);
  assert.equal(out.removed.length, 1);
  assert.doesNotMatch(out.text, /refused/);
  assert.match(out.text, /landed safely in Tabuk/);
  assert.match(out.text, /Smit Machchhar/);
});

test("regression: headings get their own line and unnamed people read naturally", async () => {
  const { tidyAnswer } = await import("../src/precision.ts");
  assert.equal(tidyAnswer("It landed in Saudi Arabia. ## Key details\n- **First officer**: NOT PUBLICLY IDENTIFIED [1]"),
    "It landed in Saudi Arabia.\n\n## Key details\n- **First officer**: name not identified in the sources I found [1]");
  assert.equal(tidyAnswer("Use C## and x ## y"), "Use C## and x ## y");
});

test("regression: when several events match, the ones the answer left out are still named", async () => {
  const { mentionOtherEvents } = await import("../src/precision.ts");
  const anchors = [{ title: "Flydubai Flight 1073", date: "2026-09-30" }, { title: "Flydubai Flight 981", date: "2016-03-19" }];
  const ev = [fz, source("Flydubai Flight 981", "Flydubai Flight 981 crashed on 19 March 2016.", 2)];
  assert.equal(mentionOtherEvents("About Flydubai Flight 1073 [1].", anchors, ev), "About Flydubai Flight 1073 [1].\n\n**Other events that match this question:** Flydubai Flight 981 (19 March 2016) [2].");
  assert.equal(mentionOtherEvents("1073 [1]. Also Flydubai Flight 981 [2].", anchors, ev), "1073 [1]. Also Flydubai Flight 981 [2].");
  assert.equal(mentionOtherEvents("Only one.", anchors.slice(0, 1), ev), "Only one.");
});
