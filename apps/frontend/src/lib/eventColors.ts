import type { EventType } from "@mc-log-timeline/shared-types";

// One distinct color per event type (not just a severity channel) so markers
// are identifiable by color alone, in addition to their glyph shape. Command
// stays the "critical" orange accent used elsewhere in the UI for high
// severity/live/selection state.
export const EVENT_COLORS: Record<EventType, string> = {
  join: "#4ade80",
  leave: "#94a3b8",
  chat: "#38bdf8",
  death: "#f87171",
  command: "#ff6a1a",
  server_start: "#2ab85e",
  server_stop: "#e04c4c",
  sleep: "#a78bfa",
  warning: "#f472b6",
};

export const CRITICAL_COLOR = EVENT_COLORS.command;
