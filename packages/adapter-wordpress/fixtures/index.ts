import type { PageQueryResult } from "../src/types";
import home from "./home.json" with { type: "json" };

// SAFETY: home.json is a recorded response to query.graphql, which is the
// shape `PageQueryResult` describes. JSON imports widen select arrays to
// string[], so TypeScript cannot check this itself.
export const wordpressHomeFixture = home as PageQueryResult;
