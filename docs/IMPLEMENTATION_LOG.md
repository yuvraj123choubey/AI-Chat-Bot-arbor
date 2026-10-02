# Implementation log

Newest first. Each entry: what changed, how it was verified, what is still open.

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
