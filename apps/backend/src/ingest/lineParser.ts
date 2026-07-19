import type { DayClock } from "./timestamp.js";

export interface ParsedLine {
  tsMs: number;
  level: string | null;
  thread: string | null;
  message: string;
}

export interface LineParts {
  hh: number;
  mm: number;
  ss: number;
  level: string;
  thread: string;
  message: string;
}

// Matches standard log4j lines: "[HH:mm:ss] [Thread/LEVEL]: message", with an
// optional extra "[logger name/]" segment that Forge sometimes inserts before
// the colon. Lines that don't match (stack traces, wrapped continuations)
// return null and are stored as raw lines using the previous line's timestamp.
const LINE_RE = /^\[(\d{2}):(\d{2}):(\d{2})]\s+\[([^\]/]+)\/(\w+)](?:\s*\[[^\]]*])?:\s?(.*)$/;

// Structural split only, no date resolution — also safe to run on already-
// redacted stored lines (reprocess), since redaction can't produce anything
// matching the bracketed prefix.
export function splitLineParts(rawText: string): LineParts | null {
  const m = LINE_RE.exec(rawText);
  if (!m) return null;
  const [, hh, mm, ss, thread, level, message] = m;
  return { hh: Number(hh), mm: Number(mm), ss: Number(ss), thread, level, message };
}

export function parseLine(rawText: string, clock: DayClock): ParsedLine | null {
  const parts = splitLineParts(rawText);
  if (!parts) return null;
  const tsMs = clock.resolve(parts.hh, parts.mm, parts.ss);
  return { tsMs, level: parts.level, thread: parts.thread, message: parts.message };
}
