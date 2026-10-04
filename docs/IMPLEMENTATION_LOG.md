# Implementation log

Newest first. Each entry: what changed, how it was verified, what is still open.

## 2026-10-04 — Intelligence layer: study engine, verified review, recovery-aware coding agent

**Built**
- Study engine (`packages/study`): study planning (lookup / whole / review), document outlines (tasks, questions,
  parts), material gathering that reads whole documents when they fit and the named units plus best passages when
  not, quote-verified study notes cached per document, deadlines extracted verbatim, final consistency checks.
- Submission review: requirements split into parts; commands, word limits and screenshots checked mechanically;
  explanations judged as yes/no backed by sentences really in the submission; answer assembled from the checks
  ("Not yet. 2 of 5 requirements are complete." + ✓/⚠/✗ per task, what to fix, what could not be verified).
- Screenshots: local OCR (tesseract.js + bundled model) with preprocessing (sharp: greyscale, dark-mode
  inversion, upscaling); image previews show exactly the text Arbor read; unreadable images are reported as such.
- Context: files stay with a conversation (persisted attachments, coursework follow-ups keep them); research
  searches again when results miss part of the question.
- Coding agent: find_references, inspect_dependencies, rename_file, run_typecheck, run_lint, view_page with
  desktop/mobile layout reports; finish gates click every button once and check layout tasks at phone width;
  "last green" checkpoints with automatic recovery after the same failure three times; alternative tool names.
- Evaluations: `npm run eval:study` (document study, context, honesty, submission review, research) against the
  live app; `npm run eval:agent` gained a responsive-layout task checked at phone width.

**Fixed along the way**
- Page checks failed under tsx (`__name` injected into functions sent to the browser).
- Markdown turned underscores inside file names into italics.
- Small models echoed the question at the start of answers.

## 2026-10-03 — Files, document preview, Code Workspace and coding agent

**Built**
- Files: library page (upload/drag-drop, search, kind/status filters, rename, attach to assignments, projects,
  research and conversations, delete), upload states, parsing (PDF pages, DOCX, text/code lines, images without
  OCR), chunking with page/line locators, local embeddings, Ask Arbor scope (Auto, Web, Files, Web + Files),
  file citations that open an in-app preview at the cited page or lines (page nav, zoom, find, code highlighting).
- Code Workspace: projects from templates, file explorer, CodeMirror editor, safe terminal with live output and
  Stop, run tests/build, live preview (static and dev-server), version history with diffs and restore.
- Coding agent: inspect → plan → edit → run → observe → fix → retest with structured tools, compact task memory,
  working set, repo index (symbols, imports, relevant files), baseline checks, patch-based edits (whitespace- and
  quote-tolerant, all-or-nothing) and whole-file rewrites for small files, loop guards, and finish gates (checks
  it broke, unreproduced bug reports, console errors on edited pages, no-change finishes). One revertible
  checkpoint per task; metrics per run.
- Assignments UI (courses, assignments, role-tagged uploads, requirement extraction, progress, submission check,
  hand-off to the Code Workspace) against the assignments API contract; shows an honest notice while that
  service is not running.
- `npm run eval:agent`: six-task evaluation with hidden checkers and per-task logs and action traces.

**Verified**
- Typecheck, lint, production build; full test suite green.
- Real-browser runs (installed Chrome via playwright-core): PDF upload → Ready with page count, preview with pages
  and find, rename, file-grounded answer citing "p. 2" that opens the preview at page 2; project creation, edit
  and Ctrl+S, terminal run / refused shell operators / Stop, live preview with a working script, save version,
  diff, restore; the agent changing a heading with the local model, viewing its diff and reverting it.

**Fixed along the way**
- Task event streams ended right after the snapshot when the task had already finished, dropping its events.
- The agent could finish a static-site edit that threw a syntax error (no checks to catch it).

**Open**
- Agent quality is bounded by the local model; see the eval numbers in the milestone report.
- Assignments backend is not part of this milestone. ZIP starter code and OCR are not supported.

## 2026-10-02 — Free-only stack, local model, web search with citations, PostgreSQL

**Built**
- PostgreSQL + Prisma 7 data layer with all core entities (users, workspaces, conversations, sources, citations,
  research, tasks, documents, courses/assignments, projects, computer-mode actions, approvals, devices, usage).
- Local embedded PostgreSQL managed by `scripts/db.ts` (detached via `pg_ctl`, orphan cleanup, UTF-8 enforced).
  Earlier JSON conversations import automatically; files move to `data/backup/`.
- Research package: free search providers (Wikipedia, OpenAlex, Stack Overflow, GDELT; SearXNG/Brave optional),
  DNS-pinned safe fetcher, Readability extraction, BM25 evidence selection, backend citation sanitising.
- Built-in local model server (node-llama-cpp, Vulkan GPU) with direct and thinking modes; registered as the
  default free provider. Paid providers remain optional.
- UI: search mode selector, research status, source strip, inline citation chips, sources drawer, saved-source library.

**Verified**
- 42 automated tests (unit + API integration on a real PostgreSQL), typecheck, lint, production build.
- Live: search pipeline against real Wikipedia/OpenAlex/Stack Overflow; local model on RTX 5060 (~50 tok/s);
  headless-Chrome UI run with real search + local model (cited answer in ~31 s), save/library/stop/follow-up.

**Fixed along the way**
- Local database created as WIN1252 on Windows could not store Unicode → now UTF-8, with in-place conversion that
  keeps the old database as a backup.
- Orphaned PostgreSQL processes after killed dev servers → detached server + cleanup.
- Extraction merged adjacent HTML blocks; Markdown lists restarted numbering after blank lines.

**Open**
- GDELT intermittently throttles Node's TLS client after bursts; failures are reported, not fatal.
- No general web index without SearXNG (free, self-hosted) or a paid key.
- Hosted providers untested live (no keys, by design under the free-only constraint).

## 2026-10-01 — Ask Arbor vertical slice
Multi-provider streaming chat, model registry/router, fallback, error handling, conversation history, usage log.
