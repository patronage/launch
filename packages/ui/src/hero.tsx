import type { Hero, Skin, Spacing } from "@launch/content-model";
import type { ReactNode } from "react";

import { Container } from "./components/container";
import { Section } from "./components/section";
import { Typography } from "./components/typography";
import { Img, LinkList, RichText } from "./primitives";
import { cn } from "./utils";

interface HeroProps {
  hero: Hero<ReactNode>;
  /** True when the next section shares the hero's skin, so they read as one band. */
  joinsNext?: boolean | undefined;
}

/** The skin the hero draws with: an image behind the title forces dark. */
export const heroSkin = (hero: Hero<ReactNode>): Skin =>
  hero.variant === "home" && hero.image ? "dark" : hero.skin;

const bottom = (joinsNext: boolean | undefined, spacing: Spacing): Spacing =>
  joinsNext ? "none" : spacing;

/** Eyebrow, the page's <h1>, subhead, rich text and links. */
const HeroCopy = ({
  className,
  display = "d1",
  hero,
}: HeroProps & { className?: string; display?: "d1" | "d2" }) => {
  const center = hero.align === "center";

  return (
    <div
      className={cn(
        "flex max-w-3xl flex-col gap-5",
        center && "mx-auto items-center text-center",
        className
      )}
    >
      {hero.eyebrow ? (
        <Typography variant="eyebrow">{hero.eyebrow}</Typography>
      ) : null}
      <Typography as="h1" variant={display}>
        {hero.title}
      </Typography>
      {hero.subhead ? (
        <Typography as="p" variant="lead">
          {hero.subhead}
        </Typography>
      ) : null}
      <RichText className={cn("prose-xl", center && "mx-auto")}>
        {hero.body}
      </RichText>
      <LinkList
        className={cn("mt-2", center && "justify-center")}
        links={hero.links}
      />
    </div>
  );
};

/** Title over a full-bleed image, which a scrim darkens for legibility. */
const HomeHero = ({ hero }: HeroProps) => (
  <Section
    className="flex min-h-[70vh] items-end overflow-hidden"
    data-hero="home"
    paddingBottom="lg"
    paddingTop="lg"
    skin={heroSkin(hero)}
  >
    {hero.image ? (
      <>
        <Img
          className="absolute inset-0 size-full object-cover"
          image={hero.image}
          loading="eager"
        />
        <div
          aria-hidden="true"
          className="absolute inset-0 bg-linear-to-t from-black/80 via-black/40 to-black/10"
        />
      </>
    ) : null}
    <Container className="relative">
      <HeroCopy hero={hero} />
    </Container>
  </Section>
);

const SplitHero = ({ hero, joinsNext }: HeroProps) => (
  <Section
    data-hero="split"
    paddingBottom={bottom(joinsNext, "lg")}
    paddingTop="lg"
    skin={hero.skin}
  >
    <Container className="grid items-center gap-10 md:grid-cols-2 lg:gap-16">
      <HeroCopy display="d2" hero={{ ...hero, align: "start" }} />
      {hero.image ? (
        <Img
          className="aspect-4/3 w-full rounded-xl object-cover"
          image={hero.image}
          loading="eager"
          sizes="(min-width: 768px) 50vw, 100vw"
        />
      ) : null}
    </Container>
  </Section>
);

const MediaHero = ({ hero, joinsNext }: HeroProps) => (
  <Section
    data-hero="media"
    paddingBottom={bottom(joinsNext, "md")}
    paddingTop="lg"
    skin={hero.skin}
  >
    <Container className="flex flex-col gap-12">
      <HeroCopy display="d2" hero={hero} />
      {hero.image ? (
        <Img
          className="aspect-21/9 w-full rounded-xl object-cover"
          image={hero.image}
          loading="eager"
        />
      ) : null}
    </Container>
  </Section>
);

/** Copy only, for interior pages; `freeform` adds the editor's rich text. */
const CopyHero = ({ hero, joinsNext }: HeroProps) => (
  <Section
    data-hero={hero.variant}
    paddingBottom={bottom(joinsNext, "md")}
    paddingTop="lg"
    skin={hero.skin}
  >
    <Container>
      <HeroCopy
        display={hero.variant === "freeform" ? "d1" : "d2"}
        hero={hero}
      />
    </Container>
  </Section>
);

/**
 * The page's hero in its variant. It holds the page's only <h1>. Like two
 * sections with the same skin, a hero that `joinsNext` drops its bottom
 * padding; the full-bleed home hero keeps its own.
 */
export const PageHero = ({ hero, joinsNext }: HeroProps) => {
  switch (hero.variant) {
    case "home": {
      return <HomeHero hero={hero} />;
    }

    case "split": {
      return <SplitHero hero={hero} joinsNext={joinsNext} />;
    }

    case "media": {
      return <MediaHero hero={hero} joinsNext={joinsNext} />;
    }

    case "simple":
    case "freeform": {
      return <CopyHero hero={hero} joinsNext={joinsNext} />;
    }

    default: {
      // Exhaustiveness check: adding a hero variant without a layout fails typecheck.
      const unknownVariant: never = hero.variant;

      return unknownVariant;
    }
  }
};
