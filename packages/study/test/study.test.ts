import test from "node:test";
import assert from "node:assert/strict";
import { aboutCoursework, assignRoles, findSegments, finalizeStudyAnswer, gatherMaterial, missingUnitsAnswer, outlineDocument, parseSheet, planStudy, reviewAnswer, reviewSubmission, segmentRefs, stripEchoedQuestion, type StudyChunk, type StudyDoc } from "../src/index.ts";

/** A document from pages of text, one chunk per page (as PDF ingest stores them). */
function doc(id: string, name: string, pages: string[], extra: Partial<StudyDoc> = {}): StudyDoc {
  const chunks: StudyChunk[] = pages.map((text, i) => ({ id: `${id}-${i}`, documentId: id, ordinal: i, text, page: i + 1, embedding: [] }));
  return { id, name, mimeType: "application/pdf", chunks, ...extra };
}
const lab = doc("lab", "lab5-instructions.pdf", [
  "Lab 5: Firewall Configuration\nDue Friday, October 10 at 11:59 pm.\nYou must work alone. Do not use GUI tools; use the command line only.",
  "Task 1: Check the firewall status\nRun sudo ufw status verbose and explain each line of the output.\nTask 2: Allow SSH\nAdd a rule that allows SSH on port 22 and explain why it is needed.",
  "Task 3: Block a port\nBlock incoming traffic on port 8080. Include a screenshot of the rule list after the change.\nTask 4: Reflection\nWrite one paragraph on what you would change in a production firewall."
]);
const submission = doc("sub", "my-submission.pdf", [
  "Task 1\nI ran sudo ufw status verbose. Status: active means the firewall is on. Default: deny (incoming) blocks new connections.",
  "Task 2\nI ran sudo ufw allow 22/tcp so that I can still log in remotely over SSH after enabling the firewall.\nTask 3\nI ran sudo ufw deny 8080 to block the port."
]);

test("outline: tasks with pages, nested steps, and units named in a question", () => {
  const outline = outlineDocument(lab.chunks);
  assert.deepEqual(outline.map(s => [s.label, s.page]), [["Task 1", 2], ["Task 2", 2], ["Task 3", 3], ["Task 4", 3]]);
  assert.match(outline[2].text, /Include a screenshot/);
  assert.doesNotMatch(outline[2].text, /Reflection/, "a unit ends at the next unit of the same level");
  assert.deepEqual(segmentRefs("What does question 4 mean, and part b of task 2?").map(r => [r.kind, r.number]), [["question", "4"], ["part", "b"], ["task", "2"]]);
  const { found, missing } = findSegments(segmentRefs("explain question 4 and task 7"), outline);
  assert.deepEqual(found.map(s => s.label), ["Task 4"], "question 4 falls back to the unit numbered 4");
  assert.deepEqual(missing.map(m => m.text), ["task 7"]);
  // Without named units, a top-level numbered list is the structure; nested lists restarting at 1 are skipped.
  const listed = outlineDocument([{ id: "x", documentId: "x", ordinal: 0, text: "Intro\n1. Install Node\n2. Run the server\n1. sub-step\n3. Open the page" }]);
  assert.deepEqual(listed.map(s => s.label), ["Item 1", "Item 2", "Item 3"]);
});

test("plan: a named part is a lookup, the whole lab is studied, completeness is a review", () => {
  assert.equal(planStudy("What does question 4 mean?").scope, "lookup");
  assert.equal(planStudy("Study this lab and help me complete it").scope, "whole");
  assert.equal(planStudy("Is my submission complete?").scope, "review");
  assert.equal(planStudy("Is everything complete?").scope, "review");
  assert.equal(planStudy("Did I miss anything in the rubric?").scope, "review");
  assert.equal(planStudy("What port does task 3 block?").scope, "lookup");
  assert.equal(planStudy("Summarize all the tasks").scope, "whole");
  // Coursework wording keeps a conversation's files in use; small talk does not.
  for (const q of ["What exactly do I need to hand in?", "When is it due?", "How is it graded?", "Do I need a screenshot?", "What should I write for the reflection?"]) assert.ok(aboutCoursework(q), q);
  for (const q of ["hello there", "what is the capital of France", "thanks!"]) assert.ok(!aboutCoursework(q), q);
});

