/**
 * Writes seed/seed.json, the schema and demo content EmDash applies to an
 * empty database. Field names follow @launch/content-model (ADR 0008), in
 * EmDash's snake_case. Run `pnpm --filter @launch/emdash seed:write` after a change;
 * `pnpm test` fails while seed.json is stale.
 *
 *   node seed/build.ts          # write seed/seed.json
 *   node seed/build.ts --check  # exit 1 if seed/seed.json is out of date
 */
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import { newsDates } from "./news-dates.ts";

const out = path.join(import.meta.dirname, "seed.json");

// Field definitions -----------------------------------------------------------

/** A JSON value, as seed.json holds. Undefined keys are dropped when written. */
type Json =
  | string
  | number
  | boolean
  | null
  | Json[]
  | { [key: string]: Json | undefined };

interface Field {
  slug: string;
  label: string;
  type: string;
  required?: boolean;
  searchable?: boolean;
  options?: string[];
  validation?: {
    allowedTypes?: string[];
    maxItems?: number;
    minItems?: number;
    options?: string[];
    pattern?: string;
    subFields?: Field[];
  };
}

const field = (
  slug: string,
  label: string,
  type: string,
  extra: Partial<Field> = {}
): Field => ({ label, slug, type, ...extra });

const select = (slug: string, label: string, options: string[]): Field =>
  field(slug, label, "select", { validation: { options } });

/** A select inside a repeater, where EmDash reads `options` directly. */
const subSelect = (slug: string, label: string, options: string[]) => ({
  ...field(slug, label, "select"),
  options,
});

const SKINS = ["light", "dark", "accent"];
const WIDTHS = ["narrow", "default", "wide", "full"];
const SPACINGS = ["none", "sm", "md", "lg"];
const ALIGNS = ["start", "center"];

const linkFields = [
  field("label", "Label", "string", { required: true }),
  field("url", "URL", "string", {
    required: true,
    validation: { pattern: "^(?:https?://|mailto:|tel:|/(?!/)|#).+$" },
  }),
  subSelect("variant", "Style", ["primary", "secondary", "text"]),
  field("new_tab", "Open in a new tab", "boolean"),
];

const links = (slug = "links", label = "Buttons"): Field =>
  field(slug, label, "repeater", {
    validation: { maxItems: 3, subFields: linkFields },
  });

/** Every section block carries these, as Section options in the content model. */
const sectionOptions = [
  select("section_skin", "Skin", SKINS),
  select("section_width", "Width", WIDTHS),
  select("section_padding_top", "Padding top", SPACINGS),
  select("section_padding_bottom", "Padding bottom", SPACINGS),
  field("section_anchor", "Anchor", "string"),
  field("section_hidden", "Hide this section", "boolean"),
];

const blockType = (
  slug: string,
  label: string,
  description: string,
  fields: Field[]
) => ({
  category: "Page sections",
  currentVersion: 1,
  description,
  label,
  slug,
  versions: [{ fields: [...fields, ...sectionOptions], version: 1 }],
});

const blockTypes = [
  blockType("content", "Content", "Heading, rich text and buttons", [
    field("eyebrow", "Eyebrow", "string"),
    field("heading", "Heading", "string"),
    field("body", "Body", "portableText"),
    links(),
    select("align", "Alignment", ALIGNS),
  ]),
  blockType("content_media", "Content and media", "Text beside an image", [
    field("eyebrow", "Eyebrow", "string"),
    field("heading", "Heading", "string"),
    field("body", "Body", "portableText"),
    links(),
    field("image", "Image", "image", { required: true }),
    field("caption", "Caption", "text"),
    select("media_position", "Image side", ["start", "end"]),
  ]),
  blockType("media", "Media", "A single image", [
    field("image", "Image", "image", { required: true }),
    field("caption", "Caption", "text"),
  ]),
  blockType("card_grid", "Card grid", "A heading and a grid of cards", [
    field("heading", "Heading", "string"),
    select("columns", "Columns", ["2", "3", "4"]),
    field("cards", "Cards", "repeater", {
      required: true,
      validation: {
        maxItems: 12,
        minItems: 1,
        subFields: [
          field("title", "Title", "string", { required: true }),
          field("text", "Text", "text"),
          field("image", "Image", "image"),
          field("link_label", "Link label", "string"),
          field("link_url", "Link URL", "string"),
        ],
      },
    }),
  ]),
  blockType("blockquote", "Blockquote", "A quote with its attribution", [
    field("quote", "Quote", "text", { required: true }),
    field("attribution", "Attribution", "string"),
    field("role", "Role", "string"),
    field("image", "Portrait", "image"),
  ]),
  blockType(
    "call_to_action",
    "Call to action",
    "A heading, a line of text and buttons",
    [
      field("heading", "Heading", "string", { required: true }),
      field("body", "Body", "portableText"),
      links(),
    ]
  ),
  // The form itself is built under Plugins > Forms; this places it on a page.
  blockType("form", "Form", "A heading, rich text and a form", [
    field("heading", "Heading", "string"),
    field("body", "Body", "portableText"),
    field("form", "Form slug (from Plugins > Forms)", "string", {
      required: true,
    }),
  ]),
];

