import { cva } from "class-variance-authority";
import type { VariantProps } from "class-variance-authority";
import type { ElementType, HTMLAttributes } from "react";

import { cn } from "../utils";

/**
 * Patronage type scale, trimmed to what the sections use. Variants are named
 * by role, so a heading's look and its level are chosen separately: pass `as`
 * to change the element. Colours come from the section around it.
 */
export const typographyVariants = cva("", {
  defaultVariants: {
    variant: "body-md",
  },
  variants: {
    // Kept in groups (display, headings, body, small) so the scale reads in order.
    // oxlint-disable-next-line sort-keys
    variant: {
      d1: "font-display text-section-heading text-5xl leading-[1.05] font-semibold tracking-tight text-balance md:text-7xl",
      d2: "font-display text-section-heading text-4xl leading-tight font-semibold tracking-tight text-balance md:text-6xl",
      h1: "font-display text-section-heading text-4xl leading-tight font-semibold tracking-tight text-balance md:text-5xl",
      h2: "font-display text-section-heading text-3xl leading-tight font-semibold tracking-tight text-balance md:text-4xl",
      h3: "font-display text-section-heading text-xl leading-snug font-semibold text-balance md:text-2xl",
      h4: "font-display text-section-heading text-lg leading-snug font-semibold text-balance",
      lead: "text-section-muted text-lg leading-relaxed text-pretty md:text-xl",
      "body-lg": "text-section-foreground text-lg leading-relaxed text-pretty",
      "body-md":
        "text-section-foreground text-base leading-relaxed text-pretty",
      "body-sm": "text-section-muted text-sm leading-normal text-pretty",
      muted: "text-section-muted text-sm leading-normal text-pretty",
      eyebrow:
        "text-section-accent font-mono text-xs font-medium tracking-widest uppercase",
      quote:
        "font-display text-section-heading text-2xl leading-snug font-medium tracking-tight text-balance md:text-4xl",
    },
  },
});

export type TypographyVariant = NonNullable<
  VariantProps<typeof typographyVariants>["variant"]
>;

const variantToElement = {
  "body-lg": "p",
  "body-md": "p",
  "body-sm": "p",
  d1: "h1",
  d2: "h2",
  eyebrow: "p",
  h1: "h1",
  h2: "h2",
  h3: "h3",
  h4: "h4",
  lead: "p",
  muted: "p",
  quote: "blockquote",
} satisfies Record<TypographyVariant, ElementType>;

export interface TypographyProps
  extends HTMLAttributes<HTMLElement>, VariantProps<typeof typographyVariants> {
  as?: ElementType;
}

export const Typography = ({
  as,
  className,
  variant,
  ...props
}: TypographyProps) => {
  const Component = as ?? variantToElement[variant ?? "body-md"];

  return (
    <Component
      className={cn(typographyVariants({ variant }), className)}
      {...props}
    />
  );
};
