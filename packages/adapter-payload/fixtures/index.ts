import type { PayloadPage } from "../src/types";
import getInvolved from "./get-involved.json" with { type: "json" };
import guide from "./guide.json" with { type: "json" };
import home from "./home.json" with { type: "json" };

// SAFETY: each file is a page document as the Local API returns it at depth
// 1, which is the shape `PayloadPage` describes. JSON imports widen literal
// unions, so TypeScript cannot check this itself.
export const payloadHomeFixture = home as PayloadPage;

// SAFETY: as above.
/** The starter guide: a free-form hero and rich-text blocks. */
export const payloadGuideFixture = guide as PayloadPage;

// SAFETY: as above.
/** Get involved: a split hero and a form section. */
export const payloadGetInvolvedFixture = getInvolved as PayloadPage;
