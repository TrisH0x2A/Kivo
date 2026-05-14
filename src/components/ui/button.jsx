import { cva } from "class-variance-authority";

import { cn } from "@/lib/utils.js";

const buttonVariants = cva(
  "inline-flex items-center justify-center whitespace-nowrap rounded-none border border-transparent text-sm font-medium transition-[background-color,border-color,color,opacity] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-60",
  {
    variants: {
      variant: {
        default: "border-primary/65 bg-primary text-primary-foreground hover:bg-primary/90",
        secondary: "border-border/40 bg-secondary/60 text-secondary-foreground hover:bg-secondary/80",
        ghost: "border-transparent bg-transparent text-muted-foreground hover:border-border/40 hover:bg-accent hover:text-accent-foreground",
        outline: "border-border/55 bg-transparent text-foreground hover:bg-accent/60"
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
