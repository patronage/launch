import type { PayloadRequest } from "payload";
import { describe, expect, it } from "vitest";

import { Pages } from "../collections/pages";
import { Posts } from "../collections/posts";
import { publishedUnlessSignedIn } from "./read-access";

const requestAs = (user: PayloadRequest["user"]) =>
  // SAFETY: the read rule looks only at `req.user`.
  // oxlint-disable-next-line anti-slop/no-chained-type-assertions -- a partial request.
  ({ req: { user } }) as unknown as Parameters<
    typeof publishedUnlessSignedIn
  >[0];

// SAFETY: a signed-in user needs only to be there for the read rule.
const EDITOR = {
  collection: "users",
  email: "editor@example.com",
  id: 1,
} as PayloadRequest["user"];

describe(publishedUnlessSignedIn, () => {
  it("limits an anonymous reader to published documents", () => {
    expect(publishedUnlessSignedIn(requestAs(null))).toStrictEqual({
      _status: { equals: "published" },
    });
  });

  it("lets a signed-in editor read every document, drafts included", () => {
    // A where query is truthy too, so only `true` itself will do.
    // oxlint-disable-next-line vitest/prefer-to-be-truthy -- see above.
    expect(publishedUnlessSignedIn(requestAs(EDITOR))).toBe(true);
  });
});

describe.each([Pages, Posts])("the $slug collection", (collection) => {
  it("uses the published-unless-signed-in read rule", () => {
    expect(collection.access?.read).toBe(publishedUnlessSignedIn);
  });
});
