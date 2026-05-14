import { cn } from "@/lib/utils.js";

export function Textarea({ className, ...props }) {
  return (
    <textarea
      className={cn(
        "flex min-h-[220px] w-full rounded-none border border-border/50 bg-input/70 px-3 py-2.5 text-[12.5px] text-foreground outline-none ring-offset-background placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-1 focus-visible:ring-ring/60",
        className
      )}
      {...props}
    />
  );
}
