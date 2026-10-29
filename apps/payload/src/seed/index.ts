import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import images from "@launch/demo-content/images.json" with { type: "json" };
import type { Payload } from "payload";

import type { ImageFile, PageSlug } from "./content";
import { layouts, PAGES } from "./content";

/**
 * Creates or updates the demo pages, their images and the site settings. Runs
 * again safely: pages are matched by slug and images by alt text, so a rerun
 * resets the demo content without duplicating it.
 *
 * Payload 4 checks access in the Local API by default; seeding is trusted, so
 * every call passes `overrideAccess: true`.
 */

interface DemoImage {
  alt: string;
  caption?: string;
  file: string;
}

const lookup =
  <K extends string>(ids: Map<string, number>, kind: string) =>
  (key: K): number => {
    const id = ids.get(key);

    if (id === undefined) {
      throw new Error(`Seed has no ${kind} ${key}`);
    }

    return id;
  };

/** Runs async tasks one after another. */
const inSequence = async (tasks: (() => Promise<void>)[]): Promise<void> => {
  for (const task of tasks) {
    // oxlint-disable-next-line no-await-in-loop -- the point is to run in order.
    await task();
  }
};

const seedImage = async (
  payload: Payload,
  { alt, caption, file }: DemoImage
): Promise<[string, number]> => {
  const {
    docs: [existing],
  } = await payload.find({
    collection: "media",
    limit: 1,
    overrideAccess: true,
    // Payload renames uploads (`seeds-original.jpg`), so match on alt text.
    where: { alt: { equals: alt } },
  });

  const data = { alt, caption: caption ?? null };

  if (existing) {
    await payload.update({
      collection: "media",
      data,
      id: existing.id,
      overrideAccess: true,
    });

    return [file, existing.id];
  }

  const buffer = await readFile(
    fileURLToPath(import.meta.resolve(`@launch/demo-content/images/${file}`))
  );

  const created = await payload.create({
    collection: "media",
    data,
    file: {
      data: buffer,
      mimetype: "image/jpeg",
      name: file,
      size: buffer.length,
    },
    overrideAccess: true,
  });

  return [file, created.id];
};

/** Creates or renames a page without content, so others can link to it. */
const seedPage = async (
  payload: Payload,
  page: (typeof PAGES)[number],
  parent: number | null
): Promise<[string, number]> => {
  const {
    docs: [existing],
  } = await payload.find({
    collection: "pages",
    draft: true,
    limit: 1,
    overrideAccess: true,
    where: { slug: { equals: page.slug } },
  });

  const data = { parent, slug: page.slug, title: page.title };

  const doc = existing
    ? await payload.update({
        collection: "pages",
        data,
        id: existing.id,
        overrideAccess: true,
      })
    : await payload.create({
        collection: "pages",
        data,
        draft: true,
        overrideAccess: true,
      });

  return [page.slug, doc.id];
};

export const seed = async (payload: Payload): Promise<void> => {
  // SAFETY: images.json is a list of DemoImage entries; JSON imports widen
  // the optional caption away, so TypeScript cannot check it itself.
  const demoImages = images as DemoImage[];

  const imageIds = new Map(
    await Promise.all(demoImages.map((image) => seedImage(payload, image)))
  );

  payload.logger.info(`Seeded ${imageIds.size} images`);

  // Page writes run one at a time: nested-docs rewrites children's breadcrumbs
  // when a parent saves, which races with a concurrent write to the child.
  // PAGES lists parents first, so each child finds its parent's id.
  const pageIds = new Map<string, number>();

  await inSequence(
    PAGES.map((page) => async () => {
      const parent =
        "parent" in page
          ? lookup<PageSlug>(pageIds, "page")(page.parent)
          : null;

      const [slug, id] = await seedPage(payload, page, parent);

      pageIds.set(slug, id);
    })
  );

  const pageId = lookup<PageSlug>(pageIds, "page");

  const content = layouts({
    image: lookup<ImageFile>(imageIds, "image"),
    page: pageId,
  });

  await inSequence(
    PAGES.map((page) => async () => {
      await payload.update({
        collection: "pages",
        data: { _status: "published", layout: content[page.slug] },
        id: pageId(page.slug),
        overrideAccess: true,
      });
    })
  );
  payload.logger.info(`Seeded ${PAGES.length} pages`);

  await payload.updateGlobal({
    data: { siteName: "Neighborhood Growers", tagline: "Grow food together" },
    overrideAccess: true,
    slug: "site-settings",
  });
  payload.logger.info("Seeded site settings");
};
