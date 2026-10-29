import type { Link, Page, SectionOptions } from "../payload-types";
import { bulletList, pageLink, paragraph, richText, text } from "./lexical";

/**
 * The invented Neighborhood Growers site, the same content the WordPress seed
 * creates. The home page matches the Spike 2 fixtures, so every section type
 * appears once, plus one hidden section.
 */

/** Seeded pages in creation order: parents before children. */
export const PAGES = [
  { slug: "home", title: "Home" },
  { slug: "get-involved", title: "Get involved" },
  { slug: "apply", title: "Apply now" },
  { slug: "guide", title: "Starter guide" },
  { slug: "programs", title: "Programs" },
  { parent: "programs", slug: "seed-library", title: "Seed library" },
  { parent: "programs", slug: "tool-share", title: "Tool share" },
] as const;

export type PageSlug = (typeof PAGES)[number]["slug"];

/** Image files in @launch/demo-content. */
export type ImageFile =
  | "harvest.jpg"
  | "portrait.jpg"
  | "raised-beds.jpg"
  | "seeds.jpg"
  | "tools.jpg";

export interface SeedRefs {
  page: (slug: PageSlug) => number;
  image: (file: ImageFile) => number;
}

type Layout = NonNullable<Page["layout"]>;

const options = (value: Partial<SectionOptions> = {}): SectionOptions => ({
  hidden: false,
  paddingBottom: "md",
  paddingTop: "md",
  skin: "light",
  width: "default",
  ...value,
});

const pageRef = (label: string, pageId: number) => ({
  label,
  newTab: false,
  reference: { relationTo: "pages" as const, value: pageId },
  type: "reference" as const,
});

const toPage = (
  label: string,
  pageId: number,
  variant: Link["variant"] = "primary"
) => ({ link: { ...pageRef(label, pageId), variant } });

const intro = (
  heading: string,
  body: string,
  value: Partial<SectionOptions> = {}
): Layout[number] => ({
  align: "start",
  blockType: "content",
  body: richText(paragraph(body)),
  heading,
  sectionOptions: options(value),
});

export const layouts = ({
  image,
  page,
}: SeedRefs): Record<PageSlug, Layout> => ({
  apply: [
    intro(
      "Apply for a garden",
      "Tell us about the lot and the neighbors who want to grow there. We reply within two weeks."
    ),
  ],
  "get-involved": [
    intro(
      "Get involved",
      "Volunteer on a harvest day, mentor a new garden or join the seed library."
    ),
    {
      blockType: "callToAction",
      heading: "Ready to start?",
      links: [toPage("Apply now", page("apply"))],
      sectionOptions: options({ skin: "accent", width: "narrow" }),
    },
  ],
  guide: [
    intro(
      "Starter guide",
      "Everything a new garden needs in its first season, from soil tests to a watering rota."
    ),
  ],
  home: [
    {
      align: "center",
      blockName: "Intro",
      blockType: "content",
      body: richText(
        paragraph(
          "We help neighbors turn empty lots into ",
          text("shared gardens", "bold"),
          "."
        )
      ),
      eyebrow: "Neighborhood Growers",
      heading: "Grow food together",
      links: [
        toPage("Get involved", page("get-involved")),
        {
          link: {
            label: "Garden map",
            newTab: true,
            type: "custom",
            url: "https://maps.example.org/gardens",
            variant: "secondary",
          },
        },
      ],
      sectionOptions: options({
        anchor: "Intro",
        paddingBottom: "lg",
        paddingTop: "lg",
        skin: "accent",
        width: "narrow",
      }),
    },
    {
      blockType: "contentMedia",
      body: richText(
        bulletList(
          ["Find a lot"],
          ["Gather ", text("five", "italic"), " neighbors"]
        ),
        paragraph("Read ", pageLink("the starter guide", page("guide")), ".")
      ),
      heading: "How a garden starts",
      links: [],
      media: image("raised-beds.jpg"),
      mediaPosition: "end",
      sectionOptions: options({ width: "wide" }),
    },
    {
      blockType: "cardGrid",
      cards: [
        {
          image: image("seeds.jpg"),
          link: pageRef("Browse seeds", page("seed-library")),
          text: "Borrow seeds in spring, return saved seeds in fall.",
          title: "Seed library",
        },
        {
          image: image("tools.jpg"),
          link: pageRef("Reserve a tool", page("tool-share")),
          text: "Shovels, wheelbarrows and hoses for every member garden.",
          title: "Tool share",
        },
        {
          link: { type: "reference" },
          text: "After-school planting and harvest days.",
          title: "Youth growers",
        },
      ],
      columns: "3",
      heading: "Programs",
      sectionOptions: options({ anchor: "programs", paddingTop: "none" }),
    },
    {
      attribution: "Rosa Delgado",
      blockType: "blockquote",
      image: image("portrait.jpg"),
      quote:
        "The garden is the first place on our block where everyone knows each other's names.",
      role: "Garden lead",
      sectionOptions: options({
        paddingBottom: "lg",
        paddingTop: "lg",
        skin: "dark",
        width: "narrow",
      }),
    },
    {
      blockType: "media",
      media: image("harvest.jpg"),
      sectionOptions: options({
        paddingBottom: "none",
        paddingTop: "none",
        width: "full",
      }),
    },
    {
      blockName: "Join",
      blockType: "callToAction",
      body: richText(
        paragraph("We bring soil, seeds and a mentor for the first season.")
      ),
      heading: "Start a garden on your block",
      links: [toPage("Apply now", page("apply"))],
      sectionOptions: options({
        anchor: "join",
        skin: "accent",
        width: "narrow",
      }),
    },
    {
      blockType: "callToAction",
      heading: "Winter volunteer drive",
      links: [],
      sectionOptions: options({ hidden: true }),
    },
  ],
  programs: [
    intro(
      "Programs",
      "Shared resources for every member garden, run by volunteers."
    ),
  ],
  "seed-library": [
    intro(
      "Seed library",
      "Borrow seeds in spring and return saved seeds in fall, so the library grows every year."
    ),
  ],
  "tool-share": [
    intro(
      "Tool share",
      "Reserve shovels, wheelbarrows and hoses for a work day. Pick up and return at the garden shed."
    ),
  ],
});
