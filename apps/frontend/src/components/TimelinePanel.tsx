import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { scaleTime, type ScaleTime } from "d3-scale";
import { select } from "d3-selection";
import { zoom as d3zoom, zoomIdentity, type ZoomBehavior, type ZoomTransform } from "d3-zoom";
import type { EventType } from "@open-log/shared-types";
import { fetchEvents } from "@/api/client";
import { EVENT_COLORS } from "@/lib/eventColors";
import { useTimelineStore } from "@/store/timelineStore";

const DAY_MS = 24 * 60 * 60 * 1000;
// Window applied when the log viewer asks the timeline to focus on a
// timestamp (e.g. clicking a log line). Never zooms out past whatever the
// user is already looking at — see the focusRequest effect below — but
// this is the ceiling: about a screenful of context around the instant.
const FOCUS_SPAN_MS = 60 * 60 * 1000;
const CHIP = 7; // half-size of a normal marker chip, in px
const COMMAND_HALF = CHIP + 2; // half-size of an ops-track marker chip
const MARKER_W = 18; // footprint used for lane-collision spacing
const HIT_RADIUS = 4;
const GUTTER = 54; // left margin reserved for track labels; the time scale's
// pixel range starts here so markers never land under a label.

// Every glyph path in drawGlyph() is authored so its farthest point from
// center is at most GLYPH_REACH * s; picking GLYPH_SCALE so
// (GLYPH_REACH * s + half the stroke width) lands comfortably inside CHIP
// keeps every glyph inside its chip's border instead of clipping through it.
const GLYPH_REACH = 0.8;
const GLYPH_SCALE = 0.85;

// UI accent for canvas-drawn selection state — keep in sync with --primary
// in index.css (hsl(203 65% 75%)).
const ACCENT = "#96c9e9";
const CLUSTER_COLOR = "#8a8a8a";
const BG = "#0f0f0f";
const GRID_LINE = "#3f3f46";
const TRACK_LABEL_COLOR = "#71717a";
const PLAYHEAD_COLOR = "#fafafa";

// Events are kept on four fixed, independent tracks (rather than one shared
// pool of lanes) so a burst of joins can never crowd out a sleep event or a
// warning — each category always gets its own reserved vertical space.
// Typed as Record<EventType, TrackId> so TypeScript refuses to compile if a
// future EventType is added here without an explicit track assignment.
type TrackId = "ops" | "warnings" | "server" | "players";

const TYPE_TRACK: Record<EventType, TrackId> = {
  command: "ops",
  warning: "warnings",
  sleep: "server",
  server_start: "server",
  server_stop: "server",
  join: "players",
  leave: "players",
  chat: "players",
  death: "players",
};

interface TrackDef {
  id: TrackId;
  label: string;
  lanes: number; // sub-lanes for within-track greedy packing (ops ignores this — always individual)
}

// Ordered top-to-bottom: ops (always-visible commands) at the top, players
// (highest-volume, routine activity) closest to the axis.
const TRACKS: readonly TrackDef[] = [
  { id: "ops", label: "OPS", lanes: 1 },
  { id: "warnings", label: "WARN", lanes: 2 },
  { id: "server", label: "SERVER", lanes: 2 },
  { id: "players", label: "PLAYERS", lanes: 3 },
];

interface TrackLayout {
  id: TrackId;
  label: string;
  topY: number;
  bandHeight: number;
  laneYs: number[]; // laneYs[0] = lane closest to the axis (bottom of band)
}

const TOP_PAD = 14;
const LANE_HEIGHT = 26;
const OPS_BAND = COMMAND_HALF * 2 + 8;
const TRACK_GAP = 16;
const AXIS_GAP = 16;
const TICKS_AREA = 26;

function buildTrackLayout(): { tracks: TrackLayout[]; axisY: number; height: number } {
  const tracks: TrackLayout[] = [];
  let cursorY = TOP_PAD;
  for (const def of TRACKS) {
    const bandHeight = def.id === "ops" ? OPS_BAND : def.lanes * LANE_HEIGHT;
    const laneYs: number[] = [];
    if (def.id === "ops") {
      laneYs.push(cursorY + bandHeight / 2);
    } else {
      for (let i = 0; i < def.lanes; i++) {
        laneYs.push(cursorY + bandHeight - LANE_HEIGHT / 2 - i * LANE_HEIGHT);
      }
    }
    tracks.push({ id: def.id, label: def.label, topY: cursorY, bandHeight, laneYs });
    cursorY += bandHeight + TRACK_GAP;
  }
  const axisY = cursorY - TRACK_GAP + AXIS_GAP;
  return { tracks, axisY, height: axisY + TICKS_AREA };
}

