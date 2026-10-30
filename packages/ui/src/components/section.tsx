import type { Skin, Spacing } from "@launch/content-model";
import { cva } from "class-variance-authority";
import type { ComponentProps } from "react";

import { cn } from "../utils";

/**
 * Patronage section: a full-width band with a skin and vertical padding.
 * `skin` sets `data-skin`, which remaps the colour tokens (tokens.css), so
 * Typography, buttons and cards inside take the section's colours.
 */
export const sectionVariants = cva(
  "bg-section-background text-section-foreground relative w-full",
  {
    defaultVariants: {
      paddingBottom: "md",
      paddingTop: "md",
    },
    variants: {
      paddingBottom: {
        lg: "pb-section-lg",
        md: "pb-section-md",
        none: "pb-0",
        sm: "pb-section-sm",
      },
      paddingTop: {
        lg: "pt-section-lg",
        md: "pt-section-md",
        none: "pt-0",
        sm: "pt-section-sm",
      },
    },
  }
);

export type SectionProps = Omit<ComponentProps<"section">, "ref"> & {
  as?: "article" | "aside" | "div" | "footer" | "header" | "section";
  skin?: Skin;
  paddingTop?: Spacing;
  paddingBottom?: Spacing;
};

export const Section = ({
  as: Component = "section",
  className,
  paddingBottom,
  paddingTop,
  skin = "light",
  ...props
}: SectionProps) => (
  <Component
    className={cn(sectionVariants({ paddingBottom, paddingTop }), className)}
    data-component="section"
    data-skin={skin}
    {...props}
  />
);
