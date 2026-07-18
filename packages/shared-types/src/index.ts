import { z } from "zod";

export const EventType = z.enum([
  "join",
  "leave",
  "death",
  "command",
  "server_start",
  "server_stop",
  "sleep",
  "warning",
]);
export type EventType = z.infer<typeof EventType>;

export const Severity = z.enum(["normal", "high"]);
export type Severity = z.infer<typeof Severity>;

export const Confidence = z.enum(["confirmed", "heuristic"]);
export type Confidence = z.infer<typeof Confidence>;

export const RawLine = z.object({
  id: z.number(),
  fileKey: z.string(),
  lineNo: z.number(),
  tsMs: z.number(),
  rawText: z.string(),
  level: z.string().nullable(),
  thread: z.string().nullable(),
});
export type RawLine = z.infer<typeof RawLine>;

export const TimelineEvent = z.object({
  id: z.number(),
  tsMs: z.number(),
  eventType: EventType,
  actor: z.string().nullable(),
  target: z.string().nullable(),
  summary: z.string(),
  severity: Severity,
  confidence: Confidence,
  rawLineId: z.number(),
});
export type TimelineEvent = z.infer<typeof TimelineEvent>;

export const EventsQuery = z.object({
  from: z.coerce.number().optional(),
  to: z.coerce.number().optional(),
  types: z
    .string()
    .optional()
    .transform((v) => (v ? (v.split(",") as EventType[]) : undefined)),
  actor: z.string().optional(),
  limit: z.coerce.number().min(1).max(2000).default(500),
});
export type EventsQuery = z.infer<typeof EventsQuery>;

export const RawLinesQuery = z.object({
  aroundId: z.coerce.number().optional(),
  before: z.coerce.number().min(0).max(500).default(100),
  after: z.coerce.number().min(0).max(500).default(100),
});
export type RawLinesQuery = z.infer<typeof RawLinesQuery>;

export const RawLinesSearchQuery = z.object({
  q: z.string().min(1),
  from: z.coerce.number().optional(),
  to: z.coerce.number().optional(),
  limit: z.coerce.number().min(1).max(500).default(100),
});
export type RawLinesSearchQuery = z.infer<typeof RawLinesSearchQuery>;

export const StreamMessage = z.union([
  z.object({ type: z.literal("event"), data: TimelineEvent }),
  z.object({ type: z.literal("raw_line"), data: RawLine }),
]);
export type StreamMessage = z.infer<typeof StreamMessage>;

export const LoginRequest = z.object({
  password: z.string().min(1),
});
export type LoginRequest = z.infer<typeof LoginRequest>;
