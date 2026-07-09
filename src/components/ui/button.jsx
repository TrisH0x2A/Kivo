import { cva } from "class-variance-authority";

import { cn } from "@/lib/utils.js";

const buttonVariants = cva(
  "inline-flex items-center justify-center whitespace-nowrap rounded-none border border-transparent text-sm font-semibold shadow-[inset_0_1px_0_hsl(var(--foreground)/0.05)] transition-[background-color,border-color,color,opacity,box-shadow,transform] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-60",
  {
    variants: {
      variant: {
        default: "border-primary/70 bg-primary text-primary-foreground hover:border-primary hover:bg-primary/90 hover:shadow-[inset_0_1px_0_hsl(var(--foreground)/0.08),0_0_0_1px_hsl(var(--primary)/0.22)]",
        secondary: "border-border/45 bg-secondary/70 text-secondary-foreground hover:border-border/70 hover:bg-secondary/90",
        ghost: "border-transparent bg-transparent text-muted-foreground hover:border-border/45 hover:bg-accent/70 hover:text-accent-foreground",
        outline: "border-border/60 bg-background/20 text-foreground hover:border-primary/38 hover:bg-accent/70"
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