const SECTION_TYPES = blockTypes.map((type) => type.slug);

const HERO_VARIANTS = ["none", "home", "split", "media", "simple", "freeform"];

const pages = {
  fields: [
    field("title", "Title", "string", { required: true, searchable: true }),
    select("hero_variant", "Hero", HERO_VARIANTS),
    field("hero_eyebrow", "Hero eyebrow", "string"),
    field("hero_title", "Hero title (defaults to the page title)", "string"),
    field("hero_subhead", "Hero subhead", "text"),
    field("hero_image", "Hero image", "image"),
    links("hero_links", "Hero buttons"),
    select("hero_skin", "Hero skin", SKINS),
    select("hero_align", "Hero alignment", ALIGNS),
    field("hero_body", "Hero body (free-form heroes)", "portableText"),
    field("sections", "Sections", "blocks", {
      validation: { allowedTypes: SECTION_TYPES, maxItems: 30 },
    }),
  ],
  label: "Pages",
  labelSingular: "Page",
  slug: "pages",
  supports: ["drafts", "revisions", "preview", "search", "seo"],
  // The home page's slug is `home`; the front end serves it at `/`.
  urlPattern: "/{slug}",
};

/**
 * News stories, at /news/{slug}. Each story takes exactly one category (the
 * news-rules plugin refuses to publish one without) and any number of tags.
 */
const news = {
  fields: [
    field("title", "Title", "string", { required: true, searchable: true }),
    field("excerpt", "Excerpt (shown on cards)", "text", { searchable: true }),
    field(
      "featured_image",
      "Featured image (defaults to the category's image)",
      "image"
    ),
    field("body", "Body", "portableText", { searchable: true }),
  ],
  label: "News",
  labelSingular: "News story",
  slug: "news",
  supports: ["drafts", "revisions", "preview", "search", "seo"],
  urlPattern: "/news/{slug}",
};

/**
 * What a category term can't hold: its image and intro. One entry per
 * category, with the category's slug as its own; it has no page of its own.
 */
const categoryDetails = {
  fields: [
    field("title", "Category name", "string", { required: true }),
    field("image", "Image (for stories without one)", "image"),
    field("intro", "Intro (on the category page)", "text"),
  ],
  label: "Category details",
  labelSingular: "Category details",
  slug: "category_details",
  supports: ["revisions"],
};

// Demo content ----------------------------------------------------------------

/**
 * The invented Neighborhood Growers site that the WordPress and Payload seeds
 * also create (packages/demo-content). Forms, rich-text buttons, pull quotes
 * and embeds are left out: see apps/emdash/README.md.
 */

/**
 * EmDash downloads `$media` images into R2 when it applies the seed. Its
 * download refuses private addresses, so the images come from this public
 * repository's copy of packages/demo-content rather than a local server.
 */
const DEMO_IMAGES =
  "https://raw.githubusercontent.com/patronage/launch/main/packages/demo-content/images";

// SAFETY: images.json is this repository's own list of demo images, an array
// of { file, alt, caption? } (see packages/demo-content/README.md).
const imageAlts = JSON.parse(
  readFileSync(
    path.join(
      import.meta.dirname,
      "../../../packages/demo-content/images.json"
    ),
    "utf-8"
  )
) as { file: string; alt: string; caption?: string }[];

