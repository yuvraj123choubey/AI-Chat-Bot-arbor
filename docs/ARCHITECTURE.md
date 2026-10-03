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
  files/       Document parsing (PDF pages, DOCX, text/code lines, images), chunking with locators, embeddings.
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
  (read_file, read_range, search_code, find_symbol, list_directory, apply_patch, write_file, create_file,
  delete_file, run_command, run_tests, run_build, run_checks, git_status, git_diff, checkpoint, revert,
  view_page, update_plan, finish). Each turn the model sees a compact task memory (goal, plan, relevant files,
  edits, commands, failures, remaining checks) and a working set of the files it opened, not the whole transcript.
- **Gates**: a baseline run of every detected check (test/typecheck/lint/build); patches only on files that were
  read; repeated looks before any change are skipped; finishing is refused while checks it broke fail, when a
  reported bug has no reproducing test, when an edited web page shows console errors (headless Chrome/Edge via
  playwright-core), or when nothing was changed for a change request.
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
