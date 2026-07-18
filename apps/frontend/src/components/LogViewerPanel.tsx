import { useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useVirtualizer } from "@tanstack/react-virtual";
import { fetchRawLines } from "@/api/client";
import { Switch } from "@/components/ui/switch";
import { cn } from "@/lib/utils";
import { useTimelineStore } from "@/store/timelineStore";

const TAIL_SIZE = 400;
const JUMP_WINDOW = 150;
const BOTTOM_THRESHOLD_PX = 48;

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
  const parentRef = useRef<HTMLDivElement>(null);
  const hasScrolledForJump = useRef<number | null>(null);
  const isAtBottomRef = useRef(true);
  const [isAtBottom, setIsAtBottom] = useState(true);
  const [hoveredLineId, setHoveredLineId] = useState<number | null>(null);

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
  // hovering a line, show its position; otherwise fall back to whatever's
  // selected (e.g. via a timeline-marker click or search result).
  useEffect(() => {
    const hovered = hoveredLineId !== null ? lines.find((l) => l.id === hoveredLineId) : undefined;
    const selected = jumpToRawLineId !== null ? lines.find((l) => l.id === jumpToRawLineId) : undefined;
    setPlayheadTsMs(hovered?.tsMs ?? selected?.tsMs ?? null);
  }, [hoveredLineId, jumpToRawLineId, lines, setPlayheadTsMs]);

  useEffect(() => () => setPlayheadTsMs(null), [setPlayheadTsMs]);

  const virtualizer = useVirtualizer({
    count: lines.length,
    getScrollElement: () => parentRef.current,
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
    if (!el || !isTailMode) return;
    const atBottom = el.scrollTop + el.clientHeight >= el.scrollHeight - BOTTOM_THRESHOLD_PX;
    if (atBottom !== isAtBottomRef.current) {
      isAtBottomRef.current = atBottom;
      setIsAtBottom(atBottom);
    }
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
            const isHighlighted = line.id === jumpToRawLineId;
            return (
              <div
                key={line.id}
                data-index={virtualRow.index}
                ref={virtualizer.measureElement}
                onMouseEnter={() => setHoveredLineId(line.id)}
                onMouseLeave={() => setHoveredLineId((id) => (id === line.id ? null : id))}
                style={{
                  position: "absolute",
                  top: 0,
                  left: 0,
                  width: "100%",
                  transform: `translateY(${virtualRow.start}px)`,
                }}
                className={cn(
                  "flex gap-3 whitespace-pre-wrap break-all border-l-2 border-transparent px-3 py-0.5",
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
