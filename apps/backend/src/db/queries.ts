import type { EventType } from "@mc-log-timeline/shared-types";
import { db } from "./index.js";

export interface RawLineInsert {
  source: "file";
  fileKey: string;
  lineNo: number;
  tsMs: number;
  rawText: string;
  level: string | null;
  thread: string | null;
}

export interface EventInsert {
  tsMs: number;
  eventType: EventType;
  actor: string | null;
  target: string | null;
  summary: string;
  severity: "normal" | "high";
  confidence: "confirmed" | "heuristic";
  rawLineId: number;
}

const insertRawLineStmt = db.prepare(`
  INSERT OR IGNORE INTO raw_lines (source, file_key, line_no, ts_ms, raw_text, level, thread)
  VALUES (@source, @fileKey, @lineNo, @tsMs, @rawText, @level, @thread)
`);

const getRawLineIdStmt = db.prepare(`
  SELECT id FROM raw_lines WHERE file_key = ? AND line_no = ?
`);

export function insertRawLine(line: RawLineInsert): number {
  const result = insertRawLineStmt.run(line);
  if (result.changes > 0) {
    return Number(result.lastInsertRowid);
  }
  const existing = getRawLineIdStmt.get(line.fileKey, line.lineNo) as { id: number } | undefined;
  if (!existing) {
    throw new Error(`raw_line insert ignored but no existing row found for ${line.fileKey}:${line.lineNo}`);
  }
  return existing.id;
}

const insertEventStmt = db.prepare(`
  INSERT INTO events (ts_ms, event_type, actor, target, summary, severity, confidence, raw_line_id)
  VALUES (@tsMs, @eventType, @actor, @target, @summary, @severity, @confidence, @rawLineId)
`);

export function insertEvent(event: EventInsert): number {
  const result = insertEventStmt.run(event);
  return Number(result.lastInsertRowid);
}

export interface Checkpoint {
  fileKey: string;
  inode: string | null;
  byteOffset: number;
  lineNo: number;
  lastTsMs: number | null;
  completed: boolean;
}

const getCheckpointStmt = db.prepare(`
  SELECT file_key as fileKey, inode, byte_offset as byteOffset, line_no as lineNo,
         last_ts_ms as lastTsMs, completed
  FROM ingest_checkpoints WHERE file_key = ?
`);

export function getCheckpoint(fileKey: string): Checkpoint | undefined {
  const row = getCheckpointStmt.get(fileKey) as
    | (Omit<Checkpoint, "completed"> & { completed: number })
    | undefined;
  if (!row) return undefined;
  return { ...row, completed: row.completed === 1 };
}

const upsertCheckpointStmt = db.prepare(`
  INSERT INTO ingest_checkpoints (file_key, inode, byte_offset, line_no, last_ts_ms, completed, updated_at)
  VALUES (@fileKey, @inode, @byteOffset, @lineNo, @lastTsMs, @completed, unixepoch())
  ON CONFLICT(file_key) DO UPDATE SET
    inode = excluded.inode,
    byte_offset = excluded.byte_offset,
    line_no = excluded.line_no,
    last_ts_ms = excluded.last_ts_ms,
    completed = excluded.completed,
    updated_at = unixepoch()
`);

export function upsertCheckpoint(checkpoint: Checkpoint): void {
  upsertCheckpointStmt.run({ ...checkpoint, completed: checkpoint.completed ? 1 : 0 });
}

export function withTransaction<T>(fn: () => T): T {
  return db.transaction(fn)();
}

const getKnownActorsStmt = db.prepare(`
  SELECT DISTINCT actor FROM events WHERE event_type = 'join' AND actor IS NOT NULL
`);

export function getKnownActors(): Set<string> {
  const rows = getKnownActorsStmt.all() as Array<{ actor: string }>;
  return new Set(rows.map((r) => r.actor));
}

export interface EventRow {
  id: number;
  tsMs: number;
  eventType: EventType;
  actor: string | null;
  target: string | null;
  summary: string;
  severity: "normal" | "high";
  confidence: "confirmed" | "heuristic";
  rawLineId: number;
}

