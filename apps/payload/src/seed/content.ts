import type {
  Link,
  Page,
  PageHero,
  SectionOptions,
  SeoMeta,
} from "../payload-types";
import type { FormTitle } from "./forms";
import {
  block,
  bulletList,
  button,
  pageLink,
  paragraph,
  richText,
  text,
} from "./lexical";

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

/** Old addresses that moved, one of them with another CMS's trailing slash. */
export const REDIRECTS: { from: string; to: PageSlug }[] = [
  { from: "/seeds", to: "seed-library" },
  { from: "/2024/05/tool-library/", to: "tool-share" },
];

/** Editor-written search and social text, for the pages that have it. */
export const pageMeta: Partial<Record<PageSlug, SeoMeta>> = {
  "seed-library": {
    description:
      "Borrow seeds in spring, return some of your harvest in the fall. Free for every neighbor.",
    title: "Free seed library for neighbors",
  },
  "tool-share": { noindex: true },
};

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
  form: (title: FormTitle) => number;
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

const formSection = (
  formId: number,
  heading?: string,
  body?: string
): Layout[number] => ({
  blockType: "form",
  body: body ? richText(paragraph(body)) : null,
  form: formId,
  heading: heading ?? null,
  sectionOptions: options(),
});

const urlLink = (label: string, url: string, variant: Link["variant"]) => ({
  label,
  newTab: true,
  type: "custom" as const,
  url,
  variant,
});

/**
 * A hero on every page but the home page, which opens with its intro section
 * as the WordPress seed's does, and the tool share, which shows a page
 * without one. Each variant appears once.
 */
export const heroes = ({
  image,
  page,
}: SeedRefs): Partial<Record<PageSlug, PageHero>> => ({
  apply: {
    eyebrow: "Garden applications",
    subhead:
      "Tell us about the lot and the neighbors who want to grow there. We reply within two weeks.",
    title: "Apply for a garden",
    variant: "simple",
  },
  "get-involved": {
    eyebrow: "Volunteer",
    image: image("harvest.jpg"),
    links: [toPage("Sign up below", page("get-involved"))],
    subhead:
      "Volunteer on a harvest day, mentor a new garden or join the seed library.",
    variant: "split",
  },
  guide: {
    align: "center",
    body: richText<PageHero["body"]>(
      paragraph(
        "Everything a new garden needs in its first season, from a ",
        text("soil test", "bold"),
        " to a watering rota."
      ),
      paragraph(
        button({
          ...pageRef("Apply for a garden", page("apply")),
          variant: "primary",
        }),
        " ",
        button(
          urlLink(
            "Download the checklist",
            "https://example.org/starter-checklist.pdf",
            "secondary"
          )
        )
      ),
      block({
        blockType: "embed",
        caption: "A three-minute tour of a first-season garden.",
        url: "https://www.youtube.com/watch?v=aqz-KE-bpKQ",
      })
    ),
    eyebrow: "Starter guide",
    title: "Your first season",
    variant: "freeform",
  },
  programs: {
    image: image("tools.jpg"),
    subhead: "Shared resources for every member garden, run by volunteers.",
    variant: "media",
  },
  "seed-library": {
    eyebrow: "Programs",
    image: image("seeds.jpg"),
    links: [toPage("Start a garden", page("apply"))],
    skin: "dark",
    subhead:
      "Borrow seeds in spring and return saved seeds in fall, so the library grows every year.",
    variant: "home",
  },
});

export const layouts = ({
  form,
  image,
  page,
}: SeedRefs): Record<PageSlug, Layout> => ({
  apply: [formSection(form("Garden application"))],
  "get-involved": [
    formSection(
      form("Volunteer sign-up"),
      "Volunteer with us",
      "Tell us how you'd like to help and we'll match you with a garden."
    ),
    {
      blockType: "callToAction",
      heading: "Ready to start?",
      links: [toPage("Apply now", page("apply"))],
      sectionOptions: options({ skin: "accent", width: "narrow" }),
    },
  ],
  guide: [
    {
      align: "start",
      blockType: "content",
      body: richText(
        paragraph(
          "Before anything goes in the ground, send a soil sample to the county extension office. City lots often hold lead from old paint and fuel."
        ),
        block({
          attribution: "Rosa Delgado, garden lead",
          blockType: "pullquote",
          quote:
            "Test first, plant second. Raised beds fix almost anything the test finds.",
        }),
        block({
          blockType: "image",
          caption: "",
          image: image("raised-beds.jpg"),
        }),
        paragraph(
          "Once the beds are built, set a watering rota before the first hot week. ",
          button({
            ...pageRef("Find a mentor", page("get-involved")),
            variant: "text",
          })
        )
      ),
      heading: "Test the soil first",
      links: [],
      sectionOptions: options({ width: "narrow" }),
    },
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
      ],
      columns: "2",
      heading: "Share what we have",
      sectionOptions: options(),
    },
  ],
  "seed-library": [
    intro(
      "How the library works",
      "Pick up to five packets each spring. In the fall, bring back seed saved from your best plants, labeled with the crop, variety and garden."
    ),
    intro(
      "Where to find it",
      "The library lives in the shed at the Elm Street garden, open Saturday mornings from April to October."
    ),
  ],
  "tool-share": [
    intro(
      "Tool share",
      "Reserve shovels, wheelbarrows and hoses for a work day. Pick up and return at the garden shed."
    ),
  ],
});
