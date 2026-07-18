import { useEffect, useRef } from "react";
import { useQueryClient } from "@tanstack/react-query";
import type { RawLine, StreamMessage } from "@mc-log-timeline/shared-types";
import { useTimelineStore } from "@/store/timelineStore";

const MAX_TAIL_LINES = 1000;

export function useLiveTail() {
  const liveTailEnabled = useTimelineStore((s) => s.liveTailEnabled);
  const queryClient = useQueryClient();
  const invalidateTimeoutRef = useRef<ReturnType<typeof setTimeout>>();

  useEffect(() => {
    if (!liveTailEnabled) return;
    const source = new EventSource("/api/stream");

    source.onmessage = (e) => {
      const msg = JSON.parse(e.data) as StreamMessage;
      if (msg.type === "raw_line") {
        queryClient.setQueryData<{ lines: RawLine[] }>(["raw-lines", null], (old) =>
          old ? { lines: [...old.lines, msg.data].slice(-MAX_TAIL_LINES) } : old,
        );
      } else {
        if (invalidateTimeoutRef.current) clearTimeout(invalidateTimeoutRef.current);
        invalidateTimeoutRef.current = setTimeout(() => {
          void queryClient.invalidateQueries({ queryKey: ["timeline-events"] });
        }, 500);
      }
    };

    return () => source.close();
  }, [liveTailEnabled, queryClient]);
}
