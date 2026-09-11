import { cn } from "@/lib/utils.js";

export function Input({ className, ...props }) {
  return (
    <input
      className={cn(
        "kivo-field flex h-8 w-full rounded-md px-2.5 text-[12px] text-foreground outline-none ring-offset-background placeholder:text-muted-foreground/70 focus-visible:border-ring focus-visible:ring-0",
        className
      )}
      {...props}
    />
  );
}
