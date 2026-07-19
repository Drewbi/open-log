# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A web app that ingests a Minecraft server's log files, parses them into a searchable timeline of events (joins/leaves/chat/deaths/operator commands/server sleep-wake/start-stop/warnings), and presents two coordinated views: a Canvas timeline of "points of interest" above a virtualized full-log viewer below. Clicking a timeline marker scrolls to and highlights the corresponding raw log line. Built for a single self-hosted, publicly-exposed instance (shared-password auth, no user accounts).

## Commands

Run everything from the repo root (pnpm workspace monorepo).

```bash
pnpm install                    # installs all 4 workspace packages at once

pnpm dev:backend                # tsx watch on apps/backend — API + log ingestion, :4000
pnpm dev:frontend                # vite dev server on apps/frontend, :5173, proxies /api -> :4000

pnpm typecheck                  # tsc --noEmit across all packages (no test suite exists)
pnpm build                      # production frontend build only (see "No backend build step" below)

pnpm --filter @mc-log-timeline/backend backfill        # one-off: re-scan MC_LOGS_DIR into SQLite, print counts
pnpm --filter @mc-log-timeline/backend hash-password <pw>  # generate AUTH_PASSWORD_HASH for .env
```

There is no lint config and no test runner in this repo — don't invent `pnpm lint`/`pnpm test` commands.

Backend env vars are read from `apps/backend/.env` (see `.env.example` there for the full list: `MC_LOGS_DIR`, `DB_PATH`, `PORT`, `SERVER_TZ_OFFSET_HOURS`, `WATCH_USE_POLLING`, `AUTH_PASSWORD_HASH`, `SESSION_SECRET`). Without `MC_LOGS_DIR` set, the backend defaults to `example-data/logs/` (real anonymized sample data checked into the repo) — useful for iterating on rule patterns without a live server.

Deployment is `docker compose build && docker compose up -d` at the repo root, using the root `.env.example` (`MC_DATA_DIR`, `DOMAIN`, plus the auth vars). Caddy fronts the app for automatic HTTPS; the app container itself publishes no ports.

## Architecture

### Monorepo layout

- `apps/backend` — Node/TS: log ingestion pipeline + Express API, one process.
- `apps/frontend` — Vite/React/TS/Tailwind/shadcn.
- `packages/shared-types` — zod schemas (events, raw lines, query params) consumed directly as TS source by both apps; it has **no build step** and never will (see below).
- `config/rules.default.json` + `config/rules.custom.json` — the parsing rule set (data, not code — see "Rule engine").

### No backend build step, on purpose

`shared-types`' `package.json` `main` points straight at `src/index.ts`. Both `tsx` (backend) and Vite (frontend) transpile TS from workspace packages on the fly, so nothing needs pre-compiling in dev. In production the backend still runs via `tsx src/index.ts` (the `start` script) rather than compiled `dist/`, specifically to avoid Node's module resolution hitting `shared-types`' `.ts` `main` field and failing to execute it. `apps/backend`'s `build` script (plain `tsc`) exists only as an extra type-check gate, not part of the run path. Don't try to "fix" this into a `tsc`+`node dist/`-based prod setup without accounting for `shared-types`.

### Ingestion pipeline (`apps/backend/src/ingest/`)

`fileWatcher.ts` is the core loop: on startup and on every chokidar change event, it backfills any not-yet-completed rotated `*.log.gz` file (read once, whole file, marked completed) and incrementally tails `latest.log` from a stored byte offset. Per-file progress lives in the `ingest_checkpoints` table (`db/schema.ts`), keyed by filename with an inode check so log rotation (rename + truncate) is detected as a new file rather than corrupting the offset.

Per-line order of operations matters and is easy to get backwards:
1. **Parse the original, unredacted line first** (`lineParser.ts`) to extract timestamp/thread/level/message.
2. **Redact after parsing**, for storage and for rule matching. Redaction ran *before* parsing during initial development and an over-broad IPv6-address regex matched `HH:MM:SS` timestamps, silently corrupting every line's leading bracket. Keep parsing decoupled from redaction.
3. Run the rule engine against the redacted message; only insert an `events` row if the matched rule is `isPOI: true` (non-POI matches, e.g. anti-cheat/disconnect noise, exist purely to keep the death-heuristic fallback from misfiring — see below — and are otherwise discarded).

`timestamp.ts`'s `DayClock` reconstructs absolute dates from `latest.log`'s bare `HH:mm:ss` lines (no date in the file) by seeding from the rotated filename's embedded date or the previous checkpoint's last timestamp, and rolling the date forward when the clock appears to go backwards (midnight rollover).

There is no "wake" log line in itzg's autopause output (confirmed against real server logs — only `Server empty for N seconds, pausing` appears in the file log, no corresponding resume message). `fileWatcher.ts` instead synthesizes a `wake` event at the next `join` seen after a `sleep`, tracked via `IngestState.isAsleep`.

### Rule engine (`apps/backend/src/rules/`)

Every ingested line is stored in `raw_lines` unconditionally; matching a rule only controls whether a POI `events` row is also created. Rules are plain JSON (`config/rules.default.json`, merged with an optional `config/rules.custom.json`) — regex pattern, event type, POI flag, severity, confidence, summary template — specifically so new patterns (e.g. a modded death message) can be added without touching pipeline code. Since this is a modded (Forge/Fabric) server, death messages aren't a fixed vanilla set: there's a curated list of known phrases plus a last-resort fallback rule (`requiresKnownActor: true`, tried only if nothing else matched) that treats any bare `Name message` broadcast from a previously-seen player as a heuristic death. Rules that exist purely to suppress false positives on that fallback (e.g. `lost_connection`, `anticheat_moved_too_quickly`) are marked `isPOI: false` — their `eventType` value is otherwise unused/arbitrary.

