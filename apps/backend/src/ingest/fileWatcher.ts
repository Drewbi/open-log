import { EventEmitter } from "node:events";
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import chokidar from "chokidar";
import type { EventType } from "@open-log/shared-types";
import { config } from "../config.js";
import {
  deleteCheckpoint,
  getCheckpoint,
  getKnownActors,
  getRawLineText,
  insertEvent,
  insertRawLine,
  reassignRawLines,
  upsertCheckpoint,
  withTransaction,
} from "../db/queries.js";
import { redactLine } from "../redact/redact.js";
import type { RuleEngine } from "../rules/engine.js";
import { parseLine } from "./lineParser.js";
import { DayClock, dateFromRotatedFilename } from "./timestamp.js";

export const ingestEvents = new EventEmitter();

const LATEST_LOG = "latest.log";

export interface IngestState {
  knownActors: Set<string>;
}

function isRotatedFile(fileName: string): boolean {
  return fileName !== LATEST_LOG && /\.log(\.gz)?$/.test(fileName);
}

function splitLines(text: string): string[] {
  const trimmed = text.endsWith("\n") ? text.slice(0, -1) : text;
  if (trimmed.length === 0) return [];
  return trimmed.split("\n").map((l) => l.replace(/\r$/, ""));
}

// Only called for isPOI rules — the events table holds timeline POIs only,
// so non-POI matches never reach here.
function emitEvent(
  eventType: EventType,
  actor: string | null,
  target: string | null,
  summary: string,
  severity: "normal" | "high",
  confidence: "confirmed" | "heuristic",
  tsMs: number,
  rawLineId: number,
): void {
  const eventId = insertEvent({
    tsMs,
    eventType,
    actor,
    target,
    summary,
    severity,
    confidence,
    rawLineId,
  });
  ingestEvents.emit("event", {
    id: eventId,
    tsMs,
    eventType,
    actor,
    target,
    summary,
    severity,
    confidence,
    rawLineId,
  });
}

function processLines(
  fileKey: string,
  startLineNo: number,
  lines: string[],
  clock: DayClock,
  ruleEngine: RuleEngine,
  state: IngestState,
): number {
  let lineNo = startLineNo;
  withTransaction(() => {
    for (const line of lines) {
      lineNo += 1;
      // Parse the original line first so a redaction false-positive can never
      // corrupt the timestamp/thread/level structure; redact only for storage
      // and rule matching afterwards.
      const parsed = parseLine(line, clock);
      const tsMs = parsed ? parsed.tsMs : clock.lastResolvedMs();
      const redactedRawText = redactLine(line);

      const rawLineId = insertRawLine({
        source: "file",
        fileKey,
        lineNo,
        tsMs,
        rawText: redactedRawText,
        level: parsed?.level ?? null,
        thread: parsed?.thread ?? null,
      });
      ingestEvents.emit("raw_line", {
        id: rawLineId,
        fileKey,
        lineNo,
        tsMs,
        rawText: redactedRawText,
        level: parsed?.level ?? null,
        thread: parsed?.thread ?? null,
      });

      if (!parsed) continue;
      const match = ruleEngine.match(redactLine(parsed.message), state.knownActors);
      if (!match) continue;

      if (match.rule.eventType === ("join" as EventType) && match.actor) {
        state.knownActors.add(match.actor);
      }

      if (!match.rule.isPOI) continue;
      emitEvent(
        match.rule.eventType,
        match.actor,
        match.target,
        match.summary,
        match.rule.severity,
        match.rule.confidence,
        tsMs,
        rawLineId,
      );
    }
  });
  return lineNo;
}

function readRotatedFile(dir: string, fileName: string): { lines: string[]; byteLength: number } {
  const filePath = path.join(dir, fileName);
  const raw = fileName.endsWith(".gz")
    ? zlib.gunzipSync(fs.readFileSync(filePath))
    : fs.readFileSync(filePath);
  return { lines: splitLines(raw.toString("utf-8")), byteLength: raw.length };
}

