import type { Skin } from "@launch/content-model";
import { Container, Section, Typography } from "@launch/ui";

import { SKIN_LABELS } from "../lib/section-library";
import type { LibraryExample } from "../lib/section-library";
import { PageView } from "./page-view";

interface Props {
  examples: LibraryExample[];
  /** The skins to show each section in, in order. */
  skins: readonly Skin[];
  /** The skin picked with `?skin=`, or undefined for all of them. */
  picked: Skin | undefined;
}

const SKIN_CHOICES: { href: string; label: string; skin: Skin | undefined }[] =
  [
    { href: "/sections", label: "All colours", skin: undefined },
    { href: "/sections?skin=light", label: "Light", skin: "light" },
    { href: "/sections?skin=dark", label: "Dark", skin: "dark" },
    { href: "/sections?skin=accent", label: "Accent", skin: "accent" },
  ];

const chipClass =
  "rounded-full border border-current/25 px-4 py-1.5 text-sm font-medium transition-colors hover:border-current/60";

const pickedChipClass =
  "rounded-full border border-transparent bg-primary px-4 py-1.5 text-sm font-medium text-primary-foreground";

/**
 * The colour switcher. Not sticky: the site header already sticks at the top
 * (z-40) and would cover it.
 */
const SkinSwitcher = ({ picked }: { picked: Skin | undefined }) => (
  <Section
    as="div"
    className="border-b border-current/10 py-3"
    paddingBottom="none"
    paddingTop="none"
    skin="light"
  >
    <Container>
      <nav aria-label="Section colour" className="flex flex-wrap gap-2">
        {SKIN_CHOICES.map((choice) => (
          <a
            aria-current={choice.skin === picked ? "page" : undefined}
            className={choice.skin === picked ? pickedChipClass : chipClass}
            href={choice.href}
            key={choice.label}
          >
            {choice.label}
          </a>
        ))}
      </nav>
    </Container>
  </Section>
);

/** A small caption above each example: its section type and colour. */
const ExampleLabel = ({
  example,
  skin,
}: {
  example: LibraryExample;
  skin: Skin;
}) => (
  <Section
    as="div"
    className="border-t border-current/10 py-3"
    paddingBottom="none"
    paddingTop="none"
    skin="light"
  >
    <Container className="flex flex-wrap items-baseline justify-between gap-2">
      <Typography as="h2" variant="eyebrow">
        {example.label} · {SKIN_LABELS[skin]}
      </Typography>
      <a
        className="text-section-muted text-sm underline underline-offset-4"
        href={example.pageSlug === "home" ? "/" : `/${example.pageSlug}`}
      >
        Used on {example.pageSlug === "home" ? "Home" : `/${example.pageSlug}`}
      </a>
    </Container>
  </Section>
);

/**
 * Every section type the editor offers, each in the picked colour or in all
 * of them, drawn by the same components the site's pages use.
 */
export const SectionLibraryView = ({ examples, skins, picked }: Props) => (
  <>
    <Section paddingBottom="md" skin="light">
      <Container>
        <Typography variant="eyebrow">Section library</Typography>
        <Typography className="mt-4 max-w-3xl" variant="h1">
          Every section, in every colour.
        </Typography>
        <Typography className="mt-6 max-w-2xl" variant="lead">
          Pages on this site are built from these reusable sections. Editors
          stack them in any order and pick a colour for each one. The same
          components power our WordPress and Payload sites too.
        </Typography>
      </Container>
    </Section>
    <SkinSwitcher picked={picked} />
    {examples.flatMap((example) =>
      skins.map((skin) => (
        <div key={`${example.section._type}-${skin}`}>
          <ExampleLabel example={example} skin={skin} />
          <PageView
            data={{ sections: [{ ...example.section, section_skin: skin }] }}
            firstHeadingIsTitle={false}
            slug="sections"
          />
        </div>
      ))
    )}
  </>
);
