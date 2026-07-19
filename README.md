# Open-Log

Ingests a Minecraft server's log files and presents them as a searchable
timeline: a Canvas view of points of interest (joins/leaves/chat/deaths/op
commands/sleep-wake/warnings) above a virtualized full-log viewer. Click a
timeline marker to jump to and highlight the matching log line.

Single self-hosted, publicly-exposed instance — shared-password auth, no
user accounts.

## Stack

pnpm workspace monorepo: Node/TS backend (Express + SQLite), Vite/React/TS
frontend, a shared zod-schema package, and a JSON-based rule engine for
parsing log lines.

## Quick start

```bash
pnpm install

pnpm dev:backend    # API + log ingestion — http://localhost:4000
pnpm dev:frontend   # http://localhost:5173 (proxies /api -> :4000)
```

Copy `apps/backend/.env.example` to `apps/backend/.env` and fill in real
values. Without `MC_LOGS_DIR` set, the backend reads the anonymized sample
logs in `example-data/logs/`.

Generate an auth password hash:

```bash
pnpm --filter @open-log/backend hash-password <your-password>
```

## Other commands

```bash
pnpm typecheck                                            # tsc --noEmit, all packages
pnpm build                                                 # production frontend build
pnpm --filter @open-log/backend backfill            # re-scan MC_LOGS_DIR into SQLite
```

There's no lint config or test runner in this repo.

## Deployment

```bash
docker compose build && docker compose up -d
```

Copy the root `.env.example` to `.env` first. Caddy fronts the app for
automatic HTTPS; the app container publishes no ports directly.

## Architecture

```
apps/backend         Node/TS: log ingestion + Express API, one process
apps/frontend         Vite/React/TS/Tailwind/shadcn
packages/shared-types zod schemas shared by both apps (no build step)
config/rules*.json    parsing rule set (data, not code)
```

**Ingestion** (`apps/backend/src/ingest/`): `fileWatcher.ts` watches the
logs directory, backfilling completed rotated `*.log.gz` files and tailing
`latest.log` from a stored byte offset (`ingest_checkpoints` table). Each
line is parsed first, then redacted, then run through the rule engine;
lines matching a rule marked `isPOI: true` also get an `events` row.

**Rule engine** (`apps/backend/src/rules/`): plain JSON rules (regex →
event type, POI flag, severity, summary template) merged from
`config/rules.default.json` and an optional `config/rules.custom.json`, so
new log patterns can be added without touching pipeline code.

**Data model** (`apps/backend/src/db/`): SQLite (better-sqlite3, WAL).
`raw_lines` holds every ingested line; `events` holds POIs only, linked via
`events.raw_line_id` — this FK is what lets a timeline marker click scroll
to and highlight the source log line. `raw_lines_fts` (FTS5) backs log
search.

**API** (`apps/backend/src/api/routes.ts`): REST endpoints plus `/stream`,
a Server-Sent Events feed that pushes newly-ingested lines/events to
connected browsers in real time.

**Frontend** (`apps/frontend/src/`): `Dashboard` composes a Canvas-based
`TimelinePanel` (points-of-interest, hand-rolled with d3-scale/d3-zoom) and
a virtualized `LogViewerPanel` (full log text), coordinated through a
Zustand store — clicking a timeline marker sets the selected log line;
`useLiveTail` keeps both in sync with the SSE stream.