function processRotatedFile(
  dir: string,
  fileName: string,
  ruleEngine: RuleEngine,
  state: IngestState,
): void {
  const existing = getCheckpoint(fileName);
  if (existing?.completed) return;

  const { lines, byteLength } = readRotatedFile(dir, fileName);

  // A non-completed checkpoint with lineNo > 0 means resolveRotation handed
  // this file the rows already ingested live from latest.log — resume after
  // them instead of re-ingesting (which is what used to duplicate every POI
  // after each rotation).
  const startLineNo = existing?.lineNo ?? 0;
  const remaining = lines.slice(startLineNo);

  // When resuming, seed the clock from where the live tail left off (the
  // filename's start date would be a day off if the file spans midnight) and
  // prime it with the tail's last time-of-day so rollover detection still
  // works across the resume point.
  let clock: DayClock;
  if (existing?.lastTsMs != null) {
    const lastLocal = new Date(existing.lastTsMs + config.serverTzOffsetHours * 3600_000);
    clock = new DayClock(lastLocal.toISOString().slice(0, 10), config.serverTzOffsetHours);
    clock.resolve(lastLocal.getUTCHours(), lastLocal.getUTCMinutes(), lastLocal.getUTCSeconds());
  } else {
    const seedDate = dateFromRotatedFilename(fileName) ?? new Date().toISOString().slice(0, 10);
    clock = new DayClock(seedDate, config.serverTzOffsetHours);
  }

  const finalLineNo = processLines(fileName, startLineNo, remaining, clock, ruleEngine, state);
  upsertCheckpoint({
    fileKey: fileName,
    inode: null,
    byteOffset: byteLength,
    lineNo: finalLineNo,
    lastTsMs: remaining.length > 0 ? clock.lastResolvedMs() : (existing?.lastTsMs ?? clock.lastResolvedMs()),
    completed: true,
  });
}

function readNewLines(
  filePath: string,
  fromOffset: number,
): { lines: string[]; newOffset: number } {
  const stat = fs.statSync(filePath);
  if (stat.size <= fromOffset) return { lines: [], newOffset: fromOffset };

  const fd = fs.openSync(filePath, "r");
  const length = stat.size - fromOffset;
  const buffer = Buffer.alloc(length);
  fs.readSync(fd, buffer, 0, length, fromOffset);
  fs.closeSync(fd);

  const text = buffer.toString("utf-8");
  const lastNewline = text.lastIndexOf("\n");
  if (lastNewline === -1) return { lines: [], newOffset: fromOffset };

  const complete = text.slice(0, lastNewline);
  const consumedBytes = Buffer.byteLength(text.slice(0, lastNewline + 1), "utf-8");
  return { lines: splitLines(`${complete}\n`), newOffset: fromOffset + consumedBytes };
}

function processLatestFile(dir: string, ruleEngine: RuleEngine, state: IngestState): void {
  const filePath = path.join(dir, LATEST_LOG);
  if (!fs.existsSync(filePath)) return;

  const stat = fs.statSync(filePath);
  const inode = String(stat.ino);
  const existing = getCheckpoint(LATEST_LOG);

  const sameFile = existing && existing.inode === inode;
  const startOffset = sameFile ? existing.byteOffset : 0;
  const startLineNo = sameFile ? existing.lineNo : 0;

  const seedDate =
    sameFile && existing?.lastTsMs
      ? new Date(existing.lastTsMs).toISOString().slice(0, 10)
      : new Date(stat.mtimeMs).toISOString().slice(0, 10);
  const clock = new DayClock(seedDate, config.serverTzOffsetHours);

  const { lines, newOffset } = readNewLines(filePath, startOffset);
  if (lines.length === 0) {
    if (!sameFile) {
      upsertCheckpoint({
        fileKey: LATEST_LOG,
        inode,
        byteOffset: startOffset,
        lineNo: startLineNo,
        lastTsMs: existing?.lastTsMs ?? null,
        completed: false,
      });
    }
    return;
  }

  const finalLineNo = processLines(LATEST_LOG, startLineNo, lines, clock, ruleEngine, state);
  upsertCheckpoint({
    fileKey: LATEST_LOG,
    inode,
    byteOffset: newOffset,
    lineNo: finalLineNo,
    lastTsMs: clock.lastResolvedMs(),
    completed: false,
  });
}

// Grace period for the window where latest.log has been renamed away but its
// rotated .gz hasn't been written yet — during it we hold off tailing the new
// latest.log rather than orphaning the old generation's rows prematurely.
const ROTATION_GRACE_MS = 30_000;
let rotationPendingSinceMs: number | null = null;