const image = (file: string) => {
  const meta = imageAlts.find((entry) => entry.file === file);

  if (!meta) {
    throw new Error(`No demo image named ${file}`);
  }

  return {
    $media: { alt: meta.alt, filename: file, url: `${DEMO_IMAGES}/${file}` },
  };
};

let keyCount = 0;

const key = () => {
  keyCount += 1;

  return `k${keyCount}`;
};

type Mark = "strong" | "em";

interface Span {
  text: string;
  marks?: Mark[];
  href?: string;
}

const span = (text: string, ...marks: Mark[]): Span => ({ marks, text });
const link = (text: string, href: string): Span => ({ href, text });

/** A Portable Text text block, as EmDash stores it. */
interface TextBlock {
  [key: string]: Json | undefined;
  _key: string;
  _type: "block";
  children: { _key: string; _type: "span"; marks: string[]; text: string }[];
  markDefs: { _type: "link"; _key: string; href: string }[];
  style: string;
  level?: number;
  listItem?: "bullet";
}

/** The section option fields every section block carries. */
interface SectionOptions {
  [key: string]: Json | undefined;
  section_hidden: boolean;
  section_padding_bottom: string;
  section_padding_top: string;
  section_skin: string;
  section_width: string;
  section_anchor?: string;
}

/** A Portable Text block of spans; links become markDefs. */
const block = (
  parts: (string | Span)[],
  extra: { style?: string; listItem?: "bullet"; level?: number } = {}
) => {
  const markDefs: { _type: "link"; _key: string; href: string }[] = [];

  const children = parts.map((part) => {
    const value: Span = part instanceof Object ? part : { text: part };
    const marks: string[] = [...(value.marks ?? [])];

    if (value.href) {
      const markKey = key();
      markDefs.push({ _key: markKey, _type: "link", href: value.href });
      marks.push(markKey);
    }

    return { _key: key(), _type: "span" as const, marks, text: value.text };
  });

  const result: TextBlock = {
    _key: key(),
    _type: "block",
    children,
    markDefs,
    style: extra.style ?? "normal",
  };

  if (extra.listItem) {
    result.level = extra.level ?? 1;
    result.listItem = extra.listItem;
  }

  return result;
};

const paragraph = (...parts: (string | Span)[]) => [block(parts)];

const options = (
  value: {
    skin?: string;
    width?: string;
    top?: string;
    bottom?: string;
    anchor?: string;
    hidden?: boolean;
  } = {}
): SectionOptions => {
  const result: SectionOptions = {
    section_hidden: value.hidden ?? false,
    section_padding_bottom: value.bottom ?? "md",
    section_padding_top: value.top ?? "md",
    section_skin: value.skin ?? "light",
    section_width: value.width ?? "default",
  };

  if (value.anchor) {
    result.section_anchor = value.anchor;
  }

  return result;
};

const button = (
  label: string,
  url: string,
  variant = "primary",
  newTab = false
) => ({ label, new_tab: newTab, url, variant });

const section = (type: string, fields: { [key: string]: Json }) => ({
  _key: key(),
  _type: type,
  _version: 1,
  ...fields,
});

const intro = (heading: string, body: string) =>
  section("content", {
    align: "start",
    body: paragraph(body),
    heading,
    ...options(),
  });

const page = (slug: string, title: string, data: { [key: string]: Json }) => ({
  data: { hero_variant: "none", title, ...data },
  id: `page-${slug}`,
  slug,
  status: "published",
});

