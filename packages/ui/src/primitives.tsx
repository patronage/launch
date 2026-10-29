import type { Image, Link, Media } from "@launch/content-model";
import type { ReactNode } from "react";

export const LinkList = ({ links }: { links: Link[] }) => {
  if (links.length === 0) {
    return null;
  }

  return (
    <ul className="l-links">
      {links.map((link) => (
        <li key={`${link.href}|${link.label}`}>
          <a
            className="l-link"
            data-variant={link.variant}
            href={link.href}
            {...(link.newTab
              ? { rel: "noopener noreferrer", target: "_blank" }
              : {})}
          >
            {link.label}
          </a>
        </li>
      ))}
    </ul>
  );
};

export const Img = ({
  image,
  loading = "lazy",
}: {
  image: Image;
  loading?: "lazy" | "eager";
}) => (
  <img
    alt={image.alt}
    decoding="async"
    height={image.height}
    loading={loading}
    src={image.src}
    width={image.width}
  />
);

export const Figure = ({ media }: { media: Media }) => (
  <figure className="l-media">
    <Img image={media.image} />
    {media.caption ? <figcaption>{media.caption}</figcaption> : null}
  </figure>
);

/** Wrapper for adapter-rendered rich text. The UI never parses it. */
export const RichText = ({ children }: { children?: ReactNode }) => {
  if (children === undefined || children === null) {
    return null;
  }

  return <div className="l-rich">{children}</div>;
};

export const Heading = ({
  as: Tag = "h2",
  className = "l-title",
  children,
}: {
  as?: "h1" | "h2" | "h3";
  className?: string;
  children?: ReactNode;
}) => {
  if (!children) {
    return null;
  }

  return <Tag className={className}>{children}</Tag>;
};
