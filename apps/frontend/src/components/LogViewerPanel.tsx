import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useVirtualizer } from "@tanstack/react-virtual";
import type { RawLine } from "@open-log/shared-types";
import { fetchRawLines } from "@/api/client";
import { Switch } from "@/components/ui/switch";
import { cn } from "@/lib/utils";
import { useTimelineStore } from "@/store/timelineStore";

const TAIL_SIZE = 400;
const JUMP_WINDOW = 150;
const LOAD_MORE_SIZE = 150;
const BOTTOM_THRESHOLD_PX = 48;
const LOAD_MORE_THRESHOLD_PX = 600;

function levelClass(level: string | null): string {
  if (level === "ERROR") return "text-destructive";
  if (level === "WARN") return "text-amber-500 dark:text-amber-400";
  return "text-foreground";
}

export function LogViewerPanel() {
  const jumpToRawLineId = useTimelineStore((s) => s.jumpToRawLineId);
  const liveTailEnabled = useTimelineStore((s) => s.liveTailEnabled);
  const setLiveTailEnabled = useTimelineStore((s) => s.setLiveTailEnabled);
  const returnToLiveTail = useTimelineStore((s) => s.returnToLiveTail);
  const setPlayheadTsMs = useTimelineStore((s) => s.setPlayheadTsMs);
  const focusOnTimestamp = useTimelineStore((s) => s.focusOnTimestamp);
  const parentRef = useRef<HTMLDivElement>(null);
  const hasScrolledForJump = useRef<number | null>(null);
  const isAtBottomRef = useRef(true);
  const [isAtBottom, setIsAtBottom] = useState(true);
  const queryClient = useQueryClient();
  const loadingOlderRef = useRef(false);
  const loadingNewerRef = useRef(false);
  const olderExhaustedRef = useRef(false);
  const newerExhaustedRef = useRef(false);
  const pendingScrollAdjustRef = useRef<{ prevScrollHeight: number; prevScrollTop: number } | null>(null);
  const [hoveredLineId, setHoveredLineId] = useState<number | null>(null);
  // Sticks after a click (unlike hover, which clears on mouse-leave) so the
  // clicked line stays highlighted and keeps driving the playhead/timeline
  // focus until another line is hovered or clicked.
  const [clickedLineId, setClickedLineId] = useState<number | null>(null);

  const isTailMode = jumpToRawLineId === null;

  const { data, isLoading } = useQuery({
    queryKey: ["raw-lines", jumpToRawLineId],
    queryFn: () =>
      jumpToRawLineId
        ? fetchRawLines({ aroundId: jumpToRawLineId, before: JUMP_WINDOW, after: JUMP_WINDOW })
        : fetchRawLines({ before: TAIL_SIZE, after: 0 }),
  });

  const lines = data?.lines ?? [];

  // Drives the timeline's video-editor-style playhead: while actively
  // hovering a line, show its position; otherwise fall back to a clicked
  // line (sticky), then to whatever's selected (e.g. via a timeline-marker
  // click or search result).
  useEffect(() => {
    const hovered = hoveredLineId !== null ? lines.find((l) => l.id === hoveredLineId) : undefined;
    const clicked = clickedLineId !== null ? lines.find((l) => l.id === clickedLineId) : undefined;
    const selected = jumpToRawLineId !== null ? lines.find((l) => l.id === jumpToRawLineId) : undefined;
    setPlayheadTsMs(hovered?.tsMs ?? clicked?.tsMs ?? selected?.tsMs ?? null);
  }, [hoveredLineId, clickedLineId, jumpToRawLineId, lines, setPlayheadTsMs]);

  useEffect(() => () => setPlayheadTsMs(null), [setPlayheadTsMs]);

  // The initial fetch is a fixed window (TAIL_SIZE or JUMP_WINDOW lines) —
  // these grow it as the user scrolls toward either edge, so jumping to a
  // marker doesn't hard-cap the log at ~300 lines of context.
  const queryKey = ["raw-lines", jumpToRawLineId];

  useEffect(() => {
    loadingOlderRef.current = false;
    loadingNewerRef.current = false;
    olderExhaustedRef.current = false;
    newerExhaustedRef.current = false;
  }, [jumpToRawLineId]);

  const loadOlder = async () => {
    if (loadingOlderRef.current || olderExhaustedRef.current) return;
    const current = queryClient.getQueryData<{ lines: RawLine[] }>(queryKey)?.lines;
    if (!current || current.length === 0) return;
    loadingOlderRef.current = true;
    const el = parentRef.current;
    const prevScrollHeight = el?.scrollHeight ?? 0;
    const prevScrollTop = el?.scrollTop ?? 0;
    try {
      const firstId = current[0].id;
      const result = await fetchRawLines({ aroundId: firstId, before: LOAD_MORE_SIZE, after: 0 });
      const older = result.lines.filter((l) => l.id !== firstId);
      if (older.length < LOAD_MORE_SIZE) olderExhaustedRef.current = true;
      if (older.length > 0) {
        pendingScrollAdjustRef.current = { prevScrollHeight, prevScrollTop };
        queryClient.setQueryData<{ lines: RawLine[] }>(queryKey, (old) =>
          old ? { lines: [...older, ...old.lines] } : old,
        );
      }
    } finally {
      loadingOlderRef.current = false;
    }
  };

  const loadNewer = async () => {
    if (loadingNewerRef.current || newerExhaustedRef.current) return;
    const current = queryClient.getQueryData<{ lines: RawLine[] }>(queryKey)?.lines;
    if (!current || current.length === 0) return;
    loadingNewerRef.current = true;
    try {
      const lastId = current[current.length - 1].id;
      const result = await fetchRawLines({ aroundId: lastId, before: 0, after: LOAD_MORE_SIZE });
      const newer = result.lines.filter((l) => l.id !== lastId);
      if (newer.length < LOAD_MORE_SIZE) newerExhaustedRef.current = true;
      if (newer.length > 0) {
        queryClient.setQueryData<{ lines: RawLine[] }>(queryKey, (old) =>
          old ? { lines: [...old.lines, ...newer] } : old,
        );
      }
    } finally {
      loadingNewerRef.current = false;
    }
  };

  // Prepending older lines shifts every existing row to a higher index; undo
  // the resulting scroll jump by re-applying the pre-prepend scrollTop offset
  // against the new (taller) scrollHeight, so the visible content doesn't move.
  useLayoutEffect(() => {
    const pending = pendingScrollAdjustRef.current;
    if (!pending) return;
    pendingScrollAdjustRef.current = null;
    const el = parentRef.current;
    if (!el) return;
    el.scrollTop = pending.prevScrollTop + (el.scrollHeight - pending.prevScrollHeight);
  }, [lines]);

  // Clicking a log line pins the playhead there and asks the timeline to
  // pan/zoom to that instant — the mirror of clicking a timeline marker,
  // which jumps the log viewer to a raw line.
  const handleLineClick = (line: RawLine) => {
    setClickedLineId(line.id);
    focusOnTimestamp(line.tsMs);
  };

  const virtualizer = useVirtualizer({
    count: lines.length,
    getScrollElement: () => parentRef.current,
    getItemKey: (index) => lines[index].id,
    estimateSize: () => 22,
    overscan: 20,
  });

  const scrollToLive = () => {
    isAtBottomRef.current = true;
    setIsAtBottom(true);
    virtualizer.scrollToIndex(lines.length - 1, { align: "end" });
  };

  // In tail mode this just scrolls the already-loaded list to the bottom. In
  // jump mode (viewing a fixed window around a clicked marker/search result)
  // there is otherwise no way back to the live tail — jumpToRawLineId is only
  // ever set, never cleared, by any other code path — so this exits jump mode
  // instead; the effect below then scrolls to the bottom once the tail query
  // (already warm from the SSE-fed cache) renders.
  const handleJumpToLive = () => {
    if (isTailMode) {
      scrollToLive();
    } else {
      isAtBottomRef.current = true;
      setIsAtBottom(true);
      returnToLiveTail();
    }
  };

  useEffect(() => {
    if (lines.length === 0) return;
    if (jumpToRawLineId) {
      if (hasScrolledForJump.current === jumpToRawLineId) return;
      const index = lines.findIndex((l) => l.id === jumpToRawLineId);
      if (index >= 0) {
        virtualizer.scrollToIndex(index, { align: "center" });
        hasScrolledForJump.current = jumpToRawLineId;
      }
    } else if (isAtBottomRef.current) {
      virtualizer.scrollToIndex(lines.length - 1, { align: "end" });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lines, jumpToRawLineId]);

  const handleScroll = () => {
    const el = parentRef.current;
    if (!el) return;
    if (isTailMode) {
      const atBottom = el.scrollTop + el.clientHeight >= el.scrollHeight - BOTTOM_THRESHOLD_PX;
      if (atBottom !== isAtBottomRef.current) {
        isAtBottomRef.current = atBottom;
        setIsAtBottom(atBottom);
      }
    } else if (el.scrollTop + el.clientHeight > el.scrollHeight - LOAD_MORE_THRESHOLD_PX) {
      void loadNewer();
    }
    if (el.scrollTop < LOAD_MORE_THRESHOLD_PX) void loadOlder();
  };

  return (
    <div className="relative flex h-full flex-col">
      <div className="flex items-center justify-between border-b border-dashed px-3 py-2">
        <h2 className="label-caps">Full log</h2>
        <div className="flex items-center gap-3">
          {isLoading && <span className="label-caps">Loading…</span>}
          <div className="flex items-center gap-2">
            {liveTailEnabled && (
              <span className="flex items-center gap-1.5 border border-primary/60 px-1.5 py-0.5 font-mono text-[10px] font-bold uppercase tracking-widest text-primary">
                <span className="relative flex h-1.5 w-1.5">
                  <span className="absolute inline-flex h-full w-full animate-ping bg-primary opacity-75" />
                  <span className="relative inline-flex h-1.5 w-1.5 bg-primary" />
                </span>
                Live
              </span>
            )}
            <Switch checked={liveTailEnabled} onCheckedChange={setLiveTailEnabled} aria-label="Toggle live tail" />
          </div>
        </div>
      </div>
      <div ref={parentRef} onScroll={handleScroll} className="relative min-h-0 flex-1 overflow-auto font-mono text-xs">
        <div style={{ height: virtualizer.getTotalSize(), position: "relative", width: "100%" }}>
          {virtualizer.getVirtualItems().map((virtualRow) => {
            const line = lines[virtualRow.index];
            const isHighlighted = line.id === jumpToRawLineId || line.id === clickedLineId;
            return (
              <div
                key={line.id}
                data-index={virtualRow.index}
                ref={virtualizer.measureElement}
                onMouseEnter={() => setHoveredLineId(line.id)}
                onMouseLeave={() => setHoveredLineId((id) => (id === line.id ? null : id))}
                onClick={() => handleLineClick(line)}
                style={{
                  position: "absolute",
                  top: 0,
                  left: 0,
                  width: "100%",
                  transform: `translateY(${virtualRow.start}px)`,
                }}
                className={cn(
                  "flex cursor-pointer gap-3 whitespace-pre-wrap break-all border-l-2 border-transparent px-3 py-0.5 hover:bg-accent/40",
                  levelClass(line.level),
                  isHighlighted && "border-primary bg-primary/10",
                )}
              >
                <span className="shrink-0 select-none text-muted-foreground/50">
                  {String(virtualRow.index + 1).padStart(5, "0")}
                </span>
                <span className="min-w-0 flex-1">{line.rawText}</span>
              </div>
            );
          })}
        </div>
      </div>
      {(!isTailMode || !isAtBottom) && (
        <button
          onClick={handleJumpToLive}
          className="absolute bottom-4 left-1/2 -translate-x-1/2 border border-primary/60 bg-popover px-3 py-1 font-mono text-xs font-medium uppercase tracking-wide text-popover-foreground shadow-md hover:bg-accent"
        >
          Jump to live
        </button>
      )}
    </div>
  );
}
