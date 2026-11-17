import type { EmDashEntryResponse } from "../src/types";
import getInvolved from "./get-involved.json" with { type: "json" };
import guide from "./guide.json" with { type: "json" };
import home from "./home.json" with { type: "json" };

// SAFETY: each file is the `data` of a `GET /_emdash/api/content/pages/{slug}`
// response from a local EmDash 1.5 seeded by apps/emdash, which is the
// shape `EmDashEntryResponse` describes. JSON imports widen literal types, so
// TypeScript cannot check this itself. Re-record them after a seed change:
// see packages/adapter-emdash/README.md.
export const emdashHomeFixture = home as EmDashEntryResponse;

// SAFETY: as above.
/** The starter guide: a free-form hero. */
export const emdashGuideFixture = guide as EmDashEntryResponse;

// SAFETY: as above.
/** Get involved: a split hero. */
export const emdashGetInvolvedFixture = getInvolved as EmDashEntryResponse;
