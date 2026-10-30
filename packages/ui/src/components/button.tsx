import { cva } from "class-variance-authority";
import type { VariantProps } from "class-variance-authority";
import type { ComponentProps } from "react";

import { cn } from "../utils";

/** shadcn/ui button. Use `buttonVariants` to style a link as a button. */
export const buttonVariants = cva(
  "focus-visible:border-ring focus-visible:ring-ring/50 inline-flex shrink-0 items-center justify-center gap-2 rounded-md text-sm font-medium whitespace-nowrap transition-all outline-none focus-visible:ring-[3px] disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:shrink-0",
  {
    defaultVariants: {
      size: "default",
      variant: "default",
    },
    variants: {
      size: {
        default: "h-9 px-4 py-2 has-[>svg]:px-3",
        icon: "size-9",
        lg: "h-11 rounded-md px-6 text-base has-[>svg]:px-4",
        sm: "h-8 gap-1.5 rounded-md px-3 has-[>svg]:px-2.5",
      },
      variant: {
        default: "bg-primary text-primary-foreground hover:bg-primary/90",
        destructive:
          "bg-destructive hover:bg-destructive/90 focus-visible:ring-destructive/20 text-white",
        ghost: "hover:bg-accent hover:text-accent-foreground",
        link: "decoration-section-accent h-auto px-0 text-current underline underline-offset-4 hover:decoration-2 has-[>svg]:px-0",
        outline:
          "hover:bg-accent hover:text-accent-foreground border border-current/25 bg-transparent hover:border-current/60",
        secondary:
          "bg-secondary text-secondary-foreground hover:bg-secondary/80",
      },
    },
  }
);

export type ButtonProps = ComponentProps<"button"> &
  VariantProps<typeof buttonVariants>;

export const Button = ({
  className,
  size,
  type = "button",
  variant,
  ...props
}: ButtonProps) => (
  <button
    className={cn(buttonVariants({ size, variant }), className)}
    data-slot="button"
    // oxlint-disable-next-line react/button-has-type -- callers pass the type through; it defaults to "button".
    type={type}
    {...props}
  />
);
