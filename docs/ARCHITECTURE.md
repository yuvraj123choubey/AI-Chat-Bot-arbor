# Arbor architecture

Arbor is one backend serving the web app (and later the browser extension and desktop agent). Everything runs
free and locally by default; paid providers are optional plug-ins.

```
apps/
  web/         React UI (Vite). Talks only to /api; never sees provider keys.
  api/         HTTP API: routes, app context, repositories (Prisma).
  local-llm/   Built-in local model server (llama.cpp via node-llama-cpp), OpenAI-compatible, 127.0.0.1:11435.
packages/
  ai/          Provider abstraction, model registry, router, chat streaming, orchestrator.
  research/    Search providers, safe fetcher, extraction, evidence selection, citations.
  db/          Prisma schema, migrations, client, local-database helpers, test harness.
  files/       Document parsing (PDF pages, DOCX, text/code lines, screenshots via local OCR), chunking with locators, embeddings.
  study/       Study engine: document outlines, study planning, quote-verified study notes, material gathering, submission review.
  assignments/ Requirement extraction from instructions and rubrics (quotes only what the files say).
  code/        Code Workspace: project files, version history, safe command runner, previews, repo index, coding agent.
scripts/       db.ts (local PostgreSQL lifecycle), check-search.ts (live search diagnostics).
config/        models.example.json — the model registry (ids, capabilities, limits, prices).
```

## Request flow: Ask Arbor

1. `POST /api/chat` saves the user turn and an empty reply row.
2. **Search intent** (`research/intent.ts`) decides whether evidence is needed (user can force on/off) and what
   kind: academic, time-sensitive, technical.
3. **Query planning** asks the cheapest suitable model for keyword queries (heuristic fallback).
4. **Gather evidence** (`research/pipeline.ts`): providers chosen by focus → search → de-duplicate (canonical URL,
   DOI, title) → rank (reciprocal-rank fusion + BM25) → read pages through the DNS-pinned fetcher → split into
   passages → BM25 evidence selection → numbered sources.
5. Sources are stored (`Source`, `MessageSource`) and streamed to the UI before the answer.
6. **Model router** (`ai/router.ts`) picks a model by task kind, reasoning level and capabilities; Auto falls back
   to other qualified models only before any text has streamed.
7. The answer streams to the UI; afterwards the backend **sanitises citations** — only numbers it supplied
   survive — and stores `Citation` rows per claim.

## Study engine: answering from the user's files

Study first, answer second, verify before claiming. When a turn involves the user's documents (attached now,
attached earlier in the conversation and followed up on, or matched in the library), `packages/study` runs:

1. **Plan** (`plan.ts`): is the question a *lookup* ("What does question 4 mean?"), about the *whole* material
   ("Study this lab and help me complete it"), or a *review* ("Is my submission complete?")? Coursework wording
   ("hand in", "due", "rubric", "screenshot") keeps the conversation's files in play for short follow-ups.
2. **Outline** (`outline.ts`): numbered units (Task 3, Question 4, Part B, numbered lists) with their full text and
   page/lines, found without a model. A named unit is read whole; a unit that does not exist is reported.
3. **Gather** (`gather.ts`): small documents and whole-material questions read everything that fits the model's
   context; otherwise the named units, the best passages (hybrid BM25 + embeddings), a second retrieval for
   question words not yet covered, the document's structure and its study notes. Deadlines are extracted verbatim.
4. **Study notes** (`sheet.ts`, cached in `DocumentStudy`): a long document is read window by window into
   requirements, deliverables, questions, concepts, terms, commands, restrictions, grading and screenshot
   requirements. Every item must quote the document; items whose quote is not found are dropped.
5. **Answer and verify**: the model answers from numbered sources with study rules (direct first sentence, quote
   exactly, say "I couldn't verify this" for gaps). Claims are checked against their sources; a final consistency
   pass strips echoed questions, states missing units plainly, adds the stated due date if a whole-material answer
   left it out, and says when an image could not be inspected.
