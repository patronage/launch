import { permanentRedirect, redirect } from "next/navigation";

import { getFrontendPayload } from "./payload";
import { fromCandidates, isSelfRedirect, redirectTarget } from "./redirects";
import { payloadAdapter } from "./sections";
import { siteOrigin } from "./seo";

/**
 * Sends the visitor on if an editor has redirected this path, and returns if
 * not. Routes call it just before notFound(), so a published page always wins
 * and normal page views cost no extra read. Redirects are read as an anonymous
 * visitor, even for a signed-in editor, so nobody is sent to a draft.
 */
export const followRedirect = async (path: string): Promise<void> => {
  const { payload } = await getFrontendPayload();

  const {
    docs: [match],
  } = await payload.find({
    collection: "redirects",
    depth: 1,
    limit: 1,
    overrideAccess: false,
    populate: {
      pages: { breadcrumbs: true, slug: true },
      posts: { slug: true },
    },
    sort: "from",
    user: null,
    where: { from: { in: fromCandidates(path) } },
  });

  const target = match && redirectTarget(match, payloadAdapter.pagePath);

  if (!target || isSelfRedirect(target, path, await siteOrigin())) {
    return;
  }

  if (match.type === "308") {
    permanentRedirect(target);
  }

  redirect(target);
};
