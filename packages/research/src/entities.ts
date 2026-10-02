/**
 * Recognises verifiable external entities in a question — course codes, URLs, organisations — so Arbor looks
 * them up instead of letting a model guess about them.
 */
export interface CourseCode { subject: string; number: string; raw: string }

/** Words that look like a course subject before a number but are not ("in 2024", "since 1990", "top 100"). */
const notSubjects = new Set("a an and are as at by for from in into is it of on or since the to top under over up was were with year years page pages vol version v ver chapter section rfc iso cve covid windows win ios android mac macos python java node gpt top section part step day days week weeks room route highway pm am usd eur gbp no num number model about around than".split(" "));

/** Course codes such as "CPRE 4300", "CPR E 4300", "COMS 2280", "cs-161", "MATH 1650A". */
export function courseCodes(text: string): CourseCode[] {
  const out: CourseCode[] = [];
  for (const m of text.matchAll(/\b([A-Za-z]{2,5}(?:\s[A-Za-z])?)\s?-?(\d{3,4})([A-Za-z])?\b/g)) {
    const subject = m[1].replace(/\s+/g, "").toUpperCase();
    if (notSubjects.has(subject.toLowerCase()) || notSubjects.has(m[1].split(/\s/)[0].toLowerCase())) continue;
    // A bare four-digit year after an ordinary word is not a course ("budget 2024").
    if (/^(19|20)\d\d$/.test(m[2]) && !/^[A-Z]{2,5}$/.test(m[1].replace(/\s/g, ""))) continue;
    const number = `${m[2]}${m[3] ? m[3].toUpperCase() : ""}`;
    if (!out.some(c => c.subject === subject && c.number === number)) out.push({ subject, number, raw: m[0] });
  }
  return out;
}

export function urls(text: string): string[] {
  return [...new Set([...text.matchAll(/\bhttps?:\/\/[^\s<>"')\]]+/gi)].map(m => m[0].replace(/[.,;:!?]+$/, "")))];
}

const filler = new Set("course courses class classes description descriptions syllabus catalog catalogue prerequisite prerequisites prereq prereqs credits credit hours info information about tell me what whats what's is are the a an of at for in on to please give show find search look up details detail summary summarize explain who where when which how does do official website site page for".split(" "));
/** The organisation named alongside an entity, e.g. "iowa state" in "course description cpre 4300 iowa state". */
export function organizationName(text: string, courses: CourseCode[] = courseCodes(text)): string | undefined {
  let rest = text;
  for (const c of courses) rest = rest.replace(c.raw, " ");
  for (const u of urls(text)) rest = rest.replace(u, " ");
  const words = rest.replace(/[^\p{L}\p{N}&.'\s-]/gu, " ").split(/\s+/).filter(w => w && !filler.has(w.toLowerCase()));
  const name = words.join(" ").trim();
  return name.length >= 3 && words.length <= 8 ? name : undefined;
}

/** Signals that a question is about a specific, checkable thing in the world. */
const entityCues: RegExp[] = [
  /\b(universit(y|ies)|college|institute|school|academy|department|ministry|agency|inc\.?|corp(oration)?|company|ltd|llc|foundation|hospital|museum|council|committee|court)\b/i,
  /\b(ceo|cto|cfo|president|founder|chair(man|woman|person)?|director|minister|governor|senator|mayor|professor|dean|coach|owner) of\b/i,
  /\b(act|bill|statute|regulation|ordinance|treaty|amendment|gdpr|hipaa|ferpa|title (ix|vi))\b|§/i,
  /\$\s?\d|\b(price|prices|cost|costs|tuition|salary|fee|fees|rate|rates)\b/i,
  /\b(description|syllabus|catalog|catalogue|prerequisites?|headquarters|founded|population|release date|specs|specifications)\b/i,
  /\b(doi|isbn|arxiv|journal)\b/i
];
/** Two or more capitalised words not at the start of a sentence, e.g. "at Iowa State" or "Network Protocols". */
const properName = /(?<![.!?]\s|^)\b[A-Z][a-z]+(?:\s+(?:of|de|and|&)?\s*[A-Z][a-zA-Z]+)+\b/;

export interface EntitySignals { courses: CourseCode[]; urls: string[]; cue: boolean; properName: boolean }
export function entitySignals(text: string): EntitySignals {
  return { courses: courseCodes(text), urls: urls(text), cue: entityCues.some(r => r.test(text)), properName: properName.test(text) };
}