const content = {
  pages: [
    page("home", "Home", {
      sections: [
        section("content", {
          align: "center",
          body: paragraph(
            "We help neighbors turn empty lots into ",
            span("shared gardens", "strong"),
            "."
          ),
          eyebrow: "Neighborhood Growers",
          heading: "Grow food together",
          links: [
            button("Get involved", "/get-involved"),
            button(
              "Garden map",
              "https://maps.example.org/gardens",
              "secondary",
              true
            ),
          ],
          ...options({
            anchor: "intro",
            bottom: "lg",
            skin: "accent",
            top: "lg",
            width: "narrow",
          }),
        }),
        section("content_media", {
          body: [
            block(["Find a lot"], { listItem: "bullet" }),
            block(["Gather ", span("five", "em"), " neighbors"], {
              listItem: "bullet",
            }),
            block(["Read ", link("the starter guide", "/guide"), "."]),
          ],
          heading: "How a garden starts",
          image: image("raised-beds.jpg"),
          links: [],
          media_position: "end",
          ...options({ width: "wide" }),
        }),
        section("card_grid", {
          cards: [
            {
              image: image("seeds.jpg"),
              link_label: "Browse seeds",
              link_url: "/seed-library",
              text: "Borrow seeds in spring, return saved seeds in fall.",
              title: "Seed library",
            },
            {
              image: image("tools.jpg"),
              link_label: "Reserve a tool",
              link_url: "/tool-share",
              text: "Shovels, wheelbarrows and hoses for every member garden.",
              title: "Tool share",
            },
            {
              text: "After-school planting and harvest days.",
              title: "Youth growers",
            },
          ],
          columns: "3",
          heading: "Programs",
          ...options({ anchor: "programs", top: "none" }),
        }),
        section("blockquote", {
          attribution: "Rosa Delgado",
          image: image("portrait.jpg"),
          quote:
            "The garden is the first place on our block where everyone knows each other's names.",
          role: "Garden lead",
          ...options({
            bottom: "lg",
            skin: "dark",
            top: "lg",
            width: "narrow",
          }),
        }),
        section("media", {
          caption: "Fall harvest day",
          image: image("harvest.jpg"),
          ...options({ bottom: "none", top: "none", width: "full" }),
        }),
        section("call_to_action", {
          body: paragraph(
            "We bring soil, seeds and a mentor for the first season."
          ),
          heading: "Start a garden on your block",
          links: [button("Apply now", "/apply")],
          ...options({ anchor: "join", skin: "accent", width: "narrow" }),
        }),
        section("call_to_action", {
          heading: "Winter volunteer drive",
          links: [],
          ...options({ hidden: true }),
        }),
      ],
    }),
    page("get-involved", "Get involved", {
      hero_eyebrow: "Volunteer",
      hero_image: image("harvest.jpg"),
      hero_links: [button("Apply for a garden", "/apply")],
      hero_subhead:
        "Volunteer on a harvest day, mentor a new garden or join the seed library.",
      hero_variant: "split",
      sections: [
        intro(
          "Volunteer with us",
          "Harvest days run every other Saturday from June to October. Mentors meet a new garden once a week in its first season."
        ),
        section("call_to_action", {
          heading: "Ready to start?",
          links: [button("Apply now", "/apply")],
          ...options({ skin: "accent", width: "narrow" }),
        }),
      ],
    }),
    page("apply", "Apply now", {
      hero_eyebrow: "Garden applications",
      hero_subhead:
        "Tell us about the lot and the neighbors who want to grow there. We reply within two weeks.",
      hero_title: "Apply for a garden",
      hero_variant: "simple",
      sections: [
        intro(
          "What we ask",
          "The lot's address, who owns it if you know, and the names of five neighbors who will help. We read every application and set up a visit."
        ),
        section("form", {
          body: paragraph("Fields marked * are required."),
          form: "garden-application",
          heading: "Your application",
          ...options(),
        }),
      ],
    }),
    page("guide", "Starter guide", {
      hero_align: "center",
      hero_body: paragraph(
        "Everything a new garden needs in its first season, from a ",
        span("soil test", "strong"),
        " to a watering rota."
      ),
      hero_eyebrow: "Starter guide",
      hero_title: "Your first season",
      hero_variant: "freeform",
      sections: [
        section("content", {
          align: "start",
          body: [
            block([
              "Before anything goes in the ground, send a soil sample to the county extension office. City lots often hold lead from old paint and fuel.",
            ]),
            block(["Raised beds"], { style: "h3" }),
            block([
              "Raised beds fix almost anything the test finds. Once they are built, set a watering rota before the first hot week.",
            ]),
          ],
          heading: "Test the soil first",
          links: [button("Find a mentor", "/get-involved", "text")],
          ...options({ width: "narrow" }),
        }),
      ],
    }),
    page("programs", "Programs", {
      hero_image: image("tools.jpg"),
      hero_subhead:
        "Shared resources for every member garden, run by volunteers.",
      hero_variant: "media",
      sections: [
        section("card_grid", {
          cards: [
            {
              image: image("seeds.jpg"),
              link_label: "Browse seeds",
              link_url: "/seed-library",
              text: "Borrow seeds in spring, return saved seeds in fall.",
              title: "Seed library",
            },
            {
              image: image("tools.jpg"),
              link_label: "Reserve a tool",
              link_url: "/tool-share",
              text: "Shovels, wheelbarrows and hoses for every member garden.",
              title: "Tool share",
            },
          ],
          columns: "2",
          heading: "Share what we have",
          ...options(),
        }),
      ],
    }),
    page("seed-library", "Seed library", {
      hero_eyebrow: "Programs",
      hero_image: image("seeds.jpg"),
      hero_links: [button("Start a garden", "/apply")],
      hero_skin: "dark",
      hero_subhead:
        "Borrow seeds in spring and return saved seeds in fall, so the library grows every year.",
      hero_variant: "home",
      sections: [
        intro(
          "How the library works",
          "Pick up to five packets each spring. In the fall, bring back seed saved from your best plants, labeled with the crop, variety and garden."
        ),
        intro(
          "Where to find it",
          "The library lives in the shed at the Elm Street garden, open Saturday mornings from April to October."
        ),
      ],
    }),
    page("tool-share", "Tool share", {
      sections: [
        intro(
          "Tool share",
          "Reserve shovels, wheelbarrows and hoses for a work day. Pick up and return at the garden shed."
        ),
      ],
    }),
  ],
};

