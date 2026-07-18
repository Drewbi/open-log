import type { EventType } from "@mc-log-timeline/shared-types";

export interface LogRule {
  id: string;
  pattern: string;
  flags?: string;
  /** For isPOI:false rules this is never stored (only used to suppress the
   * line from the death heuristic fallback), so any valid value works. */
  eventType: EventType;
  isPOI: boolean;
  priority: number;
  confidence: "confirmed" | "heuristic";
  severity: "normal" | "high";
  summaryTemplate: string;
  /** Only match when the {actor} capture is a name we've already seen join. Used for the generic death fallback so ordinary chat/broadcast lines aren't misclassified. */
  requiresKnownActor?: boolean;
}
