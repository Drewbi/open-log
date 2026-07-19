import { create } from "zustand";
import type { EventType } from "@mc-log-timeline/shared-types";

export interface TimeRange {
  from: number;
  to: number;
}

interface TimelineState {
  selectedEventId: number | null;
  jumpToRawLineId: number | null;
  visibleTimeRange: TimeRange;
  activeFilters: Set<EventType>;
  liveTailEnabled: boolean;
  /** ts_ms of whichever log line is currently hovered (or, absent a hover,
   * selected) in the log viewer — drives the timeline's scrubber/playhead. */
  playheadTsMs: number | null;
  /** Set when the log viewer wants the timeline to pan/zoom to a specific
   * instant (e.g. clicking a log line). `requestId` increments on every call
   * so the timeline can detect a fresh request even when `tsMs` repeats. */
  focusRequest: { tsMs: number; requestId: number } | null;
  selectEvent: (eventId: number | null, rawLineId: number | null) => void;
  jumpToRawLine: (rawLineId: number) => void;
  returnToLiveTail: () => void;
  setVisibleTimeRange: (range: TimeRange) => void;
  toggleFilter: (type: EventType) => void;
  setFilters: (types: EventType[]) => void;
  setLiveTailEnabled: (enabled: boolean) => void;
  setPlayheadTsMs: (tsMs: number | null) => void;
  focusOnTimestamp: (tsMs: number) => void;
}

const ONE_DAY_MS = 24 * 60 * 60 * 1000;

export const useTimelineStore = create<TimelineState>((set) => ({
  selectedEventId: null,
  jumpToRawLineId: null,
  visibleTimeRange: { from: Date.now() - 2 * ONE_DAY_MS, to: Date.now() },
  activeFilters: new Set(),
  liveTailEnabled: true,
  playheadTsMs: null,
  focusRequest: null,
  selectEvent: (eventId, rawLineId) => set({ selectedEventId: eventId, jumpToRawLineId: rawLineId }),
  jumpToRawLine: (rawLineId) => set({ selectedEventId: null, jumpToRawLineId: rawLineId }),
  returnToLiveTail: () => set({ selectedEventId: null, jumpToRawLineId: null }),
  setVisibleTimeRange: (range) => set({ visibleTimeRange: range }),
  toggleFilter: (type) =>
    set((state) => {
      const next = new Set(state.activeFilters);
      if (next.has(type)) next.delete(type);
      else next.add(type);
      return { activeFilters: next };
    }),
  setFilters: (types) => set({ activeFilters: new Set(types) }),
  setLiveTailEnabled: (enabled) => set({ liveTailEnabled: enabled }),
  setPlayheadTsMs: (tsMs) => set({ playheadTsMs: tsMs }),
  focusOnTimestamp: (tsMs) =>
    set((state) => ({ focusRequest: { tsMs, requestId: (state.focusRequest?.requestId ?? 0) + 1 } })),
}));
