/**
 * The site's one rule EmDash can't express in a schema: a news story is
 * published or scheduled with exactly one category. Its category is the
 * story's primary category, which cards and the post page show and whose
 * image stands in when the story has none. Drafts can be saved without one,
 * because EmDash assigns terms apart from the save.
 *
 * EmDash 1.6 runs no hook when terms change on a story that is already live,
 * so an editor can still remove its category or add a second until the next
 * publish. The front end copes: it shows the first category by label, and a
 * story with none shows no category and no stand-in image.
 *
 * astro.config.mjs registers it with `newsRules()`; EmDash imports
 * `createPlugin` from this file at build time.
 */
import type {
  ContentPolicyDecision,
  ContentPolicyEvent,
  PluginCapability,
  PluginContext,
  PluginDescriptor,
  ResolvedPlugin,
} from "emdash";
import { definePlugin } from "emdash";

const ID = "launch-news-rules";
const VERSION = "1.0.0";

const CAPABILITIES: PluginCapability[] = [
  "hooks.content-policy:register",
  "taxonomies:read",
];

/** Why a story with no category, or several, can't go live. */
export const categoryRuleReason = (count: number): string | undefined => {
  if (count === 1) {
    return undefined;
  }

  return count === 0
    ? "Choose a category for this story before publishing it."
    : "A story takes one category. Remove all but one before publishing it.";
};

const checkCategory = async (
  event: ContentPolicyEvent,
  ctx: PluginContext
): Promise<ContentPolicyDecision> => {
  const { id } = event.content;

  if (event.collection !== "news" || !id) {
    return undefined;
  }

  // Declared above, so EmDash always grants it; refuse rather than let a story
  // through unchecked if it ever doesn't.
  if (!ctx.taxonomies) {
    return { cancel: true, reason: "The category check is unavailable." };
  }

  const terms = await ctx.taxonomies.getEntryTerms("news", String(id), {
    taxonomy: "category",
  });

  const reason = categoryRuleReason(terms.length);

  return reason ? { cancel: true, reason } : undefined;
};

export const createPlugin = (): ResolvedPlugin =>
  definePlugin({
    capabilities: CAPABILITIES,
    hooks: {
      "content:beforePublish": checkCategory,
      "content:beforeSchedule": checkCategory,
    },
    id: ID,
    version: VERSION,
  });

/** The descriptor for astro.config.mjs's `plugins`. */
export const newsRules = (): PluginDescriptor => ({
  capabilities: CAPABILITIES,
  description: "Publishes a news story only with exactly one category.",
  displayName: "News rules",
  entrypoint: new URL(import.meta.url).pathname,
  format: "native",
  id: ID,
  version: VERSION,
});
