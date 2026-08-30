import { cva } from "class-variance-authority";

import { cn } from "@/lib/utils.js";

const buttonVariants = cva(
  "inline-flex items-center justify-center whitespace-nowrap rounded-none border border-transparent text-sm font-semibold transition-[background-color,border-color,color,opacity,box-shadow,transform] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-60",
  {
    variants: {
      variant: {
        default: "border-primary/55 bg-primary text-primary-foreground shadow-[0_8px_22px_hsl(var(--primary)/0.18),inset_0_1px_0_hsl(var(--foreground)/0.08)] hover:border-primary hover:bg-primary/92 hover:shadow-[0_12px_30px_hsl(var(--primary)/0.22),inset_0_1px_0_hsl(var(--foreground)/0.1)]",
        secondary: "border-border/18 bg-secondary/42 text-secondary-foreground shadow-[inset_0_1px_0_hsl(var(--foreground)/0.035)] hover:border-primary/25 hover:bg-secondary/62",
        ghost: "border-transparent bg-transparent text-muted-foreground hover:border-transparent hover:bg-accent/22 hover:text-accent-foreground",
        outline: "border-border/20 bg-background/12 text-foreground shadow-[inset_0_1px_0_hsl(var(--foreground)/0.03)] hover:border-primary/30 hover:bg-accent/28"
      },
      size: {
        default: "h-8 px-3 py-2",
        sm: "h-7 px-2.5 text-[11px]",
        icon: "h-8 w-8"
      }
    },
    defaultVariants: {
      variant: "default",
      size: "default"
    }
  }
);

export function Button({ className, variant, size, ...props }) {
  return <button className={cn(buttonVariants({ variant, size, className }))} {...props} />;
}
