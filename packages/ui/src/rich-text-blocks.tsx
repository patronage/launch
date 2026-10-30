import type {
  PullquoteEmbed,
  RichTextBlock as RichTextBlockModel,
  UrlEmbed,
} from "@launch/content-model";

import { Figure, LinkButton } from "./primitives";

/** What an embed URL points at, read from its host and path. */
type Player =
  | { kind: "video"; src: string }
  | { kind: "post"; url: string }
  | { kind: "link"; url: string };

const YOUTUBE_HOSTS = new Set([
  "youtube.com",
  "www.youtube.com",
  "m.youtube.com",
]);

const X_HOSTS = new Set([
  "x.com",
  "www.x.com",
  "twitter.com",
  "www.twitter.com",
]);

const VIDEO_ID = /^[\w-]{6,}$/u;

/** A YouTube video id from a watch, short, embed or youtu.be URL. */
const youtubeId = (url: URL): string | undefined => {
  const segments = url.pathname.split("/").filter(Boolean);

  const id =
    url.hostname === "youtu.be"
      ? segments[0]
      : (url.searchParams.get("v") ??
        (["embed", "shorts", "live"].includes(segments[0] ?? "")
          ? segments[1]
          : undefined));

  return id && VIDEO_ID.test(id) ? id : undefined;
};

const vimeoId = (url: URL): string | undefined => {
  const id = url.pathname.split("/").findLast(Boolean);

  return id && /^\d+$/u.test(id) ? id : undefined;
};

/** True for an X (Twitter) post: /<user>/status/<id>. */
const isXPost = (url: URL): boolean => {
  const [, status, id] = url.pathname.split("/").filter(Boolean);

  return status === "status" && /^\d+$/u.test(id ?? "");
};

export const playerFor = (value: string): Player | undefined => {
  if (!URL.canParse(value)) {
    return undefined;
  }

  const url = new URL(value);

  if (url.protocol !== "https:") {
    return undefined;
  }

  const youtube =
    YOUTUBE_HOSTS.has(url.hostname) || url.hostname === "youtu.be"
      ? youtubeId(url)
      : undefined;

  if (youtube) {
    // The no-cookie host sets no tracking cookies until the visitor plays.
    return {
      kind: "video",
      src: `https://www.youtube-nocookie.com/embed/${youtube}`,
    };
  }

  const vimeo = url.hostname.endsWith("vimeo.com") ? vimeoId(url) : undefined;

  if (vimeo) {
    return {
      kind: "video",
      src: `https://player.vimeo.com/video/${vimeo}?dnt=1`,
    };
  }

  if (X_HOSTS.has(url.hostname) && isXPost(url)) {
    return { kind: "post", url: url.href };
  }

  return { kind: "link", url: url.href };
};

const Caption = ({ caption }: { caption: string | undefined }) =>
  caption ? (
    <figcaption className="text-section-muted mt-3 text-sm">
      {caption}
    </figcaption>
  ) : null;

/**
 * A video player for YouTube and Vimeo, X's own widget for an X post, and a
 * plain link for anything else. Other URLs are never framed, so an editor
 * cannot put an arbitrary page inside the site.
 */
export const Embed = ({ embed }: { embed: UrlEmbed }) => {
  const player = playerFor(embed.url);

  if (!player) {
    return null;
  }

  if (player.kind === "video") {
    return (
      <figure className="not-prose my-8" data-embed="video">
        <iframe
          allow="accelerometer; encrypted-media; gyroscope; picture-in-picture; fullscreen"
          className="aspect-video w-full rounded-xl border-0"
          loading="lazy"
          referrerPolicy="strict-origin-when-cross-origin"
          // oxlint-disable-next-line react/iframe-missing-sandbox -- the players are cross-origin, so allow-same-origin gives them their own origin, not ours; they need it and scripts to play.
          sandbox="allow-scripts allow-same-origin allow-presentation allow-popups"
          src={player.src}
          title={embed.caption ?? "Embedded video"}
        />
        <Caption caption={embed.caption} />
      </figure>
    );
  }

  if (player.kind === "post") {
    // widgets.js turns the blockquote into the post; without it, it stays a link.
    return (
      <figure className="not-prose my-8" data-embed="post">
        <blockquote className="twitter-tweet" data-dnt="true">
          <a href={player.url}>View the post on X</a>
        </blockquote>
        <script
          async
          charSet="utf-8"
          src="https://platform.twitter.com/widgets.js"
        />
        <Caption caption={embed.caption} />
      </figure>
    );
  }

  return (
    <p data-embed="link">
      <a href={player.url} rel="noopener noreferrer" target="_blank">
        {embed.caption ?? player.url}
      </a>
    </p>
  );
};

export const Pullquote = ({ block }: { block: PullquoteEmbed }) => (
  <figure className="not-prose border-section-accent my-10 border-l-4 pl-6">
    <blockquote className="font-display text-section-heading text-2xl leading-snug font-semibold text-balance md:text-3xl">
      <p>{block.quote}</p>
    </blockquote>
    {block.attribution ? (
      <figcaption className="text-section-muted mt-4 text-base">
        {block.attribution}
      </figcaption>
    ) : null}
  </figure>
);

/** Draws a block an editor placed inside rich text. */
export const RichTextBlock = ({ block }: { block: RichTextBlockModel }) => {
  switch (block.type) {
    case "button": {
      // An inline block: it sits inside a paragraph, so it draws no block element.
      return <LinkButton className="not-prose" link={block.link} />;
    }

    case "image": {
      return <Figure className="not-prose my-8" media={block.media} />;
    }

    case "pullquote": {
      return <Pullquote block={block} />;
    }

    case "embed": {
      return <Embed embed={block} />;
    }

    default: {
      // Exhaustiveness check: adding a rich-text block without a component fails typecheck.
      const unknownBlock: never = block;

      return unknownBlock;
    }
  }
};
