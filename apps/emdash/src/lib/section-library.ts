/**
 * The component library at /component-library: every section type editors
 * can add, each on its own page at /component-library/{slug} in every colour
 * and layout variant. Examples come from the site's own published pages, so
 * the library shows what editors have built, not fixtures. Signed-in EmDash
 * users only.
 */
import type { EmDashPageData, EmDashSection } from "@launch/adapter-emdash";
import { SKINS } from "@launch/content-model";
import type { Skin } from "@launch/content-model";
import { getEmDashCollection } from "emdash";

export const LIBRARY_PATH = "/component-library";

/** A layout option on a section type, and the values the editor offers. */
export interface LibraryVariantOption {
  field: string;
  label: string;
  values: readonly { label: string; value: string }[];
}

export interface LibrarySectionType {
  /** The URL segment under LIBRARY_PATH. */
  slug: string;
  type: EmDashSection["_type"];
  label: string;
  description: string;
  /** Layout options that change how the section looks, besides its colour. */
  variants: readonly LibraryVariantOption[];
}

/**
 * Section types in the order the library shows them, with their admin names.
 * Variant options mirror the block fields in seed/build.ts.
 */
export const SECTION_TYPES: readonly LibrarySectionType[] = [
  {
    description: "Eyebrow, heading, rich text and buttons.",
    label: "Content",
    slug: "content",
    type: "content",
    variants: [
      {
        field: "align",
        label: "Alignment",
        values: [
          { label: "Start", value: "start" },
          { label: "Centre", value: "center" },
        ],
      },
    ],
  },
  {
    description: "Text beside an image.",
    label: "Content and media",
    slug: "content-and-media",
    type: "content_media",
    variants: [
      {
        field: "media_position",
        label: "Image side",
        values: [
          { label: "Start", value: "start" },
          { label: "End", value: "end" },
        ],
      },
    ],
  },
  {
    description: "A heading over a grid of cards.",
    label: "Card grid",
    slug: "card-grid",
    type: "card_grid",
    variants: [
      {
        field: "columns",
        label: "Columns",
        values: [
          { label: "2 columns", value: "2" },
          { label: "3 columns", value: "3" },
          { label: "4 columns", value: "4" },
        ],
      },
    ],
  },
  {
    description: "A pull quote with its attribution.",
    label: "Quote",
    slug: "quote",
    type: "blockquote",
    variants: [],
  },
  {
    description: "One image with a caption.",
    label: "Media",
    slug: "media",
    type: "media",
    variants: [],
  },
  {
    description: "A heading, a line of text and buttons.",
    label: "Call to action",
    slug: "call-to-action",
    type: "call_to_action",
    variants: [],
  },
];

export const SKIN_LABELS: Record<Skin, string> = {
  accent: "Accent",
  dark: "Dark",
  light: "Light",
};

/** `?skin=` narrowed to one skin; anything else shows them all. */
export const parseSkin = (value: string | null): Skin | undefined =>
  SKINS.find((skin) => skin === value);

export const findSectionType = (
  slug: string | undefined
): LibrarySectionType | undefined =>
  SECTION_TYPES.find((entry) => entry.slug === slug);

export interface LibraryExample {
  /** The page the example comes from, so a viewer can see it in place. */
  pageSlug: string;
  section: EmDashSection;
}

/** Home sorts first, as the page built to show the most section types, then by slug. */
const pageRank = (id: string): string => (id === "home" ? "" : id);

/**
 * The first visible section of each type across published pages, by type.
 * A type no page uses is missing from the map.
 */
export const getLibraryExamples = async (): Promise<
  Map<string, LibraryExample>
> => {
  const { entries } = await getEmDashCollection<"pages", EmDashPageData>(
    "pages",
    { status: "published" }
  );

  const pages = entries.toSorted((a, b) =>
    pageRank(a.id).localeCompare(pageRank(b.id))
  );

  const found = new Map<string, LibraryExample>();

  for (const page of pages) {
    for (const section of page.data.sections ?? []) {
      const known = SECTION_TYPES.some((entry) => entry.type === section._type);

      if (known && !section.section_hidden && !found.has(section._type)) {
        // SAFETY: the type was matched against SECTION_TYPES just above.
        found.set(section._type, {
          pageSlug: page.id,
          section: section as EmDashSection,
        });
      }
    }
  }

  return found;
};
