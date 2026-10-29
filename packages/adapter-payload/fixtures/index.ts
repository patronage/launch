import type { PayloadPage } from "../src/types";
import home from "./home.json" with { type: "json" };

// SAFETY: home.json is a page document as the Local API returns it at depth 1,
// which is the shape `PayloadPage` describes. JSON imports widen literal
// unions, so TypeScript cannot check this itself.
export const payloadHomeFixture = home as PayloadPage;
