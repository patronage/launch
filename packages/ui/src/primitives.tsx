import type { Image, Link, LinkVariant, Media } from "@launch/content-model";
import type { ReactNode } from "react";

import { buttonVariants } from "./components/button";
import { cn } from "./utils";

const LINK_BUTTON = {
  primary: buttonVariants({ size: "lg", variant: "default" }),
  secondary: buttonVariants({ size: "lg", variant: "outline" }),
  // cn() lets the link variant's zero padding win over the size's.
  text: cn(buttonVariants({ size: "lg", variant: "link" })),
} satisfies Record<LinkVariant, string>;

/** A link styled as a button in its variant. */
export const LinkButton = ({
  className,
  link,
}: {
  className?: string;
  link: Link;
}) => (
  <a
    className={cn(LINK_BUTTON[link.variant], className)}
    data-variant={link.variant}
    href={link.href}
    {...(link.newTab ? { rel: "noopener noreferrer", target: "_blank" } : {})}
  >
    {link.label}
  </a>
);

export const LinkList = ({
  className,
  links,
}: {
  className?: string;
  links: Link[];
}) => {
  if (links.length === 0) {
    return null;
  }

  return (
    <ul className={cn("flex flex-wrap items-center gap-3", className)}>
      {links.map((link) => (
        <li key={`${link.href}|${link.label}`}>
          <LinkButton link={link} />
        </li>
      ))}
    </ul>
  );
};

/** `sizes` for an image in a card grid: three columns, then two, then one. */
export const CARD_IMAGE_SIZES =
  "(min-width: 1024px) 33vw, (min-width: 640px) 50vw, 100vw";

/**
 * An image. When the adapter gave a `srcset`, `sizes` tells the browser how
 * wide the image is drawn, so it fetches the narrowest candidate that fills
 * it; the default is the full viewport width.
 */
export const Img = ({
  className,
  image,
  loading = "lazy",
  sizes = "100vw",
}: {
  className?: string;
  image: Image;
  loading?: "lazy" | "eager";
  sizes?: string | undefined;
}) => (
  <img
    alt={image.alt}
    className={cn("block h-auto max-w-full", className)}
    decoding="async"
    height={image.height}
    loading={loading}
    sizes={image.srcset ? sizes : undefined}
    src={image.src}
    srcSet={image.srcset}
    width={image.width}
  />
);

export const Figure = ({
  className,
  media,
  sizes,
}: {
  className?: string;
  media: Media;
  /** The image's drawn width, as for {@link Img}. */
  sizes?: string;
}) => (
  <figure className={cn("m-0", className)}>
    <Img className="w-full rounded-xl" image={media.image} sizes={sizes} />
    {media.caption ? (
      <figcaption className="text-section-muted mt-3 text-sm">
        {media.caption}
      </figcaption>
    ) : null}
  </figure>
);

/** Wrapper for adapter-rendered rich text. The UI never parses it. */
export const RichText = ({
  children,
  className,
}: {
  children?: ReactNode;
  className?: string;
}) => {
  if (children === undefined || children === null) {
    return null;
  }

  return (
    <div
      className={cn(
        "prose-section prose prose-lg prose-headings:font-display prose-headings:font-semibold prose-headings:tracking-tight max-w-none",
        className
      )}
    >
      {children}
    </div>
  );
};
