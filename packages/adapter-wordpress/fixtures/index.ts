import type { PageQueryResult } from "../src/types";
import getInvolved from "./get-involved.json" with { type: "json" };
import guide from "./guide.json" with { type: "json" };
import home from "./home.json" with { type: "json" };

// SAFETY: each file is a response to query.graphql, which is the shape
// `PageQueryResult` describes; home.json adds one layout the adapter does not
// know (to test that it is skipped). JSON imports widen each `__typename` to
// string, so TypeScript cannot check this itself.
export const wordpressHomeFixture = home as PageQueryResult;

// SAFETY: as above.
/** The starter guide: a free-form hero and rich-text blocks. */
export const wordpressGuideFixture = guide as PageQueryResult;

// SAFETY: as above.
/** Get involved: a split hero and a form section. */
export const wordpressGetInvolvedFixture = getInvolved as PageQueryResult;
