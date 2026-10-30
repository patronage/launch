import type { ComponentProps } from "react";

import { cn } from "../utils";

/** shadcn/ui card, with the parts the section blocks use. */
export const Card = ({ className, ...props }: ComponentProps<"div">) => (
  <div
    className={cn(
      "bg-card text-card-foreground flex flex-col gap-5 overflow-hidden rounded-xl border py-6",
      className
    )}
    data-slot="card"
    {...props}
  />
);

export const CardHeader = ({ className, ...props }: ComponentProps<"div">) => (
  <div
    className={cn("grid auto-rows-min items-start gap-1.5 px-6", className)}
    data-slot="card-header"
    {...props}
  />
);

export const CardTitle = ({ className, ...props }: ComponentProps<"div">) => (
  <div
    className={cn("leading-snug font-semibold", className)}
    data-slot="card-title"
    {...props}
  />
);

export const CardDescription = ({
  className,
  ...props
}: ComponentProps<"div">) => (
  <div
    className={cn("text-muted-foreground text-sm", className)}
    data-slot="card-description"
    {...props}
  />
);

export const CardContent = ({ className, ...props }: ComponentProps<"div">) => (
  <div className={cn("px-6", className)} data-slot="card-content" {...props} />
);

export const CardFooter = ({ className, ...props }: ComponentProps<"div">) => (
  <div
    className={cn("mt-auto flex items-center px-6", className)}
    data-slot="card-footer"
    {...props}
  />
);
