import { useEffect, useRef, useState } from "react";
import { Search } from "lucide-react";
import type { RawLine } from "@mc-log-timeline/shared-types";
import { searchRawLines } from "@/api/client";
import { Input } from "@/components/ui/input";
import { useTimelineStore } from "@/store/timelineStore";

export function SearchBar() {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<RawLine[]>([]);
  const [open, setOpen] = useState(false);
  const jumpToRawLine = useTimelineStore((s) => s.jumpToRawLine);
  const debounceRef = useRef<ReturnType<typeof setTimeout>>();

  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    if (query.trim().length < 2) {
      setResults([]);
      setOpen(false);
      return;
    }
    debounceRef.current = setTimeout(() => {
      searchRawLines(query.trim(), 20)
        .then(({ lines }) => {
          setResults(lines);
          setOpen(true);
        })
        .catch(() => setResults([]));
    }, 250);
    return () => clearTimeout(debounceRef.current);
  }, [query]);

  const handleSelect = (line: RawLine) => {
    jumpToRawLine(line.id);
    setOpen(false);
  };

  return (
    <div className="relative w-80">
      <div className="relative">
        <Search className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
        <Input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onFocus={() => results.length > 0 && setOpen(true)}
          onBlur={() => setTimeout(() => setOpen(false), 150)}
          placeholder="SEARCH LOGS…"
          className="h-8 pl-7 text-xs uppercase tracking-wide placeholder:text-muted-foreground focus-visible:ring-primary"
        />
      </div>
      {open && results.length > 0 && (
        <div className="absolute z-20 mt-1 max-h-72 w-full overflow-auto border border-border bg-popover shadow-md">
          {results.map((line) => (
            <button
              key={line.id}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => handleSelect(line)}
              className="block w-full truncate border-b border-border/50 px-2 py-1.5 text-left font-mono text-xs last:border-b-0 hover:bg-accent"
            >
              {line.rawText}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
