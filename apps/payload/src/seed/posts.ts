import type { Post } from "../payload-types";
import type { ImageFile, PageSlug } from "./content";
import {
  block,
  bulletList,
  button,
  heading,
  pageLink,
  paragraph,
  richText,
  text,
} from "./lexical";

/**
 * Neighborhood Growers news: bylines, categories and posts, enough for the
 * listing and a long article to feel real in a demo. One post stays a draft,
 * and one published post has a newer draft, so preview and version history
 * have something to show.
 */

export const AUTHORS = [
  {
    bio: "Rosa started the Elm Street garden in 2019 and now mentors new garden leads.",
    image: "portrait.jpg",
    name: "Rosa Delgado",
    role: "Garden lead",
  },
  {
    bio: "Marcus runs the seed library and keeps the spreadsheet everyone relies on.",
    name: "Marcus Webb",
    role: "Seed library coordinator",
  },
  {
    bio: "Priya handles volunteers, partners and the newsletter.",
    name: "Priya Shah",
    role: "Program director",
  },
] as const;

export type AuthorName = (typeof AUTHORS)[number]["name"];

export const CATEGORIES = [
  { slug: "announcements", title: "Announcements" },
  { slug: "how-to", title: "How-to" },
  { slug: "stories", title: "Garden stories" },
  { slug: "events", title: "Events" },
] as const;

export type CategorySlug = (typeof CATEGORIES)[number]["slug"];

export interface PostRefs {
  author: (name: AuthorName) => number;
  category: (slug: CategorySlug) => number;
  image: (file: ImageFile) => number;
  page: (slug: PageSlug) => number;
}

type SeedPost = Pick<
  Post,
  "content" | "excerpt" | "featured" | "publishedAt" | "slug" | "title"
> & {
  authors: number[];
  categories: number[];
  hero?: number;
  /** Saved as a draft only, never published. */
  draftOnly?: boolean;
  /** A change saved as a draft on top of the published post. */
  pendingEdit?: Partial<Pick<Post, "excerpt" | "title">>;
};

