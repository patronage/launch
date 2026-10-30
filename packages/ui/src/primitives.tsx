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

export const Img = ({
  className,
  image,
  loading = "lazy",
}: {
  className?: string;
  image: Image;
  loading?: "lazy" | "eager";
}) => (
  <img
    alt={image.alt}
    className={cn("block h-auto max-w-full", className)}
    decoding="async"
    height={image.height}
    loading={loading}
    src={image.src}
    width={image.width}
  />
);

export const Figure = ({
  className,
  media,
}: {
  className?: string;
  media: Media;
}) => (
  <figure className={cn("m-0", className)}>
    <Img className="w-full rounded-xl" image={media.image} />
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
