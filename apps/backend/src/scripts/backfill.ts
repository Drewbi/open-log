import { config } from "../config.js";
import { db } from "../db/index.js";
import { RuleEngine } from "../rules/engine.js";
import { runIngestSweep, type IngestState } from "../ingest/fileWatcher.js";
import { getKnownActors } from "../db/queries.js";

const ruleEngine = RuleEngine.loadFromFiles(config.rulesDefaultPath, config.rulesCustomPath);
const state: IngestState = { knownActors: getKnownActors() };

runIngestSweep(ruleEngine, state);

const rawCount = (db.prepare("SELECT COUNT(*) as c FROM raw_lines").get() as { c: number }).c;
const eventCount = (db.prepare("SELECT COUNT(*) as c FROM events").get() as { c: number }).c;
const byType = db
  .prepare("SELECT event_type, confidence, COUNT(*) as c FROM events GROUP BY event_type, confidence ORDER BY c DESC")
  .all() as Array<{ event_type: string; confidence: string; c: number }>;

console.log(`raw_lines: ${rawCount}`);
console.log(`events: ${eventCount}`);
for (const row of byType) {
  console.log(`  ${row.event_type} (${row.confidence}): ${row.c}`);
}
