import { cva } from "class-variance-authority";
import type { VariantProps } from "class-variance-authority";
import type { ComponentProps } from "react";

import { cn } from "../utils";

/**
 * Patronage container: centres content at a max width with the site gutter.
 * Widths follow `ContainerWidth` in @launch/content-model, plus `content`
 * for reading-width layouts that sit between narrow and default.
 */
export const containerVariants = cva("mx-auto w-full", {
  defaultVariants: {
    gutter: "default",
    width: "default",
  },
  variants: {
    gutter: {
      default: "px-gutter",
      none: "px-0",
    },
    width: {
      // 896px
      content: "max-w-4xl",
      // 1152px
      default: "max-w-6xl",
      // No max width
      full: "max-w-none",
      // 672px
      narrow: "max-w-2xl",
      // 1280px
      wide: "max-w-7xl",
    },
  },
});

export type ContainerWidthVariant = NonNullable<
  VariantProps<typeof containerVariants>["width"]
>;

export type ContainerProps = ComponentProps<"div"> &
  VariantProps<typeof containerVariants>;

export const Container = ({
  className,
  gutter,
  width,
  ...props
}: ContainerProps) => (
  <div
    className={cn(containerVariants({ gutter, width }), className)}
    data-component="container"
    data-width={width ?? "default"}
    {...props}
  />
);