export const posts = ({
  author,
  category,
  image,
  page,
}: PostRefs): SeedPost[] => [
  {
    authors: [author("Priya Shah")],
    categories: [category("announcements")],
    content: richText(
      paragraph(
        "Thanks to a two-year grant from the Riverside Community Fund, we can open four new gardens on vacant lots in the Eastside and Mill Creek neighborhoods next spring."
      ),
      paragraph(
        "The grant covers soil testing, raised-bed lumber, a water hookup for each lot and a paid garden mentor for the first season. Neighbors keep the harvest; we keep the paperwork."
      ),
      heading("h2", "What happens next"),
      bulletList(
        ["January: we confirm the four lots with the city land bank."],
        ["February: open meetings on each block to pick a garden lead."],
        ["March: build day. Bring gloves; we bring everything else."]
      ),
      paragraph(
        "If your block has an empty lot and five neighbors who want to grow, ",
        pageLink("apply now", page("apply")),
        ". Applications for this round close December 15."
      ),
      block({
        blockType: "embed",
        caption: "What a build day looks like, start to finish.",
        url: "https://www.youtube.com/watch?v=aqz-KE-bpKQ",
      }),
      paragraph(
        button({
          label: "Apply for a garden",
          newTab: false,
          reference: { relationTo: "pages", value: page("apply") },
          type: "reference",
          variant: "primary",
        })
      )
    ),
    excerpt:
      "A two-year grant from the Riverside Community Fund will turn four vacant lots into shared gardens next spring.",
    featured: true,
    hero: image("raised-beds.jpg"),
    publishedAt: "2026-10-21T12:00:00.000Z",
    slug: "four-new-gardens-next-spring",
    title: "Four new gardens are coming next spring",
  },
  {
    authors: [author("Marcus Webb")],
    categories: [category("how-to")],
    content: richText(
      paragraph(
        "Saving seed is how the library grows. Every packet you return in the fall becomes three packets for someone else in the spring."
      ),
      heading("h2", "Start with the easy ones"),
      paragraph(
        "Beans, peas, lettuce and tomatoes are the best first crops to save from: they mostly pollinate themselves, so the seed grows true."
      ),
      bulletList(
        ["Let a few of the healthiest plants go fully to seed."],
        ["Harvest on a dry day and spread the seed on paper for a week."],
        ["Label everything: crop, variety, garden and year."]
      ),
      block({
        attribution: "Marcus Webb, seed library coordinator",
        blockType: "pullquote",
        quote:
          "Every packet you return becomes three packets for someone else.",
      }),
      block({
        blockType: "image",
        caption: "Packets ready for the spring swap",
        image: image("seeds.jpg"),
      }),
      heading("h2", "Bringing seed back"),
      paragraph(
        "Drop labeled envelopes in the return box at any member garden, or bring them to the ",
        pageLink("seed library", page("seed-library")),
        " swap on the first Saturday of November."
      )
    ),
    excerpt:
      "Beans, peas, lettuce and tomatoes are the easiest crops to save seed from. Here's how to bring your harvest back to the library.",
    hero: image("seeds.jpg"),
    publishedAt: "2026-10-08T12:00:00.000Z",
    slug: "how-to-save-seed",
    title: "How to save seed for the library",
  },
  {
    authors: [author("Rosa Delgado")],
    categories: [category("stories")],
    content: richText(
      paragraph(
        "Seven years ago the lot at Elm and 4th was a fenced square of gravel and broken glass. This September we weighed ",
        text("1,140 pounds", "bold"),
        " of produce from it, and gave most of it away on the sidewalk."
      ),
      paragraph(
        "None of that came from expertise. It came from showing up every Saturday, and from neighbors who noticed and started showing up too."
      ),
      paragraph(
        "If you're thinking about a garden on your block, read the ",
        pageLink("starter guide", page("guide")),
        ". It's everything I wish I'd known in year one."
      ),
      block({
        blockType: "embed",
        caption: "The embed block takes posts on X as well as videos.",
        url: "https://x.com/jack/status/20",
      })
    ),
    excerpt:
      "Seven years after the first raised bed, the Elm Street garden harvested more than half a ton of food this season.",
    hero: image("harvest.jpg"),
    pendingEdit: {
      title: "Elm Street's best harvest yet: 1,140 pounds",
    },
    publishedAt: "2026-09-30T12:00:00.000Z",
    slug: "elm-street-harvest",
    title: "Elm Street's best harvest yet",
  },
  {
    authors: [author("Priya Shah"), author("Rosa Delgado")],
    categories: [category("events")],
    content: richText(
      paragraph(
        "Every member garden needs a few extra hands before the frost. Join us on Saturday, November 14, from 9 a.m. to noon."
      ),
      bulletList(
        ["Pull spent plants and compost them."],
        ["Mulch beds with leaves from the city drop-off."],
        ["Coil hoses and return borrowed tools to the shed."]
      ),
      paragraph(
        "Coffee and pastries at Elm Street at 8:30. ",
        pageLink("Sign up to volunteer", page("get-involved")),
        "."
      )
    ),
    excerpt:
      "Help put eleven gardens to bed for the winter on Saturday, November 14.",
    hero: image("tools.jpg"),
    publishedAt: "2026-10-27T12:00:00.000Z",
    slug: "fall-cleanup-day",
    title: "Fall cleanup day: November 14",
  },
  {
    authors: [author("Marcus Webb")],
    categories: [category("announcements")],
    content: richText(
      paragraph(
        "The tool share now has two more wheelbarrows, a broadfork and a second set of long-handled loppers, bought with donations from the spring plant sale."
      ),
      paragraph(
        "Reserve them on the ",
        pageLink("tool share", page("tool-share")),
        " page and pick up at the Elm Street shed."
      )
    ),
    excerpt: "New wheelbarrows, a broadfork and loppers are ready to borrow.",
    publishedAt: "2026-08-12T12:00:00.000Z",
    slug: "new-tools-in-the-shed",
    title: "New tools in the shed",
  },
  {
    authors: [author("Priya Shah")],
    categories: [category("announcements")],
    content: richText(
      paragraph(
        "We're looking for a part-time youth program coordinator to run after-school planting days at three gardens. Draft: confirm hours and pay band with the board before publishing."
      )
    ),
    draftOnly: true,
    excerpt: "A part-time role running after-school planting days.",
    publishedAt: "2026-11-02T12:00:00.000Z",
    slug: "hiring-youth-coordinator",
    title: "We're hiring a youth program coordinator",
  },
];
