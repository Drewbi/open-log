import type { DayClock } from "./timestamp.js";

export interface ParsedLine {
  tsMs: number;
  level: string | null;
  thread: string | null;
  message: string;
}

// Matches standard log4j lines: "[HH:mm:ss] [Thread/LEVEL]: message", with an
// optional extra "[logger name/]" segment that Forge sometimes inserts before
// the colon. Lines that don't match (stack traces, wrapped continuations)
// return null and are stored as raw lines using the previous line's timestamp.
const LINE_RE = /^\[(\d{2}):(\d{2}):(\d{2})]\s+\[([^\]/]+)\/(\w+)](?:\s*\[[^\]]*])?:\s?(.*)$/;

export function parseLine(rawText: string, clock: DayClock): ParsedLine | null {
  const m = LINE_RE.exec(rawText);
  if (!m) return null;
  const [, hh, mm, ss, thread, level, message] = m;
  const tsMs = clock.resolve(Number(hh), Number(mm), Number(ss));
  return { tsMs, level, thread, message };
}
