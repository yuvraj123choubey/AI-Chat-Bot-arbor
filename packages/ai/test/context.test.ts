import test from "node:test";
import assert from "node:assert/strict";
import { selectContext } from "../src/context.ts";
import type { Message } from "../src/types.ts";

const isu: Message[] = [
  { role: "user", content: "course description cpre 4300 iowa state" },
  { role: "assistant", content: "CPRE 4300: Network Protocols and Security at Iowa State University covers TCP/IP, network application protocols and network security [1]." }
];
const after = (content: string): Message[] => [...isu, { role: "user", content }];

test("a bare ambiguous term after an unrelated topic asks for clarification with no earlier context", () => {
  const d = selectContext(after("apple"));
  assert.equal(d.mode, "ambiguous");
  assert.deepEqual(d.messages, [{ role: "user", content: "apple" }]);
  assert.match(d.note!, /Do not connect it to any earlier topic/);
  assert.equal(d.searchText, "apple");
});

test("a follow-up that refers back keeps the earlier turns and carries them into search", () => {
  const d = selectContext(after("what are its prerequisites?"));
  assert.equal(d.mode, "continue");
  assert.equal(d.messages.length, 3);
  assert.match(d.searchText, /cpre 4300 iowa state[\s\S]*prerequisites/);
  assert.equal(d.previousUser, "course description cpre 4300 iowa state");
});

test("a clear new topic gets none of the earlier conversation", () => {
  for (const message of ["apple the fruit", "how do I bake sourdough bread?", "explain photosynthesis"]) {
    const d = selectContext(after(message));
    assert.equal(d.mode, "new-topic", message);
    assert.deepEqual(d.messages.map(m => m.content), [message]);
    assert.match(d.note!, /new topic/);
  }
});

test("a same-topic question without pronouns still continues", () => {
  const d = selectContext(after("does cpre 4300 cover network security labs?"));
  assert.equal(d.mode, "continue");
  assert.equal(d.searchText, "does cpre 4300 cover network security labs?");
});

test("older turns are kept only if relevant to the current topic", () => {
  const history: Message[] = [
    { role: "user", content: "best sourdough starter recipe" }, { role: "assistant", content: "Mix flour and water daily." },
    { role: "user", content: "what is cpre 4300 at iowa state" }, { role: "assistant", content: "Network Protocols and Security." },
    { role: "user", content: "who teaches network security courses there" }, { role: "assistant", content: "Several faculty in electrical and computer engineering." },
    { role: "user", content: "and its credits?" }
  ];
  const d = selectContext(history);
  assert.equal(d.mode, "continue");
  assert.ok(!d.messages.some(m => /sourdough|flour/.test(m.content)), "unrelated older turns are dropped");
  assert.ok(d.messages.some(m => /cpre 4300/.test(m.content)), "related older turns are kept");
});

test("first messages: ambiguous single words are clarified, anything else is answered", () => {
  assert.equal(selectContext([{ role: "user", content: "python" }]).mode, "ambiguous");
  assert.equal(selectContext([{ role: "user", content: "python list comprehension example" }]).mode, "first");
});
