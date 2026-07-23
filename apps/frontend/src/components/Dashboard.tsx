import { useQuery } from "@tanstack/react-query";
import { getAuthStatus, logout } from "@/api/client";
import { Button } from "@/components/ui/button";
import { FilterBar } from "@/components/FilterBar";
import { LogViewerPanel } from "@/components/LogViewerPanel";
import { SearchBar } from "@/components/SearchBar";
import { TimelinePanel } from "@/components/TimelinePanel";
import { useLiveTail } from "@/hooks/useLiveTail";

export function Dashboard() {
  useLiveTail();
  const { data } = useQuery({ queryKey: ["auth-status"], queryFn: getAuthStatus });

  return (
    <div className="flex h-screen flex-col bg-background text-foreground">
      <header className="flex items-center justify-between gap-2 border-b border-dashed px-4 py-3">
        <div className="flex min-w-0 flex-1 items-center gap-2">
          <span className="relative flex h-2 w-2 shrink-0">
            <span className="absolute inline-flex h-full w-full animate-ping bg-primary opacity-75" />
            <span className="relative inline-flex h-2 w-2 bg-primary" />
          </span>
          <h1 className="truncate text-sm font-bold uppercase tracking-[0.2em]">
            OPEN LOG <span className="text-muted-foreground">// {data?.serverName || "TIMELINE"}</span>
          </h1>
        </div>
        <div className="flex shrink-0 items-center gap-2 sm:gap-3">
          <SearchBar />
          <Button variant="ghost" size="sm" className="label-caps shrink-0" onClick={() => logout().then(() => window.location.reload())}>
            Log out
          </Button>
        </div>
      </header>
      <div className="flex min-h-0 flex-1 flex-col">
        <FilterBar />
        <TimelinePanel />
        <div className="min-h-0 flex-1">
          <LogViewerPanel />
        </div>
      </div>
    </div>
  );
}
