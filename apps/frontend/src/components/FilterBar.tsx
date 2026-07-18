import type { CSSProperties } from "react";
import { LogIn, LogOut, Moon, Power, Skull, Terminal, TriangleAlert } from "lucide-react";
import type { EventType } from "@mc-log-timeline/shared-types";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { EVENT_COLORS } from "@/lib/eventColors";
import { useTimelineStore } from "@/store/timelineStore";

const TYPE_META: Array<{ type: EventType; label: string; icon: typeof LogIn }> = [
  { type: "join", label: "Join", icon: LogIn },
  { type: "leave", label: "Leave", icon: LogOut },
  { type: "death", label: "Death", icon: Skull },
  { type: "command", label: "Command", icon: Terminal },
  { type: "sleep", label: "Sleep", icon: Moon },
  { type: "server_start", label: "Server start", icon: Power },
  { type: "server_stop", label: "Server stop", icon: Power },
  { type: "warning", label: "Warning", icon: TriangleAlert },
];

export function FilterBar() {
  const activeFilters = useTimelineStore((s) => s.activeFilters);
  const setFilters = useTimelineStore((s) => s.setFilters);

  return (
    <div className="flex items-center gap-3 border-b border-dashed px-3 py-2">
      <span className="label-caps">
        {activeFilters.size === 0 ? "Showing all events" : "Filtered"}
      </span>
      <ToggleGroup
        type="multiple"
        size="sm"
        value={Array.from(activeFilters)}
        onValueChange={(value: string[]) => setFilters(value as EventType[])}
      >
        {TYPE_META.map(({ type, label, icon: Icon }) => {
          const isActive = activeFilters.has(type);
          const color = EVENT_COLORS[type];
          // Radix's own data-[state=on]:bg-accent utility (toggle.tsx) has the
          // same CSS specificity as any class-based override here, so the
          // active per-type color has to be set as inline style (computed
          // from the store's activeFilters, which this component already
          // has) rather than relying on a data-state CSS selector to win.
          const activeStyle: CSSProperties | undefined = isActive
            ? { backgroundColor: color, borderColor: color, color: "#0a0a0a" }
            : undefined;
          return (
            <ToggleGroupItem
              key={type}
              value={type}
              aria-label={label}
              style={activeStyle}
              className="gap-1.5 border border-transparent px-2 text-xs uppercase tracking-wide"
            >
              <Icon className="h-3.5 w-3.5" />
              {label}
            </ToggleGroupItem>
          );
        })}
      </ToggleGroup>
    </div>
  );
}