const { tracks: TRACK_LAYOUT, axisY: AXIS_Y, height: HEIGHT } = buildTrackLayout();
const TRACK_BY_ID = new Map(TRACK_LAYOUT.map((t) => [t.id, t]));

interface DrawnMarker {
  x: number;
  y: number;
  eventType: EventType;
  color: string;
  eventIds: number[];
  rawLineId: number | null;
  isCluster: boolean;
  isCommand: boolean;
  label: string;
}

const dateFormatter = new Intl.DateTimeFormat(undefined, {
  month: "short",
  day: "numeric",
  hour: "numeric",
  minute: "2-digit",
});

// Hand-drawn canvas-path glyphs, one per EventType, drawn inside a small
// square chip centered at (0,0), scale s. The chip itself is filled solid in
// the marker's color; the glyph is cut through it in `mainColor` (the chip's
// own background color, so the icon reads as a stencil cutout), with a
// couple of glyphs (death, warning) punching a finer accent detail back
// through in `accentColor` (the marker's color again) on top of that cutout.
function drawGlyph(ctx: CanvasRenderingContext2D, type: EventType, s: number, mainColor: string, accentColor: string) {
  ctx.fillStyle = mainColor;
  ctx.beginPath();
  switch (type) {
    case "join": // arrow flying in toward an open door bracket on the right —
      // mirrors lucide's LogIn (arrow + doorframe), both cut out
      ctx.moveTo(-s * 0.05, -s * 0.3);
      ctx.lineTo(s * 0.2, 0);
      ctx.lineTo(-s * 0.05, s * 0.3);
      ctx.closePath();
      ctx.fill();
      ctx.fillRect(-s * 0.6, -s * 0.07, s * 0.55, s * 0.14);
      ctx.strokeStyle = mainColor;
      ctx.lineWidth = s * 0.16;
      ctx.lineCap = "round";
      ctx.lineJoin = "round";
      ctx.beginPath();
      ctx.moveTo(s * 0.2, -s * 0.5);
      ctx.lineTo(s * 0.55, -s * 0.5);
      ctx.lineTo(s * 0.55, s * 0.5);
      ctx.lineTo(s * 0.2, s * 0.5);
      ctx.stroke();
      return;
    case "chat": // speech bubble with a small tail — cut out
      ctx.moveTo(-s * 0.6, -s * 0.45);
      ctx.lineTo(s * 0.6, -s * 0.45);
      ctx.lineTo(s * 0.6, s * 0.2);
      ctx.lineTo(-s * 0.1, s * 0.2);
      ctx.lineTo(-s * 0.25, s * 0.55);
      ctx.lineTo(-s * 0.25, s * 0.2);
      ctx.lineTo(-s * 0.6, s * 0.2);
      ctx.closePath();
      ctx.fill();
      return;
    case "leave": // arrow flying out away from an open door bracket on the
      // left — mirrors lucide's LogOut, both cut out
      ctx.moveTo(s * 0.35, -s * 0.3);
      ctx.lineTo(s * 0.6, 0);
      ctx.lineTo(s * 0.35, s * 0.3);
      ctx.closePath();
      ctx.fill();
      ctx.fillRect(-s * 0.2, -s * 0.07, s * 0.55, s * 0.14);
      ctx.strokeStyle = mainColor;
      ctx.lineWidth = s * 0.16;
      ctx.lineCap = "round";
      ctx.lineJoin = "round";
      ctx.beginPath();
      ctx.moveTo(-s * 0.2, -s * 0.5);
      ctx.lineTo(-s * 0.55, -s * 0.5);
      ctx.lineTo(-s * 0.55, s * 0.5);
      ctx.lineTo(-s * 0.2, s * 0.5);
      ctx.stroke();
      return;
    case "death": // skull — cranium + jaw cut out, eye sockets punched back through in accentColor
      ctx.arc(0, -s * 0.05, s * 0.62, Math.PI, Math.PI * 2, false);
      ctx.quadraticCurveTo(s * 0.5, s * 0.55, s * 0.18, s * 0.68);
      ctx.lineTo(-s * 0.18, s * 0.68);
      ctx.quadraticCurveTo(-s * 0.5, s * 0.55, -s * 0.62, -s * 0.05);
      ctx.closePath();
      ctx.fill();
      ctx.fillStyle = accentColor;
      ctx.beginPath();
      ctx.arc(-s * 0.26, -s * 0.05, s * 0.16, 0, Math.PI * 2);
      ctx.fill();
      ctx.beginPath();
      ctx.arc(s * 0.26, -s * 0.05, s * 0.16, 0, Math.PI * 2);
      ctx.fill();
      return;
    case "command": // chevron ">" plus underscore bar — both cut out
      ctx.moveTo(-s * 0.55, -s * 0.5);
      ctx.lineTo(s * 0.2, 0);
      ctx.lineTo(-s * 0.55, s * 0.5);
      ctx.closePath();
      ctx.fill();
      ctx.fillRect(-s * 0.05, s * 0.5, s * 0.5, s * 0.12);
      return;
    case "server_start": // power symbol — cut out; color (green vs red, from
    case "server_stop": // EVENT_COLORS) is what distinguishes start from stop
      ctx.arc(0, 0, s * 0.6, -Math.PI / 2 + 0.5, -Math.PI / 2 - 0.5 + Math.PI * 2, false);
      ctx.arc(0, 0, s * 0.38, -Math.PI / 2 - 0.5 + Math.PI * 2, -Math.PI / 2 + 0.5, true);
      ctx.closePath();
      ctx.fill();
      ctx.fillRect(-s * 0.11, -s * 0.78, s * 0.22, s * 0.73);
      return;
    case "sleep": // crescent — cut out
      ctx.arc(-s * 0.05, 0, s * 0.65, Math.PI * 0.5, Math.PI * 1.5, false);
      ctx.arc(s * 0.28, 0, s * 0.55, Math.PI * 1.5, Math.PI * 0.5, true);
      ctx.closePath();
      ctx.fill();
      return;
    case "warning": // hazard triangle cut out, with an exclamation mark punched back through
      ctx.moveTo(0, -s * 0.75);
      ctx.lineTo(s * 0.7, s * 0.55);
      ctx.lineTo(-s * 0.7, s * 0.55);
      ctx.closePath();
      ctx.fill();
      ctx.fillStyle = accentColor;
      ctx.fillRect(-s * 0.07, -s * 0.35, s * 0.14, s * 0.45);
      ctx.beginPath();
      ctx.arc(0, s * 0.32, s * 0.08, 0, Math.PI * 2);
      ctx.fill();
      return;
  }
}