// News ----------------------------------------------------------------------

const categories = [
  {
    image: "raised-beds.jpg",
    intro: "New gardens, grants and changes to how we run things.",
    label: "Announcements",
    slug: "announcements",
  },
  {
    image: "seeds.jpg",
    intro: "Practical guides for member gardens, season by season.",
    label: "How-to",
    slug: "how-to",
  },
  {
    image: "harvest.jpg",
    intro: "Gardeners in their own words.",
    label: "Garden stories",
    slug: "stories",
  },
  {
    image: "tools.jpg",
    intro: "Work days, swaps and harvest days you can join.",
    label: "Events",
    slug: "events",
  },
];

const tags = [
  { label: "Grants", slug: "grants" },
  { label: "Harvest", slug: "harvest" },
  { label: "Seed library", slug: "seed-library" },
  { label: "Tools", slug: "tools" },
  { label: "Volunteering", slug: "volunteering" },
  { label: "Youth", slug: "youth" },
];

interface Story {
  slug: string;
  title: string;
  category: string;
  tags: string[];
  excerpt: string;
  body: TextBlock[];
  image?: string;
  draft?: boolean;
}

/** Stories without an image show their category's. */
const stories: Story[] = [
  {
    body: [
      block([
        "The tool share now has two more wheelbarrows, a broadfork and a second set of long-handled loppers, bought with donations from the spring plant sale.",
      ]),
      block([
        "Reserve them on the ",
        link("tool share", "/tool-share"),
        " page and pick up at the Elm Street shed.",
      ]),
    ],
    category: "announcements",
    excerpt: "New wheelbarrows, a broadfork and loppers are ready to borrow.",
    slug: "new-tools-in-the-shed",
    tags: ["tools"],
    title: "New tools in the shed",
  },
  {
    body: [
      block([
        "The first hot week is when new gardens lose the most plants. A rota means every bed gets water, even when the regulars are away.",
      ]),
      block(["Setting one up"], { style: "h2" }),
      block(["Pick one evening slot per person each week."], {
        listItem: "bullet",
      }),
      block(["Water the soil, not the leaves, and water deeply."], {
        listItem: "bullet",
      }),
      block(["Post the rota on the shed door and in the group chat."], {
        listItem: "bullet",
      }),
    ],
    category: "how-to",
    excerpt:
      "Set a watering rota before the first hot week, and every bed gets water even when the regulars are away.",
    slug: "summer-watering-rota",
    tags: ["volunteering"],
    title: "Set up a watering rota before the heat",
  },
  {
    body: [
      block([
        "Forty kids from three after-school programs planted, weeded and harvested at Elm Street, Maple Court and the Grove this summer.",
      ]),
      block([
        "Their favorite crop, by a wide margin, was the ",
        span("purple bush beans", "strong"),
        ".",
      ]),
    ],
    category: "stories",
    excerpt:
      "Forty kids from three after-school programs spent the summer growing food at three gardens.",
    slug: "youth-growers-summer",
    tags: ["youth"],
    title: "A summer of youth growers",
  },
  {
    body: [
      block([
        "Seven years ago the lot at Elm and 4th was a fenced square of gravel and broken glass. This September we weighed ",
        span("1,140 pounds", "strong"),
        " of produce from it, and gave most of it away on the sidewalk.",
      ]),
      block([
        "None of that came from expertise. It came from showing up every Saturday, and from neighbors who noticed and started showing up too.",
      ]),
      block([
        "If you're thinking about a garden on your block, read the ",
        link("starter guide", "/guide"),
        ". It's everything I wish I'd known in year one.",
      ]),
    ],
    category: "stories",
    excerpt:
      "Seven years after the first raised bed, the Elm Street garden harvested more than half a ton of food this season.",
    image: "harvest.jpg",
    slug: "elm-street-harvest",
    tags: ["harvest"],
    title: "Elm Street's best harvest yet",
  },
  {
    body: [
      block([
        "Saving seed is how the library grows. Every packet you return in the fall becomes three packets for someone else in the spring.",
      ]),
      block(["Start with the easy ones"], { style: "h2" }),
      block([
        "Beans, peas, lettuce and tomatoes are the best first crops to save from: they mostly pollinate themselves, so the seed grows true.",
      ]),
      block(["Let a few of the healthiest plants go fully to seed."], {
        listItem: "bullet",
      }),
      block(["Harvest on a dry day and spread the seed on paper for a week."], {
        listItem: "bullet",
      }),
      block(["Label everything: crop, variety, garden and year."], {
        listItem: "bullet",
      }),
      block(["Bringing seed back"], { style: "h2" }),
      block([
        "Drop labeled envelopes in the return box at any member garden, or bring them to the ",
        link("seed library", "/seed-library"),
        " swap on the first Saturday of November.",
      ]),
    ],
    category: "how-to",
    excerpt:
      "Beans, peas, lettuce and tomatoes are the easiest crops to save seed from. Here's how to bring your harvest back to the library.",
    image: "seeds.jpg",
    slug: "how-to-save-seed",
    tags: ["seed-library", "harvest"],
    title: "How to save seed for the library",
  },
  {
    body: [
      block([
        "Bring saved seed, take home something new. The swap runs from 10 a.m. to 1 p.m. on Saturday, November 7, in the Elm Street shed.",
      ]),
      block([
        "No seed to trade? Come anyway: first-time growers go home with five packets.",
      ]),
    ],
    category: "events",
    excerpt:
      "Trade saved seed for something new at the Elm Street shed on Saturday, November 7.",
    slug: "november-seed-swap",
    tags: ["seed-library"],
    title: "The November seed swap",
  },
  {
    body: [
      block([
        "A two-year grant from the Riverside Community Fund will turn four vacant lots into shared gardens next spring.",
      ]),
      block([
        "Each new garden gets soil, lumber for raised beds and a mentor for its first season. ",
        link("Apply for a garden", "/apply"),
        " by January 15.",
      ]),
    ],
    category: "announcements",
    excerpt:
      "A two-year grant from the Riverside Community Fund will turn four vacant lots into shared gardens next spring.",
    image: "raised-beds.jpg",
    slug: "four-new-gardens-next-spring",
    tags: ["grants"],
    title: "Four new gardens are coming next spring",
  },
  {
    body: [
      block([
        "Every member garden needs a few extra hands before the frost. Join us on Saturday, November 14, from 9 a.m. to noon.",
      ]),
      block(["Pull spent plants and compost them."], { listItem: "bullet" }),
      block(["Mulch beds with leaves from the city drop-off."], {
        listItem: "bullet",
      }),
      block(["Coil hoses and return borrowed tools to the shed."], {
        listItem: "bullet",
      }),
      block([
        "Coffee and pastries at Elm Street at 8:30. ",
        link("Sign up to volunteer", "/get-involved"),
        ".",
      ]),
    ],
    category: "events",
    excerpt:
      "Help put eleven gardens to bed for the winter on Saturday, November 14.",
    image: "tools.jpg",
    slug: "fall-cleanup-day",
    tags: ["volunteering", "tools"],
    title: "Fall cleanup day: November 14",
  },
  {
    body: [
      block([
        "The city's fall leaf drop-off is open at the Grove garden through December. Bring bagged leaves; take home finished compost from last year's pile.",
      ]),
    ],
    category: "how-to",
    excerpt:
      "Drop off bagged leaves at the Grove garden through December and take home last year's compost.",
    slug: "compost-and-leaf-drop-off",
    tags: ["volunteering"],
    title: "Compost and leaf drop-off is open",
  },
  {
    body: [
      block([
        "We're looking for a part-time youth program coordinator to run after-school planting days at three gardens. Draft: confirm hours and pay with the board before publishing.",
      ]),
    ],
    category: "announcements",
    draft: true,
    excerpt: "A part-time role running after-school planting days.",
    slug: "hiring-youth-coordinator",
    tags: ["youth"],
    title: "We're hiring a youth program coordinator",
  },
];