6. **Review** (`review.ts`, `parts.ts`): each requirement is split into parts. Commands, word limits and
   screenshots are checked mechanically (screenshots through OCR text that must show the task's command and
   values); explanations are small yes/no questions whose "yes" must be backed by a sentence really in the
   submission. The verdict ("Not yet. 3 of 5 requirements are complete." with ✓/⚠/✗ per task, what to fix, and
   what could not be verified) is assembled from these checks, not written by the model.

Screenshots and images are read with Tesseract (tesseract.js, bundled English model, no network) after
greyscale, dark-background inversion and upscaling (sharp). Only text is read; the UI and answers say so.

Research answers search again when the first results miss part of the question (`research/coverage.ts`).

## Code Workspace and coding agent

Projects live in `data/projects/<id>`. Version history is a separate git directory (`data/project-history/<id>.git`)
driven with `--git-dir/--work-tree`, so a project's own `.git` is never touched; every agent task is bracketed by
checkpoints and can be reverted as one unit.

- **Command runner** (`code/runner.ts`): allowlisted programs only (node, npm, python, git read-only, …), one command
  at a time (no shell operators), arguments cannot leave the project, secrets are stripped from the environment,
  output capped at 1 MB, timeouts, whole-process-tree cancellation, a log file per run, two concurrent runs per project.
- **Preview**: static sites are served by the API under a sandbox CSP; Vite/Next/Node projects get a dev server on a
  free local port.
- **Agent loop** (`code/agent.ts`): inspect → plan → edit → run → observe → fix → retest, one JSON tool call per turn
  (read_file, read_range, search_code, find_symbol, find_references, inspect_dependencies, list_directory,
  apply_patch, write_file, create_file, rename_file, delete_file, run_command, run_tests, run_typecheck, run_lint,
  run_build, run_checks, git_status, git_diff, checkpoint, revert, view_page (desktop/mobile layout report),
  update_plan, finish). Each turn the model sees a compact task memory (goal, plan, relevant files,
  edits, commands, failures, remaining checks) and a working set of the files it opened, not the whole transcript.
- **Gates**: a baseline run of every detected check (test/typecheck/lint/build); patches only on files that were
  read; repeated looks before any change are skipped; finishing is refused while checks it broke fail, when a
  reported bug has no reproducing test, when an edited web page shows console errors (headless Chrome/Edge via
  playwright-core), or when nothing was changed for a change request; web edits are loaded and every button clicked once; layout
  tasks are checked at phone width. The same failure three times in a row restores the last state where every
  check passed.
- **Model layer** (`code/decide.ts`): any registered model. Non-reasoning models get the tool schema as a grammar
  (`oneOf` per tool), so even small local models emit valid calls; reasoning models answer freely and are parsed
  and validated with one corrective retry.
- **Evaluation** (`npm run eval:agent`, `packages/code/eval`): six tasks (bug fix, feature, refactor, build repair,
  unfamiliar-repo navigation, UI change checked in a browser) with hidden checkers; reports success, hidden
  tests, regressions, files/lines changed, retries, steps and time. `EVAL_MODEL` picks the model.

## Providers

| Kind | Default (free) | Optional |
|---|---|---|
| Language model | Built-in local server (Qwen3-4B GGUF, Apache-2.0; `LOCAL_MODEL=hf:Qwen/Qwen3-8B-GGUF:Q4_K_M` for the stronger 8B, better for the coding agent, ~5 GB VRAM) | Ollama/LM Studio via `LOCAL_LLM_URL`; OpenAI, Claude, Gemini, DeepSeek with keys |
| Search | Wikipedia, OpenAlex, Stack Overflow, GDELT news | SearXNG (self-hosted, free), Brave (paid) |
| Database | Embedded PostgreSQL 18 (UTF-8) in `data/postgres` | Any PostgreSQL via `DATABASE_URL` |

## Security notes

- API and local model server bind to 127.0.0.1 and reject foreign `Host` headers (DNS rebinding) and non-JSON
  writes (cross-site requests).
- Page fetching refuses private/loopback addresses at connection time, re-checks every redirect, and caps size/time.
- Logs pass through `redactSecrets`; provider keys never leave the server.
- Retrieved text is treated as untrusted data in prompts.
