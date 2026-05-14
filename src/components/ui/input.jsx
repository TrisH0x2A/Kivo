import { cn } from "@/lib/utils.js";

export function Input({ className, ...props }) {
  return (
    <input
      className={cn(
        "flex h-8 w-full rounded-none border border-border/50 bg-input/80 px-2.5 text-[12px] text-foreground outline-none ring-offset-background placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-1 focus-visible:ring-ring/60",
        className
      )}
      {...props}
    />
  );
}