const dateOf = (slug: string) => {
  const date = newsDates.get(slug);

  if (!date) {
    throw new Error(`No date for the news story ${slug} in seed/news-dates.ts`);
  }

  return date;
};

// Oldest first, so that stories created in the same instant still list newest
// first before setup sets their dates.
const newsEntries = stories
  .toSorted((a, b) => dateOf(a.slug).localeCompare(dateOf(b.slug)))
  .map((story) => ({
    data: {
      body: story.body,
      excerpt: story.excerpt,
      featured_image: story.image ? image(story.image) : null,
      title: story.title,
    },
    id: `news-${story.slug}`,
    slug: story.slug,
    status: story.draft ? "draft" : "published",
    taxonomies: { category: [story.category], tag: story.tags },
  }));

const categoryEntries = categories.map((category) => ({
  data: {
    image: image(category.image),
    intro: category.intro,
    title: category.label,
  },
  id: `category-${category.slug}`,
  slug: category.slug,
  status: "published",
}));

const taxonomies = [
  {
    collections: ["news"],
    hierarchical: false,
    label: "Categories",
    labelSingular: "Category",
    name: "category",
    terms: categories.map(({ label, slug }) => ({ label, slug })),
  },
  {
    collections: ["news"],
    hierarchical: false,
    label: "Tags",
    labelSingular: "Tag",
    name: "tag",
    terms: tags,
  },
];

