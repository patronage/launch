import type { Access } from "payload";

/**
 * Read access for a collection with drafts: anonymous readers only see
 * published documents, and a signed-in editor sees every one.
 */
export const publishedUnlessSignedIn: Access = ({ req }) =>
  req.user ? true : { _status: { equals: "published" } };