// Detects that latest.log was rotated (inode changed / file gone) and hands
// the already-ingested rows — keyed 'latest.log' — over to the rotated file
// they became: re-key the rows to that filename and leave a non-completed
// checkpoint at the tailed line count so processRotatedFile resumes after
// them. Without this handover the rotated file's backfill re-ingested the
// whole file under its own file_key (duplicating every POI event), and the
// new latest.log generation's line numbers collided with the old rows, so
// INSERT OR IGNORE silently attached new events to stale raw lines.
//
// Returns false while a rotation is detected but the rotated file hasn't
// appeared yet — the caller must skip tailing latest.log for that sweep so
// the old rows stay claimable.
function resolveRotation(dir: string, rotatedNames: string[]): boolean {
  const cp = getCheckpoint(LATEST_LOG);
  if (!cp) return true;

  const latestPath = path.join(dir, LATEST_LOG);
  if (fs.existsSync(latestPath) && String(fs.statSync(latestPath).ino) === cp.inode) {
    rotationPendingSinceMs = null;
    return true;
  }

  if (cp.lineNo > 0) {
    const firstStored = getRawLineText(LATEST_LOG, 1);
    const lastStored = getRawLineText(LATEST_LOG, cp.lineNo);
    // The rotated file we're looking for contains everything we tailed, in
    // order, from line 1 — verify by matching first and last tailed lines
    // (stored redacted, so redact the file's lines before comparing). Newest
    // candidates first: ours is the most recently rotated.
    const candidates = rotatedNames.filter((f) => !getCheckpoint(f)).sort().reverse();
    for (const fileName of candidates) {
      const { lines } = readRotatedFile(dir, fileName);
      if (lines.length < cp.lineNo) continue;
      if (redactLine(lines[0]) !== firstStored) continue;
      if (redactLine(lines[cp.lineNo - 1]) !== lastStored) continue;
      withTransaction(() => {
        reassignRawLines(LATEST_LOG, fileName);
        upsertCheckpoint({
          fileKey: fileName,
          inode: null,
          byteOffset: 0,
          lineNo: cp.lineNo,
          lastTsMs: cp.lastTsMs,
          completed: false,
        });
        deleteCheckpoint(LATEST_LOG);
      });
      rotationPendingSinceMs = null;
      return true;
    }

    // No rotated file matches yet — most likely mid-rotation (renamed, not
    // yet gzipped). Hold off briefly; if nothing ever shows up, park the rows
    // under a synthetic key so the new generation can't collide with them.
    // (If their rotated file appears after that, it backfills in full and
    // duplicates that one generation — the bounded worst case, preferred over
    // stalling ingestion indefinitely.)
    if (rotationPendingSinceMs === null) rotationPendingSinceMs = Date.now();
    if (Date.now() - rotationPendingSinceMs < ROTATION_GRACE_MS) return false;
    withTransaction(() => {
      reassignRawLines(LATEST_LOG, `${LATEST_LOG}.orphaned.${Date.now()}`);
      deleteCheckpoint(LATEST_LOG);
    });
  } else {
    deleteCheckpoint(LATEST_LOG);
  }
  rotationPendingSinceMs = null;
  return true;
}

export function runIngestSweep(ruleEngine: RuleEngine, state: IngestState): void {
  const dir = config.logsDir;
  if (!fs.existsSync(dir)) return;

  const entries = fs.readdirSync(dir);
  const rotatedNames = entries.filter(isRotatedFile).sort();
  // Must run before the rotated-file loop so a freshly rotated file gets its
  // resume checkpoint before processRotatedFile would backfill it from 0.
  const canTailLatest = resolveRotation(dir, rotatedNames);
  for (const fileName of rotatedNames) {
    processRotatedFile(dir, fileName, ruleEngine, state);
  }
  if (canTailLatest) processLatestFile(dir, ruleEngine, state);
}

export function startIngestion(ruleEngine: RuleEngine): () => void {
  const state: IngestState = { knownActors: getKnownActors() };

  runIngestSweep(ruleEngine, state);

  const watcher = chokidar.watch(config.logsDir, {
    usePolling: config.watchUsePolling,
    interval: 1000,
    ignoreInitial: true,
  });
  const sweep = () => runIngestSweep(ruleEngine, state);
  watcher.on("add", sweep).on("change", sweep);

  return () => {
    void watcher.close();
  };
}
