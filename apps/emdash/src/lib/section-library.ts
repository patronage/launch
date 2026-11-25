/**
 * The section library at /sections: one published example of each section
 * type, shown in each skin. Examples come from the site's own pages, so the
 * library shows what editors have built, not fixtures.
 */
import type { EmDashPageData, EmDashSection } from "@launch/adapter-emdash";
import { SKINS } from "@launch/content-model";
import type { Skin } from "@launch/content-model";
import { getEmDashCollection } from "emdash";

/** Section types in the order the library shows them, with their admin names. */
export const SECTION_TYPES = [
  { label: "Content", type: "content" },
  { label: "Content and media", type: "content_media" },
  { label: "Card grid", type: "card_grid" },
  { label: "Quote", type: "blockquote" },
  { label: "Media", type: "media" },
  { label: "Call to action", type: "call_to_action" },
] as const satisfies readonly { label: string; type: EmDashSection["_type"] }[];

export const SKIN_LABELS: Record<Skin, string> = {
  accent: "Accent",
  dark: "Dark",
  light: "Light",
};

/** `?skin=` narrowed to one skin; anything else shows them all. */
export const parseSkin = (value: string | null): Skin | undefined =>
  SKINS.find((skin) => skin === value);

export interface LibraryExample {
  label: string;
  /** The page the example comes from, so a viewer can see it in place. */
  pageSlug: string;
  section: EmDashSection;
}

const isLibraryType = (
  value: { _type: string } | undefined
): value is EmDashSection =>
  SECTION_TYPES.some((entry) => entry.type === value?._type);

/** Home sorts first, as the page built to show the most section types, then by slug. */
const pageRank = (id: string): string => (id === "home" ? "" : id);

/**
 * The first visible section of each type across published pages, in
 * SECTION_TYPES order. A type no page uses is left out.
 */
export const getLibraryExamples = async (): Promise<LibraryExample[]> => {
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
      if (
        isLibraryType(section) &&
        !section.section_hidden &&
        !found.has(section._type)
      ) {
        const label =
          SECTION_TYPES.find((entry) => entry.type === section._type)?.label ??
          section._type;

        found.set(section._type, { label, pageSlug: page.id, section });
      }
    }
  }

  return SECTION_TYPES.flatMap(({ type }) => {
    const example = found.get(type);

    return example ? [example] : [];
  });
};
