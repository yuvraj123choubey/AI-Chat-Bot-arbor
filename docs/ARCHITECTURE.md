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

## Providers

| Kind | Default (free) | Optional |
|---|---|---|
| Language model | Built-in local server (Qwen3-4B GGUF, Apache-2.0) | Ollama/LM Studio via `LOCAL_LLM_URL`; OpenAI, Claude, Gemini, DeepSeek with keys |
| Search | Wikipedia, OpenAlex, Stack Overflow, GDELT news | SearXNG (self-hosted, free), Brave (paid) |
| Database | Embedded PostgreSQL 18 (UTF-8) in `data/postgres` | Any PostgreSQL via `DATABASE_URL` |

## Security notes

- API and local model server bind to 127.0.0.1 and reject foreign `Host` headers (DNS rebinding) and non-JSON
  writes (cross-site requests).
- Page fetching refuses private/loopback addresses at connection time, re-checks every redirect, and caps size/time.
- Logs pass through `redactSecrets`; provider keys never leave the server.
- Retrieved text is treated as untrusted data in prompts.
