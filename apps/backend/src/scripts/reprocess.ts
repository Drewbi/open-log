import { config } from "../config.js";
import { db } from "../db/index.js";
import { insertEvent, withTransaction } from "../db/queries.js";
import { splitLineParts } from "../ingest/lineParser.js";
import { RuleEngine } from "../rules/engine.js";

// Rebuilds the events table from stored raw_lines under the current rule set,
// without touching log files, checkpoints, or the FTS index. Use after editing
// config/rules.custom.json to apply new rules to already-ingested history:
//
//   docker compose restart open-log   # live ingestion picks up the new rules
//   docker compose exec open-log pnpm reprocess
//
// Safe to run alongside the live server: only events for lines that exist at
// start (id <= maxId) are deleted and rebuilt; lines ingested while this runs
// are the live watcher's responsibility, so neither writer duplicates the
// other. Idempotent — if interrupted, just run it again.

const BATCH_SIZE = 5000;

const ruleEngine = RuleEngine.loadFromFiles(config.rulesDefaultPath, config.rulesCustomPath);

const { maxId } = db.prepare("SELECT MAX(id) as maxId FROM raw_lines").get() as {
  maxId: number | null;
};
if (!maxId) {
  console.log("raw_lines is empty — nothing to reprocess.");
  process.exit(0);
}

const deleted = db.prepare("DELETE FROM events WHERE raw_line_id <= ?").run(maxId).changes;

const selectBatch = db.prepare(`
  SELECT id, ts_ms as tsMs, raw_text as rawText
  FROM raw_lines WHERE id > ? AND id <= ? ORDER BY id LIMIT ?
`);

// Replaying in id order (= original ingest order) rebuilds knownActors the
// same way live ingestion did, so the requiresKnownActor death fallback
// makes identical decisions. Batched transactions keep each write lock short
// so a concurrently running server doesn't hit SQLITE_BUSY.
const knownActors = new Set<string>();
let cursor = 0;
let scanned = 0;
let inserted = 0;

for (;;) {
  const rows = selectBatch.all(cursor, maxId, BATCH_SIZE) as Array<{
    id: number;
    tsMs: number;
    rawText: string;
  }>;
  if (rows.length === 0) break;

  withTransaction(() => {
    for (const row of rows) {
      const parts = splitLineParts(row.rawText);
      if (!parts) continue;
      // raw_text is stored redacted, so parts.message is already the redacted
      // message the live pipeline matches against.
      const match = ruleEngine.match(parts.message, knownActors);
      if (!match) continue;

      if (match.rule.eventType === "join" && match.actor) {
        knownActors.add(match.actor);
      }

      if (!match.rule.isPOI) continue;
      insertEvent({
        tsMs: row.tsMs,
        eventType: match.rule.eventType,
        actor: match.actor,
        target: match.target,
        summary: match.summary,
        severity: match.rule.severity,
        confidence: match.rule.confidence,
        rawLineId: row.id,
      });
      inserted += 1;
    }
  });

  scanned += rows.length;
  cursor = rows[rows.length - 1].id;
}

console.log(`Reprocessed ${scanned} raw lines: ${deleted} events deleted, ${inserted} events created.`);

const byType = db
  .prepare("SELECT event_type, confidence, COUNT(*) as c FROM events GROUP BY event_type, confidence ORDER BY c DESC")
  .all() as Array<{ event_type: string; confidence: string; c: number }>;
for (const row of byType) {
  console.log(`  ${row.event_type} (${row.confidence}): ${row.c}`);
}
console.log("\nNote: open browser tabs won't refetch the timeline on their own — reload the page.");
