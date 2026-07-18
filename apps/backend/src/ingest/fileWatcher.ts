import { EventEmitter } from "node:events";
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import chokidar from "chokidar";
import type { EventType } from "@mc-log-timeline/shared-types";
import { config } from "../config.js";
import {
  getCheckpoint,
  getKnownActors,
  insertEvent,
  insertRawLine,
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

function processRotatedFile(
  dir: string,
  fileName: string,
  ruleEngine: RuleEngine,
  state: IngestState,
): void {
  const existing = getCheckpoint(fileName);
  if (existing?.completed) return;

  const filePath = path.join(dir, fileName);
  const raw = fileName.endsWith(".gz")
    ? zlib.gunzipSync(fs.readFileSync(filePath))
    : fs.readFileSync(filePath);
  const lines = splitLines(raw.toString("utf-8"));

  const seedDate = dateFromRotatedFilename(fileName) ?? new Date().toISOString().slice(0, 10);
  const clock = new DayClock(seedDate, config.serverTzOffsetHours);

  const finalLineNo = processLines(fileName, 0, lines, clock, ruleEngine, state);
  upsertCheckpoint({
    fileKey: fileName,
    inode: null,
    byteOffset: raw.length,
    lineNo: finalLineNo,
    lastTsMs: clock.lastResolvedMs(),
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

export function runIngestSweep(ruleEngine: RuleEngine, state: IngestState): void {
  const dir = config.logsDir;
  if (!fs.existsSync(dir)) return;

  const entries = fs.readdirSync(dir);
  for (const fileName of entries.filter(isRotatedFile).sort()) {
    processRotatedFile(dir, fileName, ruleEngine, state);
  }
  processLatestFile(dir, ruleEngine, state);
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