export interface ListEventsParams {
  from?: number;
  to?: number;
  types?: string[];
  actor?: string;
  limit: number;
}

export function listEvents(params: ListEventsParams): EventRow[] {
  const clauses: string[] = [];
  const args: Record<string, unknown> = { limit: params.limit };

  if (params.from !== undefined) {
    clauses.push("ts_ms >= @from");
    args.from = params.from;
  }
  if (params.to !== undefined) {
    clauses.push("ts_ms <= @to");
    args.to = params.to;
  }
  if (params.actor) {
    clauses.push("actor = @actor");
    args.actor = params.actor;
  }
  if (params.types && params.types.length > 0) {
    const placeholders = params.types.map((_, i) => `@type${i}`);
    for (const [i, t] of params.types.entries()) args[`type${i}`] = t;
    clauses.push(`event_type IN (${placeholders.join(", ")})`);
  }

  const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
  const rows = db
    .prepare(
      `SELECT id, ts_ms as tsMs, event_type as eventType, actor, target, summary,
              severity, confidence, raw_line_id as rawLineId
       FROM events ${where} ORDER BY ts_ms ASC LIMIT @limit`,
    )
    .all(args) as EventRow[];
  return rows;
}

const getEventByIdStmt = db.prepare(`
  SELECT id, ts_ms as tsMs, event_type as eventType, actor, target, summary,
         severity, confidence, raw_line_id as rawLineId
  FROM events WHERE id = ?
`);

export function getEventById(id: number): EventRow | undefined {
  return getEventByIdStmt.get(id) as EventRow | undefined;
}

export interface RawLineRow {
  id: number;
  fileKey: string;
  lineNo: number;
  tsMs: number;
  rawText: string;
  level: string | null;
  thread: string | null;
}

const rawLineColumns = `id, file_key as fileKey, line_no as lineNo, ts_ms as tsMs,
  raw_text as rawText, level, thread`;

export function listRawLinesAround(aroundId: number | undefined, before: number, after: number): RawLineRow[] {
  if (aroundId === undefined) {
    return db
      .prepare(`SELECT ${rawLineColumns} FROM raw_lines ORDER BY id DESC LIMIT @limit`)
      .all({ limit: before + after + 1 })
      .reverse() as RawLineRow[];
  }
  const beforeRows = db
    .prepare(`SELECT ${rawLineColumns} FROM raw_lines WHERE id < @id ORDER BY id DESC LIMIT @before`)
    .all({ id: aroundId, before })
    .reverse() as RawLineRow[];
  const centerRow = db.prepare(`SELECT ${rawLineColumns} FROM raw_lines WHERE id = ?`).get(aroundId) as
    | RawLineRow
    | undefined;
  const afterRows = db
    .prepare(`SELECT ${rawLineColumns} FROM raw_lines WHERE id > @id ORDER BY id ASC LIMIT @after`)
    .all({ id: aroundId, after }) as RawLineRow[];
  return [...beforeRows, ...(centerRow ? [centerRow] : []), ...afterRows];
}

export interface SearchRawLinesParams {
  q: string;
  from?: number;
  to?: number;
  limit: number;
}

export function searchRawLines(params: SearchRawLinesParams): RawLineRow[] {
  const clauses = ["raw_lines_fts MATCH @q"];
  const args: Record<string, unknown> = { q: params.q, limit: params.limit };
  if (params.from !== undefined) {
    clauses.push("r.ts_ms >= @from");
    args.from = params.from;
  }
  if (params.to !== undefined) {
    clauses.push("r.ts_ms <= @to");
    args.to = params.to;
  }
  return db
    .prepare(
      `SELECT r.id, r.file_key as fileKey, r.line_no as lineNo, r.ts_ms as tsMs,
              r.raw_text as rawText, r.level, r.thread
       FROM raw_lines_fts
       JOIN raw_lines r ON r.id = raw_lines_fts.rowid
       WHERE ${clauses.join(" AND ")}
       ORDER BY r.ts_ms DESC LIMIT @limit`,
    )
    .all(args) as RawLineRow[];
}
