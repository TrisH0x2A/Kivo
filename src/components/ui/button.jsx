import { cva } from "class-variance-authority";

import { cn } from "@/lib/utils.js";

const buttonVariants = cva(
  "inline-flex items-center justify-center whitespace-nowrap rounded-md border border-transparent text-sm font-semibold transition-[background-color,border-color,color,opacity,box-shadow,transform] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-60",
  {
    variants: {
      variant: {
        default: "border-primary/55 bg-primary text-primary-foreground hover:border-primary hover:bg-primary/90",
        secondary: "border-border/30 bg-secondary/40 text-secondary-foreground hover:border-primary/25 hover:bg-secondary/60",
        ghost: "border-transparent bg-transparent text-muted-foreground hover:border-transparent hover:bg-accent/25 hover:text-accent-foreground",
        outline: "border-border/40 bg-transparent text-foreground hover:border-primary/30 hover:bg-accent/30"
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
