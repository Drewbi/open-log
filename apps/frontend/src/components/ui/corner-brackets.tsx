import type { HTMLAttributes } from "react";
import { cn } from "@/lib/utils";

const CORNER_CLASS = "absolute h-2.5 w-2.5 border-primary/70";

export function CornerBrackets({ className, children, ...props }: HTMLAttributes<HTMLDivElement>) {
  return (
    <div className={cn("relative", className)} {...props}>
      <span className={cn(CORNER_CLASS, "left-0 top-0 border-l-2 border-t-2")} />
      <span className={cn(CORNER_CLASS, "right-0 top-0 border-r-2 border-t-2")} />
      <span className={cn(CORNER_CLASS, "bottom-0 left-0 border-b-2 border-l-2")} />
      <span className={cn(CORNER_CLASS, "bottom-0 right-0 border-b-2 border-r-2")} />
      {children}
    </div>
  );
}
