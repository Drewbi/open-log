import { Filter, LogIn, LogOut, MessageSquare, Moon, Power, Skull, Terminal, TriangleAlert } from "lucide-react";
import type { EventType } from "@open-log/shared-types";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { EVENT_COLORS } from "@/lib/eventColors";
import { useTimelineStore } from "@/store/timelineStore";

const TYPE_META: Array<{ type: EventType; label: string; icon: typeof LogIn }> = [
  { type: "join", label: "Join", icon: LogIn },
  { type: "leave", label: "Leave", icon: LogOut },
  { type: "chat", label: "Chat", icon: MessageSquare },
  { type: "death", label: "Death", icon: Skull },
  { type: "command", label: "Command", icon: Terminal },
  { type: "sleep", label: "Sleep", icon: Moon },
  { type: "server_start", label: "Server start", icon: Power },
  { type: "server_stop", label: "Server stop", icon: Power },
  { type: "warning", label: "Warning", icon: TriangleAlert },
];

export function FilterBar() {
  const activeFilters = useTimelineStore((s) => s.activeFilters);
  const toggleFilter = useTimelineStore((s) => s.toggleFilter);
  const setFilters = useTimelineStore((s) => s.setFilters);

  return (
    <div className="flex items-center gap-3 border-b border-dashed px-3 py-2">
      <span className="label-caps truncate">
        {activeFilters.size === 0 ? "Showing all events" : `Filtered (${activeFilters.size})`}
      </span>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="outline" size="sm" className="label-caps ml-auto shrink-0 gap-1.5 px-2.5">
            <Filter className="h-3.5 w-3.5" />
            Filter
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-52">
          <DropdownMenuLabel className="label-caps">Event types</DropdownMenuLabel>
          <DropdownMenuSeparator />
          {TYPE_META.map(({ type, label, icon: Icon }) => {
            const color = EVENT_COLORS[type];
            return (
              <DropdownMenuCheckboxItem
                key={type}
                checked={activeFilters.has(type)}
                onSelect={(e) => e.preventDefault()}
                onCheckedChange={() => toggleFilter(type)}
                className="gap-2 text-xs uppercase tracking-wide"
              >
                <Icon className="h-3.5 w-3.5" style={{ color }} />
                {label}
              </DropdownMenuCheckboxItem>
            );
          })}
          {activeFilters.size > 0 && (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuItem
                onSelect={() => setFilters([])}
                className="label-caps text-muted-foreground"
              >
                Clear filters
              </DropdownMenuItem>
            </>
          )}
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}
