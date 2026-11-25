import type { EmDashSection } from "@launch/adapter-emdash";
import type { Skin } from "@launch/content-model";
import { Container, Section, Typography } from "@launch/ui";
import type { ReactNode } from "react";

import { LIBRARY_PATH, SKIN_LABELS } from "../lib/section-library";
import type {
  LibraryExample,
  LibrarySectionType,
} from "../lib/section-library";
import { PageView } from "./page-view";

const chipClass =
  "rounded-full border border-current/25 px-4 py-1.5 text-sm font-medium transition-colors hover:border-current/60";

const pickedChipClass =
  "rounded-full border border-transparent bg-primary px-4 py-1.5 text-sm font-medium text-primary-foreground";

const pagePath = (slug: string): string => (slug === "home" ? "/" : `/${slug}`);

/** The library's own intro band. */
const LibraryIntro = ({
  eyebrow,
  title,
  children,
}: {
  eyebrow: ReactNode;
  title: string;
  children?: ReactNode;
}) => (
  <Section paddingBottom="md" skin="light">
    <Container>
      <Typography variant="eyebrow">{eyebrow}</Typography>
      <Typography className="mt-4 max-w-3xl" variant="h1">
        {title}
      </Typography>
      {children}
    </Container>
  </Section>
);

/** A thin light band that labels what follows it. */
const LabelBand = ({ children }: { children: ReactNode }) => (
  <Section
    as="div"
    className="border-t border-current/10 py-3"
    paddingBottom="none"
    paddingTop="none"
    skin="light"
  >
    <Container className="flex flex-wrap items-baseline justify-between gap-2">
      {children}
    </Container>
  </Section>
);

/**
 * One section rendered alone, through the same components pages use. Its
 * page's padding is dropped for the default, since a section that joins its
 * neighbour on the page would otherwise sit flush against the label.
 */
const Specimen = ({ section }: { section: EmDashSection }) => (
  <PageView
    data={{
      sections: [
        {
          ...section,
          section_padding_bottom: undefined,
          section_padding_top: undefined,
        },
      ],
    }}
    firstHeadingIsTitle={false}
    slug="component-library"
  />
);

// Index ---------------------------------------------------------------------------

interface IndexProps {
  types: readonly LibrarySectionType[];
  examples: Map<string, LibraryExample>;
}

/** /component-library: every section type, each linking to its own page. */
export const ComponentLibraryIndex = ({ types, examples }: IndexProps) => (
  <>
    <LibraryIntro
      eyebrow="Component library"
      title="Every section editors can add."
    >
      <Typography className="mt-6 max-w-2xl" variant="lead">
        Pages on this site are built from these reusable sections. Editors stack
        them in any order and pick a colour and layout for each one. The same
        components power our WordPress and Payload sites too.
      </Typography>
    </LibraryIntro>
    <Section paddingTop="none" skin="light">
      <Container>
        <ul className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {types.map((type) => {
            const example = examples.get(type.type);

            const variantCount = type.variants.reduce(
              (sum, option) => sum + option.values.length,
              0
            );

            return (
              <li key={type.slug}>
                <a
                  className="bg-card text-card-foreground block h-full rounded-lg border border-current/10 p-6 transition-colors hover:border-current/40"
                  href={`${LIBRARY_PATH}/${type.slug}`}
                >
                  <Typography as="h2" variant="h3">
                    {type.label}
                  </Typography>
                  <Typography className="mt-2" variant="body-md">
                    {type.description}
                  </Typography>
                  <Typography className="mt-4" variant="muted">
                    3 colours
                    {variantCount > 0 ? ` · ${variantCount} layouts` : ""}
                    {example ? "" : " · not used on a page yet"}
                  </Typography>
                </a>
              </li>
            );
          })}
        </ul>
      </Container>
    </Section>
  </>
);

// One section type ------------------------------------------------------------------

interface DetailProps {
  type: LibrarySectionType;
  example: LibraryExample | undefined;
  /** The skins to show, in order: one when picked with `?skin=`, else all. */
  skins: readonly Skin[];
  picked: Skin | undefined;
}

const SkinSwitcher = ({
  basePath,
  picked,
}: {
  basePath: string;
  picked: Skin | undefined;
}) => {
  const choices: { href: string; label: string; skin: Skin | undefined }[] = [
    { href: basePath, label: "All colours", skin: undefined },
    ...(["light", "dark", "accent"] as const).map((skin) => ({
      href: `${basePath}?skin=${skin}`,
      label: SKIN_LABELS[skin],
      skin,
    })),
  ];

  return (
    <nav aria-label="Section colour" className="mt-8 flex flex-wrap gap-2">
      {choices.map((choice) => (
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
  );
};

/**
 * /component-library/{slug}: one section type in each colour, then each of
 * its layout variants in the first colour shown.
 */
export const ComponentLibraryDetail = ({
  type,
  example,
  skins,
  picked,
}: DetailProps) => {
  const basePath = `${LIBRARY_PATH}/${type.slug}`;
  const variantSkin = skins[0] ?? "light";

  return (
    <>
      <LibraryIntro
        eyebrow={<a href={LIBRARY_PATH}>Component library</a>}
        title={type.label}
      >
        <Typography className="mt-6 max-w-2xl" variant="lead">
          {type.description}
        </Typography>
        {example ? (
          <Typography className="mt-4" variant="muted">
            This example is used on{" "}
            <a
              className="underline underline-offset-4"
              href={pagePath(example.pageSlug)}
            >
              {pagePath(example.pageSlug)}
            </a>
            .
          </Typography>
        ) : null}
        <SkinSwitcher basePath={basePath} picked={picked} />
      </LibraryIntro>

      {example ? (
        <>
          {skins.map((skin) => (
            <div key={skin}>
              <LabelBand>
                <Typography as="h2" variant="eyebrow">
                  {SKIN_LABELS[skin]}
                </Typography>
              </LabelBand>
              <Specimen section={{ ...example.section, section_skin: skin }} />
            </div>
          ))}
          {type.variants.flatMap((option) =>
            option.values.map((variant) => (
              <div key={`${option.field}-${variant.value}`}>
                <LabelBand>
                  <Typography as="h2" variant="eyebrow">
                    {option.label}: {variant.label} · {SKIN_LABELS[variantSkin]}
                  </Typography>
                </LabelBand>
                <Specimen
                  section={{
                    ...example.section,
                    [option.field]: variant.value,
                    section_skin: variantSkin,
                  }}
                />
              </div>
            ))
          )}
        </>
      ) : (
        <Section paddingTop="none" skin="light">
          <Container>
            <Typography variant="body-md">
              No published page uses this section yet. Add one to a page to see
              it here.
            </Typography>
          </Container>
        </Section>
      )}
    </>
  );
};
