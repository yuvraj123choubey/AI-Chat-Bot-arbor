import type { Message } from "./types.ts";

export type ContextMode = "first" | "continue" | "new-topic" | "ambiguous";
export interface ContextDecision {
  mode: ContextMode;
  /** Earlier turns to send to the model (oldest first), followed by the latest user message. */
  messages: Message[];
  /** The latest message with the context it refers to, for search intent and queries ("its prerequisites" → the course). */
  searchText: string;
  /** The previous user message, only when the latest one continues it. */
  previousUser?: string;
  /** Instruction for the model about how to treat this turn (e.g. ask which meaning was intended). */
  note?: string;
  reason: string;
}

const stop = new Set("a an and are as at be been but by can could did do does for from had has have how i if in into is it its it's may me might my no not of on or our please should so some such tell than that the their them then there these they this those to was we were what when where which while who why will with would you your about also any more just like get got give show".split(" "));
export function topicTerms(text: string): Set<string> {
  return new Set((text.toLowerCase().match(/[\p{L}\p{N}]+/gu) || []).filter(t => (t.length > 2 || /\d/.test(t)) && !stop.has(t)).map(t => t.replace(/(ies|es|s)$/, "")));
}

/** Words that refer back to something already said: pronouns, "that one", "what about", bare "why?" and so on. */
const backReference = /^(and|also|but|so|then|ok(ay)?|thanks?|what about|how about|why|how so|really|more|continue|go on|elaborate|same|which one|the (first|second|third|last|other) one)\b|\b(it|its|it's|they|them|their|theirs|that|this|those|these|he|she|his|her|him|that one|this one|the (course|class|paper|article|book|one|first|second|third|last|above|previous|same|former|latter|code|answer|list|example))\b/i;

/** Single words with several common, unrelated meanings; on their own they need a clarifying question. */
const ambiguousTerms = new Set("apple python mercury java jaguar amazon mustang corona delta shell oracle ruby swift go rust spark saturn apollo phoenix bass bat crane mouse seal windows blackberry puma dove mars venus jupiter pluto orange lincoln ford jordan washington turkey chile cancer gemini polo tesla nike target subway visa bolt chrome edge safari opera firefox notion slack zoom kindle echo alexa siri perl julia scala dart matlab cardinal falcon eagle bronco ram tiger lotus mint pitch spring bank bow match club ring scale band cell chip key bridge pilot crown drive express fusion galaxy ".trim().split(/\s+/));

/**
 * Chooses which earlier turns the model should see. A follow-up keeps the recent turns it builds on; a message
 * on a new topic gets none of the old conversation, so it is not bent toward an unrelated earlier subject; a bare
 * ambiguous term gets a clarifying question instead of a guess. Older turns are included only if they share
 * topic words with the latest message, most recent first, within a size budget.
 */
export function selectContext(history: Message[], options: { maxTurns?: number; maxChars?: number } = {}): ContextDecision {
  const turns = history.filter(m => m.role !== "system" && m.content.trim());
  const latest = turns.at(-1);
  if (!latest || latest.role !== "user") return { mode: "first", messages: turns, searchText: latest?.content ?? "", reason: "no user message" };
  const earlier = turns.slice(0, -1);
  const text = latest.content.trim();
  const words = text.split(/\s+/).filter(Boolean);
  if (!earlier.length) {
    const bare = words.length === 1 && ambiguousTerms.has(text.toLowerCase().replace(/[^\p{L}]/gu, ""));
    return bare
      ? { mode: "ambiguous", messages: [latest], searchText: text, note: clarifyNote, reason: "bare ambiguous term" }
      : { mode: "first", messages: [latest], searchText: text, reason: "first message" };
  }

  const current = topicTerms(text);
  const previousUser = [...earlier].reverse().find(m => m.role === "user")?.content;
  const lastPair = earlier.slice(-2);
  const lastTerms = topicTerms(lastPair.map(m => m.content).join(" "));
  const shared = [...current].filter(t => lastTerms.has(t)).length;
  const refersBack = backReference.test(text) && words.length <= 14;
  const isContinuation = refersBack || shared >= 1 && (shared / Math.max(1, current.size) >= 0.25 || shared >= 2);

  if (!isContinuation) {
    const bare = words.length === 1 && ambiguousTerms.has(words[0].toLowerCase().replace(/[^\p{L}]/gu, ""));
    if (bare) return { mode: "ambiguous", messages: [latest], searchText: text, note: clarifyNote, reason: "ambiguous term unrelated to the conversation" };
    return { mode: "new-topic", messages: [latest], searchText: text, note: newTopicNote, reason: "topic changed" };
  }

  // Continuation: the last exchange always counts. Older exchanges (question + answer) are kept only if they share
  // topic words with what is already kept; a kept exchange widens the topic, so a chain of related turns survives.
  const maxTurns = options.maxTurns ?? 12;
  const maxChars = options.maxChars ?? 60_000;
  const kept: Message[] = [...lastPair];
  let size = kept.reduce((n, m) => n + m.content.length, 0) + text.length;
  const focus = new Set([...current, ...lastTerms]);
  let end = earlier.length - lastPair.length;
  while (end > 0 && kept.length < maxTurns) {
    // Group into exchanges: an assistant turn together with the user turn before it.
    const start = earlier[end - 1].role === "assistant" && end >= 2 && earlier[end - 2].role === "user" ? end - 2 : end - 1;
    const exchange = earlier.slice(start, end);
    end = start;
    const terms = topicTerms(exchange.map(m => m.content).join(" "));
    const length = exchange.reduce((n, m) => n + m.content.length, 0);
    if (![...terms].some(t => focus.has(t)) || size + length > maxChars) continue;
    kept.unshift(...exchange);
    size += length;
    for (const t of terms) focus.add(t);
  }
  // Short back-references are searched together with what they refer to.
  const searchText = refersBack && previousUser ? `${previousUser}\n${text}` : text;
  return { mode: "continue", messages: [...kept, latest], searchText, previousUser, reason: refersBack ? "refers back to the conversation" : "same topic" };
}

const clarifyNote = "The latest message is a single word with several common meanings and nothing in the conversation settles which one is meant. Do not connect it to any earlier topic. Ask briefly which meaning the user wants, listing two to four common meanings in one short line each. Do not answer yet, and do not add links.";
const newTopicNote = "The latest message starts a new topic. Answer it on its own terms and do not relate it to earlier subjects in this conversation.";