const seed = {
  $schema: "https://emdashcms.com/seed.schema.json",
  blockTypes,
  collections: [pages, news, categoryDetails],
  content: {
    ...content,
    category_details: categoryEntries,
    news: newsEntries,
  },
  menus: [
    {
      items: [
        { label: "Programs", type: "custom", url: "/programs" },
        { label: "Starter guide", type: "custom", url: "/guide" },
        { label: "News", type: "custom", url: "/news" },
        { label: "Get involved", type: "custom", url: "/get-involved" },
        { label: "Apply", type: "custom", url: "/apply" },
      ],
      label: "Primary navigation",
      name: "primary",
    },
  ],
  // Examples of EmDash's built-in redirects; editors manage them in the admin.
  redirects: [
    { destination: "/programs", source: "/gardens", type: 301 },
    { destination: "/get-involved", source: "/volunteer", type: 302 },
    { destination: "/guide", source: "/resources/[...path]", type: 301 },
  ],
  meta: {
    author: "Patronage",
    description: "The Launch demo site on EmDash",
    name: "Launch EmDash",
  },
  taxonomies,
  settings: {
    tagline: "Shared gardens on every block",
    title: "Neighborhood Growers",
  },
  version: "1",
};

const json = `${JSON.stringify(seed, null, 2)}\n`;

if (process.argv.includes("--check")) {
  // Compared as data: the formatter may lay the file out differently.
  const current = JSON.stringify(JSON.parse(readFileSync(out, "utf-8")));

  if (current !== JSON.stringify(seed)) {
    console.error(
      "seed/seed.json is stale: run pnpm --filter @launch/emdash seed:write"
    );
    process.exit(1);
  }
} else {
  writeFileSync(out, json);
}