// Builds the d3-zoom transform that makes `scale.rescaleX(baseScale)` cover
// exactly [from, to]. Derived from baseScale's time domain directly (rather
// than subtracting baseScale-projected pixel positions, as this file used to)
// because baseScale spans a full year: a narrow focus window (e.g. one hour)
// projects to a sub-pixel delta in that pixel space, and subtracting two
// nearly-equal pixel values loses the precision needed to zoom in tightly.
function domainToTransform(scale: ScaleTime<number, number>, width: number, from: number, to: number): ZoomTransform {
  const [domainStartMs, domainEndMs] = scale.domain().map((d) => d.getTime());
  const k = (domainEndMs - domainStartMs) / Math.max(1, to - from);
  const gutterPx = scale.range()[0];
  const tx = gutterPx / k - scale(from);
  return zoomIdentity.scale(k).translate(tx, 0);
}

export function TimelinePanel() {
  const containerRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const transformRef = useRef<ZoomTransform>(zoomIdentity);
  const zoomBehaviorRef = useRef<ZoomBehavior<HTMLCanvasElement, unknown> | null>(null);
  const markersRef = useRef<DrawnMarker[]>([]);
  const fetchTimeoutRef = useRef<ReturnType<typeof setTimeout>>();
  const appliedFocusRequestId = useRef<number | null>(null);
  const nowRef = useRef(Date.now());
  // Logical visible domain, independent of pixel width — the source of truth
  // for re-deriving the zoom transform whenever the container is resized (a
  // stale transform computed for the old pixel range would map to the wrong
  // dates once baseScale's range changes size).
  const visibleDomainRef = useRef<[number, number]>([nowRef.current - 2 * DAY_MS, nowRef.current]);

  const [width, setWidth] = useState(800);
  const [fetchRange, setFetchRange] = useState<[number, number]>(() => [...visibleDomainRef.current]);
  const [hover, setHover] = useState<{ x: number; y: number; label: string } | null>(null);

  const selectEvent = useTimelineStore((s) => s.selectEvent);
  const selectedEventId = useTimelineStore((s) => s.selectedEventId);
  const playheadTsMs = useTimelineStore((s) => s.playheadTsMs);
  const focusRequest = useTimelineStore((s) => s.focusRequest);
  const setVisibleTimeRange = useTimelineStore((s) => s.setVisibleTimeRange);
  const activeFilters = useTimelineStore((s) => s.activeFilters);
  const typesParam = activeFilters.size > 0 ? Array.from(activeFilters).join(",") : undefined;

  const baseScale = useMemo(() => {
    return scaleTime()
      .domain([nowRef.current - 365 * DAY_MS, nowRef.current])
      .range([GUTTER, width]);
  }, [width]);

  const { data } = useQuery({
    queryKey: ["timeline-events", fetchRange[0], fetchRange[1], typesParam],
    queryFn: () => fetchEvents({ from: fetchRange[0], to: fetchRange[1], types: typesParam, limit: 2000 }),
    placeholderData: (prev) => prev,
  });
  const events = useMemo(() => data?.events ?? [], [data]);

  // Measure container width responsively.
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const observer = new ResizeObserver((entries) => {
      const w = entries[0]?.contentRect.width;
      if (w) setWidth(Math.floor(w));
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const draw = (scale: ScaleTime<number, number>) => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = width * dpr;
    canvas.height = HEIGHT * dpr;
    canvas.style.width = `${width}px`;
    canvas.style.height = `${HEIGHT}px`;
    ctx.scale(dpr, dpr);
    ctx.clearRect(0, 0, width, HEIGHT);

    // Micrographic dot-grid backdrop behind the tracks.
    ctx.fillStyle = "rgba(255,255,255,0.05)";
    const dotSpacing = 14;
    for (let gx = GUTTER + ((width - GUTTER) % dotSpacing) / 2; gx < width; gx += dotSpacing) {
      for (let gy = 8; gy < AXIS_Y - 4; gy += dotSpacing) {
        ctx.fillRect(gx, gy, 1, 1);
      }
    }

    // Track separators + labels, drawn first as background chrome.
    ctx.strokeStyle = GRID_LINE;
    ctx.fillStyle = TRACK_LABEL_COLOR;
    ctx.font = "9px 'JetBrains Mono', ui-monospace, monospace";
    ctx.textAlign = "left";
    ctx.setLineDash([3, 3]);
    for (const track of TRACK_LAYOUT) {
      if (track !== TRACK_LAYOUT[0]) {
        const sepY = track.topY - TRACK_GAP / 2;
        ctx.beginPath();
        ctx.moveTo(GUTTER - 6, sepY);
        ctx.lineTo(width, sepY);
        ctx.stroke();
      }
      ctx.fillText(track.label, 4, track.topY + track.bandHeight / 2 + 3);
    }
    ctx.beginPath();
    ctx.moveTo(GUTTER - 6, TOP_PAD - 6);
    ctx.lineTo(GUTTER - 6, AXIS_Y);
    ctx.stroke();
    ctx.setLineDash([]);

    // Dashed axis line + ticks.
    ctx.strokeStyle = GRID_LINE;
    ctx.setLineDash([3, 3]);
    ctx.beginPath();
    ctx.moveTo(GUTTER, AXIS_Y);
    ctx.lineTo(width, AXIS_Y);
    ctx.stroke();
    ctx.setLineDash([]);

    ctx.fillStyle = "#71717a";
    ctx.font = "10px 'JetBrains Mono', ui-monospace, monospace";
    ctx.textAlign = "center";
    for (const tick of scale.ticks(Math.max(2, Math.floor((width - GUTTER) / 140)))) {
      const x = scale(tick);
      ctx.beginPath();
      ctx.moveTo(x, AXIS_Y);
      ctx.lineTo(x, AXIS_Y + 4);
      ctx.stroke();
      ctx.fillText(dateFormatter.format(tick).toUpperCase(), x, AXIS_Y + 16);
    }

    // Greedy lane-packing (interval scheduling) runs independently per track,
    // so a burst on one track (e.g. players) never eats another track's lanes
    // or merges into a cross-category cluster. The ops track never packs into
    // lanes at all — commands always render individually and labeled, per
    // product requirement.
    type Placed = { x: number; eventType: EventType; color: string; eventId: number; rawLineId: number | null; label: string };
    const laneEdgesByTrack = new Map<TrackId, number[]>();
    const overflowByTrack = new Map<TrackId, Placed[]>();
    for (const track of TRACK_LAYOUT) {
      if (track.id === "ops") continue;
      laneEdgesByTrack.set(track.id, new Array(track.laneYs.length).fill(-Infinity));
      overflowByTrack.set(track.id, []);
    }
    const markersOut: Array<Placed & { y: number }> = [];
    const commandMarkers: DrawnMarker[] = [];

    const sorted = [...events].sort((a, b) => a.tsMs - b.tsMs);
    for (const event of sorted) {
      const x = scale(event.tsMs);
      if (x < GUTTER - 20 || x > width + 20) continue;
      const trackId = TYPE_TRACK[event.eventType];
      // Guards against rows persisted under a since-removed EventType (e.g. a
      // DB ingested before "wake" was dropped) — TYPE_TRACK has no entry for
      // those, and rendering them would otherwise crash the whole canvas.
      if (!trackId) continue;
      const color = EVENT_COLORS[event.eventType];
      const track = TRACK_BY_ID.get(trackId)!;

      if (trackId === "ops") {
        commandMarkers.push({
          x,
          y: track.laneYs[0],
          eventType: event.eventType,
          color,
          eventIds: [event.id],
          rawLineId: event.rawLineId,
          isCluster: false,
          isCommand: true,
          label: event.summary,
        });
        continue;
      }

      const candidate: Placed = {
        x,
        eventType: event.eventType,
        color,
        eventId: event.id,
        rawLineId: event.rawLineId,
        label: event.summary,
      };
      const laneEdges = laneEdgesByTrack.get(trackId)!;
      let lane = -1;
      for (let i = 0; i < laneEdges.length; i++) {
        if (laneEdges[i] <= x - MARKER_W / 2) {
          lane = i;
          break;
        }
      }
      if (lane === -1) {
        overflowByTrack.get(trackId)!.push(candidate);
      } else {
        laneEdges[lane] = x + MARKER_W / 2;
        markersOut.push({ ...candidate, y: track.laneYs[lane] });
      }
    }

    const markers: DrawnMarker[] = markersOut.map((m) => ({
      x: m.x,
      y: m.y,
      eventType: m.eventType,
      color: m.color,
      eventIds: [m.eventId],
      rawLineId: m.rawLineId,
      isCluster: false,
      isCommand: false,
      label: m.label,
    }));

    // Overflow events (no lane had room within their own track): bucket by
    // rounded x, scoped per track so clusters never mix categories.
    for (const [trackId, overflow] of overflowByTrack) {
      const track = TRACK_BY_ID.get(trackId)!;
      const topLaneY = track.laneYs[track.laneYs.length - 1];
      const buckets = new Map<number, { xs: number[]; eventIds: number[]; rawLineId: number | null; labels: string[] }>();
      for (const o of overflow) {
        const key = Math.round(o.x / MARKER_W);
        const bucket = buckets.get(key);
        if (bucket) {
          bucket.xs.push(o.x);
          bucket.eventIds.push(o.eventId);
          bucket.labels.push(o.label);
        } else {
          buckets.set(key, { xs: [o.x], eventIds: [o.eventId], rawLineId: o.rawLineId, labels: [o.label] });
        }
      }
      for (const bucket of buckets.values()) {
        const avgX = bucket.xs.reduce((a, b) => a + b, 0) / bucket.xs.length;
        const isCluster = bucket.eventIds.length > 1;
        markers.push({
          x: avgX,
          y: topLaneY,
          eventType: "join",
          color: CLUSTER_COLOR,
          eventIds: bucket.eventIds,
          rawLineId: isCluster ? null : bucket.rawLineId,
          isCluster,
          isCommand: false,
          label: isCluster ? `${bucket.eventIds.length} events` : bucket.labels[0],
        });
      }
    }

    // Draw normal-severity + cluster markers as solid chips with the glyph
    // (or, for clusters, the count) cut through in the chip's own background.
    for (const marker of markers) {
      ctx.fillStyle = marker.color;
      ctx.fillRect(marker.x - CHIP, marker.y - CHIP, CHIP * 2, CHIP * 2);
      if (marker.isCluster) {
        ctx.fillStyle = BG;
        ctx.font = "9px 'JetBrains Mono', ui-monospace, monospace";
        ctx.textAlign = "center";
        ctx.fillText(String(marker.eventIds.length), marker.x, marker.y + 3);
      } else {
        ctx.save();
        ctx.translate(marker.x, marker.y);
        drawGlyph(ctx, marker.eventType, CHIP * GLYPH_SCALE, BG, marker.color);
        ctx.restore();
      }
      if (marker.eventIds.length === 1 && marker.eventIds[0] === selectedEventId) {
        drawSelectionBrackets(ctx, marker.x, marker.y, CHIP + 3);
      }
    }

    // Ops track: always individual, larger, labeled.
    for (const marker of commandMarkers) {
      const half = COMMAND_HALF;
      ctx.fillStyle = marker.color;
      ctx.fillRect(marker.x - half, marker.y - half, half * 2, half * 2);
      ctx.save();
      ctx.translate(marker.x, marker.y);
      drawGlyph(ctx, marker.eventType, half * GLYPH_SCALE, BG, marker.color);
      ctx.restore();

      if (marker.eventIds[0] === selectedEventId) {
        drawSelectionBrackets(ctx, marker.x, marker.y, half + 3);
      }

      ctx.fillStyle = marker.color;
      ctx.font = "10px 'JetBrains Mono', ui-monospace, monospace";
      ctx.textAlign = "left";
      ctx.fillText(marker.label.toUpperCase(), marker.x + half + 5, marker.y + 3);
      ctx.textAlign = "center";
    }

    // Playhead: video-editor-style scrubber showing where the log viewer's
    // hovered (or, absent a hover, selected) line falls on the timeline.
    // Drawn last so it stays visible over every track/marker.
    if (playheadTsMs !== null) {
      const px = scale(playheadTsMs);
      if (px >= GUTTER - 1 && px <= width + 1) {
        ctx.strokeStyle = PLAYHEAD_COLOR;
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.moveTo(px, 3);
        ctx.lineTo(px, AXIS_Y);
        ctx.stroke();
        ctx.fillStyle = PLAYHEAD_COLOR;
        ctx.beginPath();
        ctx.moveTo(px - 4, 3);
        ctx.lineTo(px + 4, 3);
        ctx.lineTo(px, 8);
        ctx.closePath();
        ctx.fill();
      }
    }

    markersRef.current = [...markers, ...commandMarkers];
  };

  const drawRef = useRef(draw);
  drawRef.current = draw;

  const scheduleFetch = (from: number, to: number) => {
    if (fetchTimeoutRef.current) clearTimeout(fetchTimeoutRef.current);
    fetchTimeoutRef.current = setTimeout(() => {
      const span = to - from;
      setFetchRange([from - span, to + span]);
      setVisibleTimeRange({ from, to });
    }, 300);
  };

  // Attach zoom behavior once per canvas/width; must not depend on `events` or
  // it would reset the pan/zoom transform every time new data arrives.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || width === 0) return;

    const behavior: ZoomBehavior<HTMLCanvasElement, unknown> = d3zoom<HTMLCanvasElement, unknown>()
      .scaleExtent([1, 200000])
      .on("zoom", (event) => {
        transformRef.current = event.transform;
        const scale = event.transform.rescaleX(baseScale);
        drawRef.current(scale);
        const [from, to] = scale.domain().map((d: Date) => d.getTime());
        visibleDomainRef.current = [from, to];
        scheduleFetch(from, to);
      });

    zoomBehaviorRef.current = behavior;
    const selection = select(canvas);
    selection.call(behavior);

    // Always re-derive the transform from the logical visible domain (not by
    // reusing the previous transform object) — baseScale's pixel range changes
    // whenever `width` changes, and a transform calibrated for the old range
    // maps to the wrong dates under the new one.
    const [domainFrom, domainTo] = visibleDomainRef.current;
    const transform = domainToTransform(baseScale, width, domainFrom, domainTo);
    selection.call(behavior.transform, transform);

    return () => {
      selection.on(".zoom", null);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [baseScale, width]);

  // Pan/zoom to a specific instant on request (e.g. clicking a log line).
  // Guarded by requestId so this only fires for a genuinely new request —
  // not on every resize/baseScale change while a stale focusRequest is still
  // the latest one in the store. Never zooms out past the user's current
  // view: the applied span is capped at FOCUS_SPAN_MS but shrinks to match
  // whatever's already narrower, so a tightly-zoomed user just gets panned.
  useEffect(() => {
    if (!focusRequest || focusRequest.requestId === appliedFocusRequestId.current) return;
    const canvas = canvasRef.current;
    const behavior = zoomBehaviorRef.current;
    if (!canvas || !behavior) return;
    appliedFocusRequestId.current = focusRequest.requestId;

    const currentSpan = visibleDomainRef.current[1] - visibleDomainRef.current[0];
    const span = Math.min(currentSpan, FOCUS_SPAN_MS);
    const from = focusRequest.tsMs - span / 2;
    const to = focusRequest.tsMs + span / 2;
    const transform = domainToTransform(baseScale, width, from, to);
    select(canvas).call(behavior.transform, transform);
  }, [focusRequest, baseScale, width]);

  // Redraw (without touching zoom state) whenever new event data arrives.
  useEffect(() => {
    drawRef.current(transformRef.current.rescaleX(baseScale));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [events, selectedEventId, playheadTsMs]);

  const markerHalf = (m: DrawnMarker) => (m.isCommand ? COMMAND_HALF : CHIP);

  const handleClick = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const rect = canvasRef.current?.getBoundingClientRect();
    if (!rect) return;
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    let nearest: DrawnMarker | null = null;
    let nearestDist = Infinity;
    for (const marker of markersRef.current) {
      const half = markerHalf(marker) + HIT_RADIUS;
      if (Math.abs(marker.x - x) > half || Math.abs(marker.y - y) > half) continue;
      const dist = Math.hypot(marker.x - x, marker.y - y);
      if (dist < nearestDist) {
        nearestDist = dist;
        nearest = marker;
      }
    }
    if (!nearest) return;

    if (nearest.isCluster) {
      const canvas = canvasRef.current;
      const behavior = zoomBehaviorRef.current;
      if (!canvas || !behavior) return;
      // Reuse the attached behavior instance (not a fresh one) so its "zoom"
      // listener — which redraws and schedules the data refetch — still fires.
      select(canvas).call(behavior.scaleBy, 3, [x, 0]);
      return;
    }
    selectEvent(nearest.eventIds[0], nearest.rawLineId);
  };

  const handleMouseMove = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const rect = canvasRef.current?.getBoundingClientRect();
    if (!rect) return;
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    const nearest = markersRef.current.find((m) => {
      const half = markerHalf(m) + HIT_RADIUS;
      return Math.abs(m.x - x) <= half && Math.abs(m.y - y) <= half;
    });
    if (nearest) {
      setHover({ x: nearest.x, y: nearest.y, label: nearest.label });
    } else {
      setHover(null);
    }
  };

  return (
    <div ref={containerRef} className="relative w-full border-b border-dashed" style={{ height: HEIGHT }}>
      <canvas
        ref={canvasRef}
        onClick={handleClick}
        onMouseMove={handleMouseMove}
        onMouseLeave={() => setHover(null)}
        className="cursor-pointer"
      />
      {hover && (
        <div
          className="pointer-events-none absolute z-10 -translate-x-1/2 -translate-y-full border border-primary/50 bg-popover px-2 py-1 font-mono text-xs uppercase tracking-wide text-popover-foreground shadow-md"
          style={{ left: hover.x, top: hover.y - 12 }}
        >
          {hover.label}
        </div>
      )}
    </div>
  );
}

function drawSelectionBrackets(ctx: CanvasRenderingContext2D, cx: number, cy: number, r: number) {
  const len = 4;
  ctx.strokeStyle = ACCENT;
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  // 4 corner ticks instead of a ring, to match the bracket motif. Each corner
  // draws two short legs pointing inward (toward the marker center) from the
  // corner point (cx + sx*r, cy + sy*r).
  for (const sx of [-1, 1]) {
    for (const sy of [-1, 1]) {
      const x0 = cx + sx * r;
      const y0 = cy + sy * r;
      ctx.moveTo(x0, y0);
      ctx.lineTo(x0 - sx * len, y0);
      ctx.moveTo(x0, y0);
      ctx.lineTo(x0, y0 - sy * len);
    }
  }
  ctx.stroke();
}