test("gather: the whole lab when it fits, the named unit for a lookup, and units that don't exist are reported", () => {
  const whole = gatherMaterial({ question: "Study this lab", plan: planStudy("Study this lab"), docs: [lab], queryVector: [], budgetChars: 20_000 });
  assert.equal(whole.reading[0].mode, "complete");
  assert.equal(whole.evidence[0].passages.length, 3);
  assert.match(whole.evidence[0].passages[1].text, /^\(page 2\)/);
  // A big document: a lookup reads the named unit in full and the matching passages, not everything.
  const big = doc("big", "big.pdf", [...lab.chunks.map(c => c.text), ...Array.from({ length: 12 }, (_, i) => `Appendix page ${i}: ${"background reading about packet filtering history ".repeat(30)}`)]);
  const look = gatherMaterial({ question: "What does task 3 ask me to block?", plan: planStudy("What does task 3 ask me to block?"), docs: [big], queryVector: [], budgetChars: 20_000 });
  assert.equal(look.reading[0].mode, "sections");
  assert.ok(look.evidence[0].passages.some(p => /^\(Task 3, page 3\) Task 3: Block a port[\s\S]*screenshot/.test(p.text)), "the named unit is read in full");
  assert.ok(!look.evidence[0].passages.some(p => /^\(page 3\)/.test(p.text)), "its page is not repeated as a separate passage");
  assert.equal(look.evidence[0].source.metadata.locator && (look.evidence[0].source.metadata.locator as { page?: number }).page, 3, "the card opens where the answer is");
  assert.ok(look.evidence[0].passages.length < big.chunks.length);
  const missing = gatherMaterial({ question: "What is question 9?", plan: planStudy("What is question 9?"), docs: [big], queryVector: [], budgetChars: 20_000 });
  assert.equal(missing.notFound[0], "question 9 — there is no question 9 in big.pdf (it has Task 1–Task 4)");
  assert.equal(missingUnitsAnswer(planStudy("What is question 9?"), missing), "There is no Question 9 in big.pdf — big.pdf has Task 1–Task 4. I couldn't find what you're asking about in your files, so I won't guess what it says. Which one did you mean?");
  assert.equal(missingUnitsAnswer(planStudy("What does task 3 ask me to block?"), look), undefined, "a unit that exists is answered normally");
  assert.match(finalizeStudyAnswer("Here is what I found.", missing), /> I couldn't find question 9 in your files/);
  assert.equal(finalizeStudyAnswer("I couldn't find question 9 in the lab.", missing), "I couldn't find question 9 in the lab.");
  // Final checks: no echoed question, and a whole-lab answer always carries the due date the files state.
  assert.equal(stripEchoedQuestion("And what does task 7 ask?\nTask 7 is not in the lab.", "And what does task 7 ask?"), "Task 7 is not in the lab.");
  assert.equal(stripEchoedQuestion("What is the late penalty for this lab? It is not stated [1].", "What is the late penalty for this lab?"), "It is not stated [1].");
  assert.equal(stripEchoedQuestion("The penalty is not stated.", "What is the late penalty?"), "The penalty is not stated.");
  assert.deepEqual(whole.deadlines.map(d => [d.text, d.page]), [["Due Friday, October 10 at 11:59 pm.", 1]]);
  const plan = planStudy("Study this lab");
  assert.match(finalizeStudyAnswer("Lab 5 has four tasks.", whole, { plan, ordinalOf: () => 1 }), /^\*\*Due:\*\* Friday, October 10 at 11:59 pm\. \[1\]\n\nLab 5 has four tasks\./);
  assert.equal(finalizeStudyAnswer("It is due Friday, October 10 at 11:59 pm [1].", whole, { plan }), "It is due Friday, October 10 at 11:59 pm [1].");
});

test("study sheet: only items whose quote is really in the document survive", () => {
  const output = [
    "requirement | Block port 8080 | \"Block incoming traffic on port 8080.\"",
    "screenshot | Show the rule list | \"Include a screenshot of the rule list after the change.\"",
    "restriction | No GUI tools | \"Do not use GUI tools\"",
    "grading | Worth 20 points | \"Task 3 is worth 20 points\"",
    "nonsense line without separators"
  ].join("\n");
  const { items, rejected } = parseSheet(output, lab.chunks);
  assert.deepEqual(items.map(i => [i.kind, i.page]), [["requirement", 3], ["screenshot", 3], ["restriction", 1]]);
  assert.equal(rejected, 1, "the invented points line is dropped");
});

test("review: every requirement checked, fabricated evidence rejected, missing screenshot caught, answer assembled", async () => {
  const calls: string[] = [];
  const generate = async (messages: { content: string }[]) => {
    const prompt = messages[1].content;
    calls.push(prompt);
    if (/TASK \(Task 1/.test(prompt)) return "P1: YES | \"Status: active means the firewall is on\"";
    if (/TASK \(Task 2/.test(prompt)) return "P1: YES | \"I ran sudo ufw allow 22/tcp so that I can still log in remotely\"";
    if (/TASK \(Task 3/.test(prompt)) return "P1: YES | \"I ran sudo ufw deny 8080 to block the port.\"";
    return "P1: YES | \"In production I would log every dropped packet\"";
  };
  const roles = assignRoles([lab, submission]);
  assert.deepEqual(roles.docs.map(d => d.role), ["instructions", "submission"]);
  const result = await reviewSubmission({ docs: [lab, submission], sheets: new Map(), generate });
  assert.deepEqual(result.checks.map(c => [c.requirement.label, c.status]), [["Task 1", "met"], ["Task 2", "met"], ["Task 3", "partial"], ["Task 4", "missing"]]);
  assert.equal(result.checks[2].screenshot, "missing");
  assert.match(result.checks[2].note, /Couldn't verify: Include a screenshot .*images inside your submission file are not inspected/);
  assert.deepEqual(result.checks[0].parts.map(p => [p.part.kind, p.status]), [["command", "yes"], ["judge", "yes"]], "the command is checked without the model");
  assert.equal(result.checks[3].note, "Your submission has no Task 4 section.", "no model call for a task the numbered submission skips");
  assert.equal(calls.length, 3);
  assert.match(calls[2], /SUBMISSION:\nTask 3\nI ran sudo ufw deny 8080/, "the submission's own Task 3 is the evidence");
  assert.match(calls[2], /PARTS:\nP1: Block incoming traffic on port 8080\.\n\n/, "only the judged part is asked; the screenshot is checked separately");
  const answer = reviewAnswer(result, id => (id === "lab" ? 1 : 2));
  assert.match(answer, /^\*\*Not yet\.\*\* 2 of 4 requirements are complete\./);
  assert.match(answer, /- ✓ \*\*Task 1\*\* — Complete — "Status: active means the firewall is on" \[2\]/);
  assert.match(answer, /- ⚠ \*\*Task 3\*\* — .*screenshot/);
  assert.match(answer, /- ✗ \*\*Task 4\*\* — Missing — Your submission has no Task 4 section\. \(required in \[1\]\)/);
  assert.match(answer, /### What to fix\n1\. \*\*Task 3\*\*/);
  assert.match(answer, /Images inside PDF or Word files are not inspected/);

  // A verdict whose quote is not in the submission is not trusted.
  const lying = await reviewSubmission({ docs: [lab, doc("sub2", "answers.pdf", ["Task 1\nThe firewall status is active.\nTask 4\nI would add logging."])], sheets: new Map(), generate: async () => "P1: YES | \"a sentence the student never wrote\"" });
  assert.ok(lying.checks.every(c => c.status !== "met"), "an invented quote never makes a requirement complete");
  assert.equal(lying.checks[3].status, "unclear");
  assert.match(lying.checks[0].note, /Missing: Run sudo ufw status verbose \(`ufw status verbose` is not shown\)\. Couldn't verify: Explain each line of the output \(I couldn't find the words/);

  // Only instructions: no guessing.
  const alone = await reviewSubmission({ docs: [{ ...lab, role: "instructions" }], sheets: new Map(), generate });
  assert.match(reviewAnswer(alone, () => 1), /^I can't check completeness yet: I only have the instructions \(lab5-instructions\.pdf\)/);

  // All met → "Yes", with what could not be verified still listed.
  const shot: StudyDoc = { id: "img", name: "rules.png", mimeType: "image/png", image: true, chunks: [{ id: "img-0", documentId: "img", ordinal: 0, text: "To Action From\n8080 DENY IN Anywhere\nblock incoming traffic port 8080 rule list" }] };
  const full = doc("full", "my-submission.pdf", [...submission.chunks.map(c => c.text), "Task 4\nIn production I would log every dropped packet and review the rules monthly."]);
  const done = await reviewSubmission({ docs: [lab, full, shot], sheets: new Map(), generate });
  assert.deepEqual(done.checks.map(c => c.status), ["met", "met", "met", "met"]);
  assert.equal(done.checks[2].screenshot, "read");
  const yes = reviewAnswer(done, id => ({ lab: 1, full: 2, img: 3 })[id]);
  assert.match(yes, /^\*\*Yes\*\* — based on the files and evidence I was able to verify, all 4 required items are present\./);
  assert.match(yes, /Screenshots were checked only through the text read from them \(OCR\)/);
});