### Data model (`apps/backend/src/db/`)

SQLite via better-sqlite3, WAL mode. `raw_lines` (every line, unique on `file_key, line_no`) and `events` (POIs only) are linked by `events.raw_line_id` — that FK is the entire mechanism behind "click a timeline marker → scroll to and highlight the log line" and behind search-result jumps. `raw_lines_fts` (FTS5) powers `/api/raw-lines/search`. `queries.ts` builds `raw-lines` windows by cursor-ranging on the autoincrement `id` (monotonic with time since the table is append-only), not by timestamp.

### API (`apps/backend/src/api/routes.ts`)

Routes registered before `apiRouter.use(requireAuth)` are public (`/health`, `/auth/status`, `/auth/login` rate-limited, `/auth/logout`); everything registered after requires a valid iron-session cookie — route order is what enforces this, not per-route middleware. `/stream` is Server-Sent Events, subscribing to the `ingestEvents` EventEmitter that `fileWatcher.ts` emits on (`"event"` and `"raw_line"`), so newly-ingested lines/events reach connected browsers without polling.

### Frontend (`apps/frontend/src/`)

`App.tsx` → `AuthGate` (only mounts `Dashboard` — and therefore only starts any data fetching or the SSE subscription — once `/api/auth/status` confirms a session; nothing leaks pre-auth). `Dashboard` composes `FilterBar`, `TimelinePanel`, `LogViewerPanel`, and the `useLiveTail` SSE hook, coordinated through a small Zustand store (`store/timelineStore.ts`): `selectedEventId`/`jumpToRawLineId` drive the click-to-highlight link between the two panels, `activeFilters` drives both the timeline's event-type query and the `FilterBar` toggles.

`TimelinePanel.tsx` is a hand-rolled Canvas renderer (not a charting library — chosen because the actual need, sparse clickable markers over a multi-year pannable range organized into fixed categories, doesn't fit prebuilt timeline/chart libraries) using `d3-scale`/`d3-zoom`. The one non-obvious invariant here: the zoom transform is calibrated against `baseScale`'s pixel *range*, which changes whenever the container resizes (`width` state, via `ResizeObserver`). Reusing the previous transform object against a newly-sized `baseScale` maps to the wrong dates — this actually happened during development (container starts at a placeholder width before `ResizeObserver` fires, then resizes). The fix is `visibleDomainRef`: the *logical* visible time range is the source of truth, and the transform is always re-derived from it (`baseScale(domainFrom/To)` → new `k`/translate) whenever `baseScale` changes, rather than carrying the old transform forward.

Events render on four fixed, independent tracks rather than one shared pool — `TYPE_TRACK` (a `Record<EventType, TrackId>`, so adding an `EventType` without assigning it a track fails to compile) maps each type to OPS/WARN/SERVER/PLAYERS. Commands (OPS) always render individually and labeled per product requirement; the other three tracks each run their own greedy lane-packing pass (interval scheduling by x-position), so a burst on one track never crowds out or clusters with another's events, and clustering into a numbered marker only kicks in once a track's own lanes are exhausted. WARN ships with no default rule — the obvious candidate, the per-tick-lag "Can't keep up!" warning, floods the timeline — but the track is wired up end-to-end and ready for a `rules.custom.json` rule targeting `eventType: "warning"`. `chat` (PLAYERS track) follows the same "wired up but not in `rules.default.json`" pattern for the same reason — on an active server it would dwarf join/leave/death in volume — but unlike `warning` it *is* turned on here, via a rule in `config/rules.custom.json` (`^<(?<actor>[A-Za-z0-9_]+)> (?<target>.+)$` against the vanilla `<Name> message` chat format). Since `rules.custom.json` is this deployment's own config rather than a shared default, remove that rule (or edit `isPOI` to `false`) if the volume proves overwhelming in practice. Markers are solid-color chips with the event's icon cut through in the chip's own color (`drawGlyph`), and the timeline also draws a video-editor-style playhead at the `playheadTsMs` of whichever log line is hovered (or, absent a hover, selected) in `LogViewerPanel`.

`LogViewerPanel.tsx` uses `@tanstack/react-virtual` with dynamic row measurement (log lines wrap — the row markup must keep the text cell as a flex child with `min-w-0`, since a flex item's default `min-width: auto` otherwise lets a long line grow the row instead of wrapping it). Auto-scroll to the tail only fires when the user hasn't manually scrolled up (`isAtBottomRef`, tracked via the scroll container's `onScroll`). `jumpToRawLineId` (set by clicking a timeline marker or search result, to show a fixed window around that line) is only ever *set* — nothing resets it back to `null` except the store's `returnToLiveTail` action, which the "Jump to live" button calls whenever the view isn't currently the live tail at the bottom. Without that button also covering jump mode (not just "scrolled up while in tail mode"), there'd be no way back to the tail short of reloading the page.

`useLiveTail.ts` appends incoming `raw_line` SSE messages directly into the react-query cache for the tail query (`["raw-lines", null]` — must match `LogViewerPanel`'s tail queryKey exactly) and debounce-invalidates the `timeline-events` query on `event` messages, rather than refetching per-message.
